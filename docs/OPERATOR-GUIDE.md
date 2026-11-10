# Operator guide — running an `orng.wax` signing member

This guide takes a WAX block producer from a fresh account to a running member of the
`orng.wax` 2-of-3 threshold-RSA oracle: a member that passes the boot self-check, signs
partials, combines, and claims its stipend. It is written against `wax-rng-oracle` **7.3.0**,
contract `orng.wax` **v3.4.0** and signing library `@waxio/rsa-threshold-signatures` **2.0.0**.
Every action, table and variable named here exists in that code.

Placeholders are in angle brackets. Nothing in this document is a real key or share.

## Overview

- A dApp calls `orng.wax::requestrand`; the contract stores a `reqs` row (`id`, `dapp`, `seed`,
  `nonce`, key version `ver`, empty `parts`).
- Each member polls `reqs`, signs `sha256(seed || dapp || nonce)` with its RSA key **share** and
  pushes `submitpart`. The contract stamps the member's on-chain `oracle_index` on the partial.
- Once `threshold` (2) partials are on chain, every member combines them into one standard RSA
  signature and pushes `setrand`. The contract verifies it against the active `pubkeys` row,
  derives the random value and delivers it. First valid `setrand` wins; the rest get "no request found".
- If delivery fails, the member pushes `markfailed`; the result waits in `undelivered1` for
  `retrydeliver` / the dApp's `getresult`, and `cleanup` expires stale rows.
- A **bad full signature** (`setrand` / `markfailed`) earns the member a strike. At
  `strikesmax` strikes the member is suspended and stops earning.
- Members earn a share of per-call fees (`balances`) plus a USD-denominated stipend
  (`ostip.a`), both paid out by `claim`.

## Who runs what

- **Producers** hold `orng.wax`: its `owner` and `active` are the producer multisig
  (`eosio.prods`). Membership (`setoracles`), key versions (`setpubkey`, `retirepubkey`),
  un-suspension (`resetsuspen`) and economics (`configv2`, `configv3`, `setstipend`) all
  `require_auth(orng.wax)` and are therefore proposed and executed through `eosio.msig`.
  **A member cannot register itself.** See the governance runbook.
- **The ceremony operator** (appointed by the producers) runs the trusted-dealer key
  ceremony with the library's Shoup-scheme dealer. One run produces the public key and all N
  shares; there is no distributed key generation and no resharing. Shares reach members
  wrapped to a public key each member supplies. See the key ceremony runbook.
- **You, the member operator**, own one WAX account, one key share, one host, and the
  process described here.

## Prerequisites

- A WAX account you control (`<member>` below), with its `active` key available for the
  one-time permission setup.
- A host with **Node.js 20**. The signing path is not constant-time (V8 `BigInt`); do not run
  it on a shared host where a co-tenant can time it.
- A reliable WAX API node (`<api-url>`): the process polls `reqs` several times a second and
  pushes transactions. Run your own node or contract one you trust; a lagging or lying node can
  only make the member stop or refuse to start, never sign under a wrong key, but it costs requests.
- WAX mainnet chain id: `1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4`.
- `cleos` (or any Antelope CLI) for the account steps.
- `git`, `npm`.

### Hardware

A member is one Node.js process and the work per request is small: read the `reqs` row, compute
one 4096-bit RSA partial signature, push `submitpart`; later combine and verify the parts locally
before `setrand`. The rest is polling (`reqs` every 300 ms, the execute queue every second,
retries every 5 s), about five small HTTP calls a second to your API node whether or not there is
traffic.

Measured with the signing library's own 4096-bit 2-of-3 test key (`@waxio/rsa-threshold-signatures`
2.0.1, Node 24) on one fast desktop core; a typical cloud vCPU is two to three times slower:

| Step | Cost | When |
|---|---|---|
| Partial signature | ~200 ms CPU | once per request |
| Local combine + verify | ~30 ms CPU | once per request |
| Share self-check | ~400 ms CPU | once, at boot |
| Resident memory | ~80 MB idle, under 200 MB in service | always |
| Checkout + dependencies | ~190 MB | once |

Signing is serial inside the process, so one process saturates at about one request per signing
time: 2–5 requests/s, or 170k–400k a day, on one vCPU. Mainnet ran 4k–10k requests a day in
October–November 2026 (peaks near 0.1/s), so a single process is a few percent loaded.

| | Minimum | Recommended |
|---|---|---|
| CPU | 1 vCPU, x86-64 or arm64 | 2 vCPU, a class that is not credit-throttled |
| Memory | 1 GB | 2 GB |
| Disk | 10 GB | 20 GB SSD |
| Network | stable path to your API node | API node in the same region or LAN |

- **CPU**: single-core speed matters, core count beyond two does not. Avoid burstable classes that
  throttle once credits run out: a member that signs late simply misses requests (another member's
  part completes the 2-of-3), earning no fee for them and alarming nobody.
- **Memory**: the process needs well under 200 MB; the rest is the OS and headroom. Do not set a
  `MemoryMax` tighter than 512 MB on the unit.
- **Disk**: the application is ~190 MB installed. `DB_FILE` stays at a few kilobytes (it holds only
  back-off state and clears itself). Logs go to stdout, so size the disk for the OS and the journal,
  not the app; `LOGGER_LEVEL=info` writes a few MB a day.
- **Network**: about five ~1 KB requests a second, around 10 GB a month. Latency and reliability to
  the API node are what matter, bandwidth is not.
- **Cluster mode**: leave `CLUSTER_MODE=false`. One worker per CPU buys nothing below roughly one
  request per second sustained and has the working-directory caveat in section 3.
- **Dedicated host**: the signing path is not constant-time (above), so a VM or bare-metal host you
  control, not a container on a host shared with tenants you do not.
- **Redundancy**: two live processes on the same share index, on separate hosts, is the designed
  per-member redundancy. The contract keeps the first partial and the process treats the second's
  `duplicate part` as a known collision, so it is a race, not a fault (section 6.6). A warm standby
  is `READONLY_MODE=true` (section 3).

## 1. Account and permissions

### 1.1 Create a dedicated signing permission

The process holds one WAX private key in memory and signs with it as `<member>@<permission>`.
Do not give it your `active` key. Create a custom permission (`rngops` is the recommended name,
the process default is `active` — set `EOS_ORNG_AUTH_PERMISSION=rngops`) holding a key generated
for this purpose only:

```bash
cleos -u <api-url> set account permission <member> rngops <RNGOPS_PUBLIC_KEY> active -p <member>@active
```

### 1.2 Link it to exactly the actions the process pushes

`lib/config/eos.js` pushes five `orng.wax` actions with the member's authority:
`submitpart`, `setrand`, `markfailed`, `retrydeliver`, `cleanup`. Link all five and nothing else:

```bash
for a in submitpart setrand markfailed retrydeliver cleanup; do
  cleos -u <api-url> set action permission <member> orng.wax $a rngops -p <member>@active
done
```

`claim` is never pushed by the process; leave it on `active` and claim by hand (section 6.3).

### 1.3 Resources

- **CPU / NET**: the member pays for its own transactions — up to one `submitpart` per request,
  plus `setrand` for the requests it wins, `markfailed` / `retrydeliver` on delivery failures,
  and one `cleanup` a day. Stake CPU and NET on `<member>` accordingly and watch for
  `tx_cpu_usage_exceeded` in the logs. `EOS_ORNG_MAX_CPU` (ms, default `100`) caps what one
  transaction may bill. Measure on testnet before mainnet.
- **RAM**: the contract pays. `submitpart` rewrites the `reqs` row and `markfailed` writes
  `undelivered1` with `orng.wax` as payer; the dApp pays for the `reqs` row itself. Your
  account only needs the few hundred bytes the permission and links above consume.

### 1.4 Get registered

Give the producers your account name. `setoracles(name[])` replaces the whole member set; your
**`oracle_index` is your 1-based position in that array**, and the call resets every member's
strikes and suspension and creates/refreshes each member's `ostip.a` row. You need that index
in section 2 — read it back:

```bash
cleos -u <api-url> get table orng.wax orng.wax oracles.a
```

## 2. Get your share

### 2.1 Hand the ceremony operator a wrapping key

Shares are wrapped with the library's `KeyEncryption` helper: ECDH on secp256k1 plus
AES-256-GCM. Generate a **fresh** secp256k1 key pair for this (not your WAX account key), keep
the private half offline, and send the public point as hex (65-byte uncompressed `04…`, which
is what the library tests use; 33-byte compressed is also accepted):

```bash
npm install secp256k1          # on an offline machine
node -e '
const secp = require("secp256k1"), crypto = require("crypto");
let priv; do { priv = crypto.randomBytes(32); } while (!secp.privateKeyVerify(priv));
require("fs").writeFileSync("wrap.key", priv.toString("hex"), { mode: 0o600 });
console.log(Buffer.from(secp.publicKeyCreate(priv, false)).toString("hex"));'
```

### 2.2 What comes back

From the ceremony you receive, per the key ceremony runbook:

- your wrapped share: one string `<ciphertext>:<iv>:<authTag>` (three hex fields, colon
  separated — two fields is the old unauthenticated format and is rejected);
- the dealer's secp256k1 public key (hex), needed to unwrap;
- your share index `i` (must equal your `oracle_index`);
- the public parameters: `n`, `e`, `v`, `u`, your `v_i`, plus `bits`, `threshold`, `numParties`.

Unwrap on the same offline machine:

```bash
npm install @waxio/rsa-threshold-signatures secp256k1
node -e '
const { KeyEncryption } = require("@waxio/rsa-threshold-signatures/dist/key-encryption");
const fs = require("fs");
const kx = new KeyEncryption(Buffer.from(fs.readFileSync("wrap.key","utf8").trim(),"hex"),
                             Buffer.from("<DEALER_SECP256K1_PUBLIC_HEX>","hex"));
fs.writeFileSync("share.hex", kx.decrypt("<WRAPPED_SHARE>"), { mode: 0o600 });'
```

### 2.3 Map the dealer output to configuration

The dealer (`script/generateKey.ts`) emits one JSON object; the ceremony operator gives you
your slice of it. The mapping to the process's environment is fixed:

| Dealer field                              | Environment variable                 |
| ----------------------------------------- | ------------------------------------ |
| `publicKey.n`                             | `SHARE_KEY_PUBLIC_KEY_N`             |
| `publicKey.e`                             | `SHARE_KEY_PUBLIC_KEY_E`             |
| `sharedKey.shares[i-1]` (your share)      | `SHARE_KEY_PRIVATE_KEY_HEX`          |
| `sharedKey.v`                             | `SHARE_KEY_VERIFICATION_KEY`         |
| `sharedKey.verificationKeys[i-1]`         | `SHARE_KEY_VERIFICATION_KEY_SHARE`   |
| `sharedKey.vku`                           | `SHARE_KEY_VKU`                      |
| `bits` / `threshold` / `numParties`       | `SHARE_KEY_BITS` / `SHARE_KEY_THRESHOLD` / `SHARE_KEY_NUM_PARTIES` |
| your index `i`                            | `SHARE_KEY_SHARE_INDEX`              |

All values are hex strings (`e` included: `10001` is 65537). `n` must be lower-case with no
leading zero and must match the on-chain `modulus` byte for byte.

### 2.4 Fingerprint the public key

The fingerprint is `sha256` of the lower-case hex modulus. Compute it from what you were
given and from the chain; both must equal the fingerprint the ceremony recorded:

```bash
printf '%s' "<n from the ceremony>" | sha256sum
cleos -u <api-url> get table orng.wax orng.wax config.a --lower activever --upper activever   # -> value = <ver>
cleos -u <api-url> get table orng.wax orng.wax pubkeys --lower <ver> --upper <ver> \
  | jq -r '.rows[0].modulus' | tr -d '\n' | sha256sum
```

If they differ, stop and go back to the ceremony operator. The boot self-check will refuse to
start anyway, but find out now.

## 3. Configure

The process reads `config/default.json`, then `config/<NODE_ENV>.json` if present, then the
environment variables in `config/custom-environment-variables.json` (full list in Appendix A).
A `.env` file in the working directory is loaded too (`dotenv`).

Minimal mainnet member:

```bash
NODE_ENV=production
EOS_CHAIN_ID=1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4
EOS_API_URL=<api-url>
EOS_ORNG_CONTRACT_NAME=orng.wax
EOS_ORNG_NODE_OWNER=<member>
EOS_ORNG_AUTH_PERMISSION=rngops
EOS_ORNG_PRIVATE_KEY=<rngops private key>
SHARE_KEY_THRESHOLD=2
SHARE_KEY_NUM_PARTIES=3
SHARE_KEY_BITS=4096
SHARE_KEY_SHARE_INDEX=<i>
SHARE_KEY_PUBLIC_KEY_N=<n>
SHARE_KEY_PUBLIC_KEY_E=10001
SHARE_KEY_PRIVATE_KEY_HEX=<your share>
SHARE_KEY_VERIFICATION_KEY=<v>
SHARE_KEY_VERIFICATION_KEY_SHARE=<v_i>
SHARE_KEY_VKU=<u>
DB_FILE=/var/lib/wax-rng-oracle/db.json
LOGGER_LEVEL=info
EXPRESS_APP_PORT=3000
SLACK_WEBHOOK=<optional incoming-webhook URL>
```

Before the ceremony, set the four numeric `SHARE_KEY_*` variables now (`THRESHOLD`,
`NUM_PARTIES`, `BITS`, `SHARE_INDEX`: your index is the position governance will give you) and
leave the six key values (`PUBLIC_KEY_N`, `PUBLIC_KEY_E`, `PRIVATE_KEY_HEX`, `VERIFICATION_KEY`,
`VERIFICATION_KEY_SHARE`, `VKU`) **unset**, not empty: an empty environment variable is ignored
and the default (share index 1) would silently apply. Then run the dry run in section 4.

Notes:

- `NODE_ENV=test` is refused (it selects the test fixture share); `production` needs no
  `config/production.json`. The defaults for `EOS_CHAIN_ID` and `EOS_ORNG_NODE_OWNER` are a dev
  chain and `orng.wax` — always set both.
- Booleans (`READONLY_MODE`, `CLUSTER_MODE`, `EXPRESS_APP_ENABLE`) are true unless the string is
  exactly `false`, `0`, `null` or `undefined`. Use `true` / `false`.
- The HTTP API listens on all interfaces: firewall `EXPRESS_APP_PORT` or set
  `EXPRESS_APP_ENABLE=false` (you lose `/health-check`).
- `CLUSTER_MODE=true` forks one worker per CPU (each boot-checks and polls a slice of request
  ids). Workers write `db-<n>.json` into the **working directory**, so it is incompatible with the
  unit in section 4 as written (`ProtectSystem=strict` makes `/opt/wax-rng-oracle` read-only); if
  you need it, set `WorkingDirectory=/var/lib/wax-rng-oracle`. Start with `false`.
  `READONLY_MODE=true` serves the API only and signs nothing (a boot-checked warm standby, 6.6).

### 3.1 Custody

Two secrets exist: the key share (`SHARE_KEY_PRIVATE_KEY_HEX`) and the signing key
(`EOS_ORNG_PRIVATE_KEY`). Everything else in the configuration is public.

- Baseline: a plain environment file owned by root, mode `0600`, handed to the process by the
  supervisor (`EnvironmentFile=` below). The service user does not need to read it.
- Any secret manager that injects environment variables works unchanged.
- Optional: with the `@waxio/wax-config` package installed, `SECRETS_MANAGER_SECRET_ID`,
  `ENCRYPTED_KEYS` and `DECRYPTION_ENVIRONMENTS` pull the listed config paths from AWS
  Secrets Manager using the host's IAM role. Setting any of them without the package installed
  makes the process refuse to boot rather than run on placeholders. This is not the default.
- Never log either secret. The process logs check names, indices, key versions and partial
  signatures (which are public once on chain) but never a share; library parse errors are
  redacted before they reach a log line.
- Keep `wrap.key` and `share.hex` off the member host once the environment file exists; the
  wrapped share plus `wrap.key` is your backup.

## 4. Run

```bash
git clone https://github.com/worldwide-asset-exchange/wax-rng-oracle.git /opt/wax-rng-oracle
cd /opt/wax-rng-oracle && git checkout 7.2.1
npm ci --ignore-scripts
npm run check:deps          # refuses a tree with node-forge < 1.4.0 or the signing library < 2.0.0
npm run check:config        # dry run: validates the host, the account and the chain, starts nothing
NODE_ENV=production node index.js
```

**Dry run first.** `npm run check:config` (same as `node index.js --check-config`) checks what
can be checked without a share: `NODE_ENV`,
the shape of every variable, that `EOS_ORNG_PRIVATE_KEY` parses and its public key is on
`<member>@<permission>` on chain, that the API node is reachable, synced and on the configured
chain id, that `orng.wax` has an active key (it prints the fingerprint from section 2.4), whether
`<member>` is in `oracles.a` and with which index, the account's CPU/NET headroom, and that
`DB_FILE` is writable. With `SHARE_KEY_*` staged it also runs the share consistency check the boot
self-check runs. It starts no poller and no HTTP API, pushes no transaction and prints no secret.
Exit 0 means nothing it saw would stop the service; `FAIL` lines would. Two `WARNING: NODE_ENV
value of 'production' did not match …` lines on stderr are expected (there is no
`config/production.json` by design; the service prints them too); the report is on stdout. Before the ceremony,
`share.configured` is `skip` and `chain.oracleRow` is `warn` (not registered yet): that is the
expected result of a ready host. `READONLY_MODE=true` is **not** a way to test earlier: the boot
self-check runs before that switch is read and exits without a share.

The dry run reads the shell environment and a `.env` in the working directory, not the unit's
`EnvironmentFile`, and it probes `DB_FILE` as the user running it (it warns when that is root).
Once the unit below is installed, run it exactly as the service would run, same user, same
environment file, same sandbox:

```bash
systemd-run --pipe --wait --collect -p User=rng-oracle -p WorkingDirectory=/opt/wax-rng-oracle \
  -p EnvironmentFile=/etc/wax-rng-oracle/member.env -p ProtectSystem=strict \
  -p ReadWritePaths=/var/lib/wax-rng-oracle -E NODE_ENV=production \
  /usr/bin/node index.js --check-config
```

Since 7.2.1 every dependency is on the public npm registry and pinned in the lockfile, so
`npm ci` installs the exact tree. The `check:deps` line is the integrity check that matters.

`Dockerfile_eks` builds the same tree into a container image (`docker build -f Dockerfile_eks .`);
it refuses a lockfile that resolves anything outside the public registry.

systemd unit, non-root user, restart on any exit (the process exits 1 on every fatal condition
on purpose, so `Restart=always` is what makes a mis-keyed member visible as a crash loop):

```ini
# /etc/systemd/system/wax-rng-oracle.service
[Unit]
Description=WAX ORNG signing member (<member>)
After=network-online.target
Wants=network-online.target

[Service]
User=rng-oracle
Group=rng-oracle
WorkingDirectory=/opt/wax-rng-oracle
EnvironmentFile=/etc/wax-rng-oracle/member.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
StateDirectory=wax-rng-oracle
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/wax-rng-oracle

[Install]
WantedBy=multi-user.target
```

```bash
install -o root -g root -m 0600 member.env /etc/wax-rng-oracle/member.env
systemctl daemon-reload && systemctl enable --now wax-rng-oracle
journalctl -u wax-rng-oracle -f
```

## 5. Verify

0. **Dry run clean.** `npm run check:config` exits 0 with no `FAIL` line (section 4). After the
   ceremony and `setoracles`, `share.consistent` and `chain.oracleRow` must both be `ok`.
1. **Boot self-check passed.** The first lines must include `Boot self-check passed: <member>
   share index <i> is consistent with on-chain pubkeys[<ver>] (4096-bit modulus) and oracles.a`,
   then `Application: Worker <pid> started`. The check reads `config.a[activever]` → `pubkeys[ver]`
   (must exist, not retired) and your `oracles.a` row, requires `oracle_index ==
   SHARE_KEY_SHARE_INDEX`, and verifies the share against the on-chain modulus and exponent. Any
   failure logs `Boot self-check FAILED: … Refusing to start.` and exits 1.
2. **Health endpoint.** `curl -s localhost:3000/health-check` returns HTTP 200 and
   `{"healthy":true,"eos":true,"bootCheck":{"ran":true,"ok":true,"rpcReachable":true,
   "activeKeyFound":true,"oracleIndexMatches":true,"shareConsistent":true,"activeVer":<ver>}}`;
   500 whenever the RPC is down or the boot check did not pass (what it does and does not prove:
   6.4). `/version` returns `{"version":"<the tag you checked out>"}`.
3. **Signing.** Within a minute of a request, `cleos get table orng.wax orng.wax reqs` shows your
   index in a row's `parts`; the log shows `Submitting partial signature for request <id>` and
   `Process job. Success: 1, Fail: 0`. Winning a combine logs `Execute job. Success: 1, Fail: 0`.
4. **Strikes.** `oracles.a` still shows `strikes: 0, suspended: 0` for you after a day of traffic.

## 6. Operate

### 6.1 Upgrades

Upgrade **one member at a time**: stop, `git checkout <tag>`, `npm ci --ignore-scripts`,
`npm run check:deps`, start, confirm `bootCheck.ok` is `true` and partials are being submitted,
then move to the next member. Two members down at once is no 2-of-3 quorum: the RNG stalls.

### 6.2 Key rotation

A member signs only the key version the boot self-check verified (`activeVer`). When the
producers execute `setpubkey(<ver+1>, e, n)` it activates immediately: new requests carry
`ver+1`, running members log
`Request <id> carries key version <ver+1> but this member verified its share against version <ver>
— skipping every request of that version until restarted and re-checked` once and count
`key_version_skipped`. So a rotation is: new ceremony (section 2) → every member installs its new
share → `setpubkey` → every member restarts. Restarted members skip any request still carrying the
old version; those need governance attention (`killjobs`), and `retirepubkey(<ver>)` closes the old
key afterwards. Coordinate the timing with the governance runbook so the gap is minutes, not hours.

### 6.3 Strikes, suspension, claims

- Only an invalid **full** signature strikes you (`setrand` / `markfailed` that fails RSA
  verification — the action still succeeds, so watch `oracles.a.strikes`, not your logs). A bad
  partial from any member is screened out by the combiner and does not strike anyone.
- At `strikes` ≥ `config.a[strikesmax]` you are `suspended`: `submitpart`, `setrand`,
  `markfailed` and `cleanup` fail with `oracle suspended`, fee splits skip you, and stipend accrual
  stops. Reinstatement is `resetsuspen(<member>)` by the producer msig. Mainnet `strikesmax` is 3
  (read `config.a` to confirm; if the row were ever unset, the first bad signature would suspend).
- `claim` pays your unpaid fee share in full plus your accrued stipend (converted from USD at the
  Delphi `waxpusd` price, capped by the treasury balance). It needs your `ostip.a` row, at least
  `config.a[minclaimint]` seconds (default 86 400) since your last claim, and something to claim:

```bash
cleos -u <api-url> get table orng.wax orng.wax ostip.a --lower <member> --upper <member>
cleos -u <api-url> get table orng.wax orng.wax balances --lower <member> --upper <member>
cleos -u <api-url> push action orng.wax claim '["<member>"]' -p <member>@active
```

- `cleanup` runs from the process once a day (batch 10) and is also folded into every
  `setrand` / `markfailed`; you do not need to push it by hand.

### 6.4 Monitoring

**HTTP endpoints** (`EXPRESS_APP_PORT`, default 3000; the server listens on all interfaces, so
firewall the port or put it behind a reverse proxy that does the access control):

| Path | Returns | Status |
| --- | --- | --- |
| `/health-check` | `{"healthy","eos","bootCheck":{"ran","ok","rpcReachable","activeKeyFound","oracleIndexMatches","shareConsistent","activeVer"}}` — booleans and the key version, never key material | 200 when `eos` and `bootCheck.ok` are both true, else 500 |
| `/version` | `{"version":"X.Y.Z"}` from `package.json` | 200 |
| `/jobs`, `/jobs/<id>` | this process's own back-off / parking state (`DB_FILE`), not the chain | 200 |

`/health-check` is a liveness check: the process is up, its API node answers `get_info` right now,
and the share matched the on-chain key **when the process booted**. It proves nothing about
signing. A member whose `rngops` key was changed after boot, whose node is minutes behind head, or
that is losing every race to its twin (6.6) still returns 200. Signing health is only visible on
chain (below). Use the endpoint for the unit's restart logic and the standby test, not as the only
alarm.

StatsD metrics (`METRICS_HOST:METRICS_PORT`, prefix `METRICS_PREFIX`, default `wax-rng-oracle`):

| Metric | Type | Meaning |
| --- | --- | --- |
| `set_rand_heart_beat`, `execute_heart_beat`, `retry_deliver_heart_beat`, `cleanup_heart_beat` | gauge | each poll loop is alive |
| `seeds_to_be_send_loaded`, `seeds_to_execute_loaded`, `undelivered_jobs_loaded`, `seeds_pending` | gauge | queue depths seen on chain |
| `seeds_sent`, `set_part_failed`, `job_collision` (tag `contract`) | counter | partials submitted / failed / already on chain from your other instance (6.6) |
| `executed_job`, `execute_failed`, `markfail_failed` (tag `contract`) | counter | combines delivered / failed / `markfailed` itself failed |
| `combine_failed` (tags `contract`, `code`) | counter | parts on chain did not combine; `code` is the library's `CombineError` code |
| `combine_rejected_part`, `combine_suspect_share` (tags `contract`, `idx`) | counter | a specific member's partial was malformed / only in failing subsets — `idx` names the suspect |
| `key_version_skipped` (tag `ver`) | counter | requests under a key version this member did not verify |
| `retry_deliver_success`, `retry_deliver_failed` (tag `dapp`), `cleanup_success`, `cleanup_failed` | counter | delivery retries and cleanup |
| `eos.response_time.get_seeds_to_be_send`, `…get_job_to_execute`, `…get_undelivered_to_retry` | timing | RPC latency |

**Host-side alerts** (from the metrics and the endpoint): any heart-beat gauge stale for a minute;
`/health-check` not 200; `combine_suspect_share` with your own `idx`; `key_version_skipped` > 0;
`seeds_pending` ≥ `JOB_PENDING_ALERT_MAX_JOB_PENDING`; the unit restarting more than a few times
an hour (`systemctl show -p NRestarts wax-rng-oracle`).

**Chain-side checks** are the only ones that prove you are signing. Run them from outside the
host, against a history API or your own node, on a schedule:

- Your `submitpart` count over the last hour is close to the number of `requestrand` on `orng.wax`
  in the same hour. On a Hyperion-style history API:
  `/v2/history/get_actions?account=orng.wax&filter=orng.wax:submitpart&act.authorization.actor=<member>&after=<iso-time>&limit=1`
  and read `total.value`. A flat count while the contract is busy means you are not signing,
  whatever `/health-check` says.
- `cleos get table orng.wax orng.wax reqs` is near empty most of the time. Rows older than a minute
  mean fewer than two members are signing — a service problem, not only yours.
- `oracles.a` shows `strikes: 0, suspended: false` for you (6.3).
- Running active-active: `job_collision` on each instance stays near half the request rate. It
  dropping to zero on one instance means the other one is dead (6.6).

With `SLACK_WEBHOOK` set the process posts `RNG poller ERROR` (a `submitpart` failed), `RNG poller
execute ERROR`, `RNG poller markfailed ERROR`, `RNG poller combine ERROR` (throttled to one a minute
with a suppressed count), `RNG retry deliver ERROR`, `RNG cleanup ERROR` and `RNG poller ALERT`
(pending requests over the threshold). Log lines worth a rule: `Boot self-check FAILED`,
`Refusing to start`, `Oracle <member> is suspended`, `Oracle <member> is unknown`,
`Contract is paused`, `combine failed (`, `carries key version`, `Unhandled Exception`, `worker … died`.

### 6.5 Retry and parking behaviour

- A `submitpart` rejected with `no request found`, `duplicate part`, `version mismatch`,
  `deadline exceeded` or `paused` is logged and dropped; the next poll re-reads the chain.
- A combine the library rejects (`CombineError`) is **parked** under a fingerprint of the parts it
  failed on and not retried until the on-chain parts change. Any other execute or delivery failure
  backs off from 500 ms, doubling, up to `2^JOB_RETRY_MAX_RETRIES × 500 ms` (default 4 s), then
  stops. Entries clear once the row leaves the chain. `DB_FILE` holds only this back-off state.

### 6.6 Redundancy

The service survives one member being down (2-of-3), so nothing is lost while you fix a host. For
your own member, pick one of three models:

| Model | What runs | Cost | Failover |
| --- | --- | --- | --- |
| **Restart only** | one live process under `Restart=always` (section 4) | none | automatic for a crash; none for a dead host |
| **Active-active** (the design) | two live processes with the same share and index, on separate hosts | one rejected transaction per request from the loser | none needed; fix the dead one |
| **Warm standby** | one live, one `READONLY_MODE=true` | none | by hand: stop the primary, flip the flag, restart |

**Active-active is a race, not a fault.** Both instances poll `reqs`, both compute the partial, both
push `submitpart`. The contract stores the first and rejects the second with `duplicate part`; the
process logs `Job <id> is already processed`, counts `job_collision`, and drops it — no retry, no
Slack alert, no `markfailed`. The same happens on `setrand` (`no request found` once the twin has
delivered). A duplicate never strikes you: strikes are for invalid full signatures only (6.3). The
rejected transaction is refused by the API node and never reaches the chain, so it is not billed
to your account. Requirements:

- Separate hosts and separate `DB_FILE`s. The back-off state is per process; never share one file.
- Identical `SHARE_KEY_*`, `SHARE_KEY_SHARE_INDEX`, `EOS_ORNG_NODE_OWNER` and signing key. The two
  instances may use the same API node or different ones.
- Subjective billing. nodeos does not bill API-pushed rejections to the account by default
  (`disable-subjective-api-billing = true`). If a node you push through has that set to `false`,
  thousands of `duplicate part` rejections a day accumulate against `<member>` on that node and
  both instances stall there with `tx_cpu_usage_exceeded` while the chain shows CPU to spare. Add
  `disable-subjective-account-billing = <member>` to that node's `config.ini`, or push through a
  node with the default. Do not run active-active through a public API node you do not control.
- Expect `job_collision` at roughly half the request rate on each instance.

**Warm standby** boots fully (share self-check against the chain included), serves `/health-check`
and signs nothing. Keep its environment identical except `READONLY_MODE=true`, restart it after
every key rotation (6.2) so its boot check re-verifies the new share, and promote it by flipping the
flag and restarting. Stopping the primary first avoids the collision cost; it is safe either way.

**Cluster mode** (`CLUSTER_MODE=true`) is not redundancy: it shards request ids across workers in
one process on one host, and one worker dying takes the whole process down by design.

## 7. Troubleshooting

Boot self-check codes appear in `Refusing to start: boot self-check failed (<code>)`.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `RPC_UNREACHABLE` | `EOS_API_URL` down or wrong for the whole retry budget (default 6 attempts, ≈ 1 min) | fix the URL / node; raise `BOOT_CHECK_RPC_RETRIES` on slow starts |
| `ACTIVE_VERSION_MISSING`, `ACTIVE_KEY_MISSING` | `config.a[activever]` / `pubkeys[ver]` not visible — node replaying, or contract not yet keyed | wait or point at a synced node; check `config.a` yourself |
| `ACTIVE_VERSION_INVALID`, `ACTIVE_KEY_MALFORMED`, `ORACLE_INDEX_MALFORMED`, `ACTIVE_KEY_RETIRED` | chain row present but unusable / active key retired | governance issue; report it, wait for the next `setpubkey`, re-key |
| `ORACLE_NOT_REGISTERED` | `<member>` not in `oracles.a` (or `EOS_ORNG_NODE_OWNER` wrong) | check the variable; ask governance for `setoracles` |
| `ORACLE_INDEX_MISMATCH` | `SHARE_KEY_SHARE_INDEX` ≠ your `oracle_index` | set the variable to the on-chain index; make sure the share you hold is for that index |
| `SHARE_CONFIG_UNPARSEABLE` | a `SHARE_KEY_*` value or the on-chain modulus is not hex | re-copy the values; check for `0x`, whitespace, truncation |
| any `FAIL` line from `npm run check:config` | the named variable, key, permission, node or path is wrong | the line says which; fix it and re-run before starting the service |
| `expectedPublicKey` | your `n`/`e` differ from `pubkeys[ver]` | compare fingerprints (2.4); you may hold a share of a previous key |
| `verificationKeyShare`, `shareIndex` | share does not bind to `v_i` / wrong index for this share | wrong slice of the dealer output; go back to the ceremony operator |
| `modulusBits`, `sharedKeyRange`, `verificationKeyRange`, `verificationKeyShareRange`, `vkuRange`, `vkuJacobi`, `exponentPrime`, `exponentAboveParties`, `thresholdRange`, `shareIndexRange` | a parameter is out of range or `SHARE_KEY_BITS` / `_THRESHOLD` / `_NUM_PARTIES` are wrong | check the three numeric variables first |
| `NODE_ENV=test is reserved…` | `NODE_ENV=test` | use `production` |
| `Missing required field: <name>` / `shareIndex (…) cannot exceed numParties` | a `SHARE_KEY_*` variable is empty or the index is too large | fill it in |
| `configLoader: this deployment expects @waxio/wax-config` | `SECRETS_MANAGER_SECRET_ID` / `ENCRYPTED_KEYS` set without the package | unset them or install the package |
| `Oracle <member> is unknown` at runtime | removed by a later `setoracles` | ask governance |
| `Oracle <member> is suspended` | strikes reached `strikesmax` | find the cause (bad share? wrong key version?) then request `resetsuspen` |
| `missing required authority` / `transaction declares authority` on push | `rngops` not linked to that action, or `EOS_ORNG_PRIVATE_KEY` is not the `rngops` key | redo 1.1–1.2 |
| `tx_cpu_usage_exceeded`, `billed CPU time … greater than` | not enough CPU staked, or `EOS_ORNG_MAX_CPU` too low | stake more / raise the cap |
| `tx_cpu_usage_exceeded` from one node only, `get_account` shows CPU to spare, two live instances | that node subjectively bills the loser's rejected transactions (6.6) | `disable-subjective-account-billing = <member>` on that node, or push through a node with the default |
| `combine failed (NO_VALID_SUBSET) … rejected parts [<idx>@…]` | another member's partial is bad | nothing on your side; the suspect `idx` is in the log and metric |
| `combine_suspect_share` with **your** `idx` | your share no longer matches the active key | restart (the boot check will tell you); re-key if the key rotated |
| `Contract is paused` / `/health-check` 500 with `eos:false` | governance paused `orng.wax` / RPC unreachable now | wait / fix the node; the poller keeps retrying |
| `Application: worker … died … exiting primary` | a cluster worker crashed | read the worker's last lines; the whole process restarts by design |

## Appendix A — configuration reference

`NODE_ENV` is read by the config loader (selects `config/<NODE_ENV>.json`; `test` refused).
Everything below is mapped in `config/custom-environment-variables.json`; defaults are from
`config/default.json`. "Required" means you must set it for a mainnet member.

| Variable | Config path | Default | Meaning | Required |
| --- | --- | --- | --- | --- |
| `EOS_CHAIN_ID` | `eos.chainId` | a dev chain id | chain id the transactions are signed for | yes |
| `EOS_API_URL` | `eos.apiUrl` | `http://127.0.0.1:8888` | API node | yes |
| `EOS_ORNG_CONTRACT_NAME` | `eos.orng.contractName` | `orng.wax` | contract account | no |
| `EOS_ORNG_NODE_OWNER` | `eos.orng.nodeOwner` | `orng.wax` | your member account | yes |
| `EOS_ORNG_AUTH_PERMISSION` | `eos.orng.auth` | `active` | permission the process signs with (`rngops` recommended) | yes |
| `EOS_ORNG_PRIVATE_KEY` | `eos.orng.privateKey` | empty | private key of that permission (**secret**) | yes |
| `EOS_ORNG_MAX_CPU` | `eos.orng.maxCpu` | `100` | `max_cpu_usage_ms` per transaction | no |
| `SHARE_KEY_THRESHOLD` | `shareKey.threshold` | `2` | k | yes |
| `SHARE_KEY_NUM_PARTIES` | `shareKey.numParties` | `3` | N | yes |
| `SHARE_KEY_BITS` | `shareKey.bits` | `4096` | modulus size | yes |
| `SHARE_KEY_SHARE_INDEX` | `shareKey.shareIndex` | `1` | your index; must equal `oracle_index` | yes |
| `SHARE_KEY_PUBLIC_KEY_N` | `shareKey.publicKey.n` | empty | modulus, lower-case hex | yes |
| `SHARE_KEY_PUBLIC_KEY_E` | `shareKey.publicKey.e` | empty | exponent, hex | yes |
| `SHARE_KEY_PRIVATE_KEY_HEX` | `shareKey.sharedKey` | empty | your share (**secret**) | yes |
| `SHARE_KEY_VERIFICATION_KEY` | `shareKey.verificationKey` | empty | dealer `v` | yes |
| `SHARE_KEY_VERIFICATION_KEY_SHARE` | `shareKey.verificationKeyShare` | empty | your `v_i` | yes |
| `SHARE_KEY_VKU` | `shareKey.vku` | empty | dealer `u` | yes |
| `BOOT_CHECK_RPC_RETRIES` | `bootCheck.rpcRetries` | `6` | boot-check attempts before failing closed | no |
| `BOOT_CHECK_RPC_RETRY_BASE_MS` | `bootCheck.rpcRetryBaseMs` | `2000` | first retry delay, doubling, 30 s cap | no |
| `JOB_RETRY_MAX_RETRIES` | `jobRetry.maxRetries` | `3` | execute / delivery back-off budget (`2^n × 500 ms`) | no |
| `JOB_PENDING_ALERT_MAX_JOB_PENDING` | `jobPendingAlert.maxJobPending` | `100` | Slack alert threshold on pending requests | no |
| `DB_FILE` | `db.file` | `db.json` | lowdb state file (relative to the working directory) | recommended |
| `READONLY_MODE` | `readOnlyMode` | `false` | API only, no signing (warm standby, 6.6) | no |
| `CLUSTER_MODE` | `clusterMode` | `false` | one worker per CPU | no |
| `EXPRESS_APP_ENABLE` | `expressApp.enable` | `true` | serve `/health-check`, `/version`, `/jobs` | no |
| `EXPRESS_APP_PORT` | `expressApp.port` | `3000` | HTTP port | no |
| `LOGGER_LEVEL` | `logger.level` | `debug` | winston level (`info` for production) | no |
| `METRICS_HOST` / `METRICS_PORT` / `METRICS_PREFIX` | `metrics.*` | `localhost` / `8125` / `wax-rng-oracle` | StatsD target | no |
| `SLACK_WEBHOOK` | `slackWebhook` | empty | incoming-webhook URL; empty disables alerts | no |
| `SECRETS_MANAGER_SECRET_ID` | `secretsManager.secretId` | none | `@waxio/wax-config` only (3.1) | no |
| `ENCRYPTED_KEYS` | `encrypted_keys` | none | `@waxio/wax-config` only: config paths to resolve | no |
| `DECRYPTION_ENVIRONMENTS` | `decryption.environments` | none | `@waxio/wax-config` only: `NODE_ENV`s that resolve | no |

`DB`, `PROCESS_MODULUS` and `TOTAL_PROCESS` are set by the cluster primary for its workers;
do not set them. `fetchRetry.maxRetries` (5) has no environment variable.

## Appendix B — on-chain reference

Contract `orng.wax` v3.4.0. "Member" auth means `require_auth(oracle)` plus the account must be
in `oracles.a` and not suspended; the contract must not be paused.

| Action | Auth | Pushed by | What it does |
| --- | --- | --- | --- |
| `submitpart(oracle, id, ver, sig_i)` | member | process | appends `{oracle_index, sig_i}` to `reqs[id].parts`; rejects `version mismatch`, `duplicate part` |
| `setrand(oracle, id, ver, sig)` | member | process | verifies the canonical full signature against `pubkeys[ver]`; bad → strike; good → deliver, erase request, split the fee |
| `markfailed(oracle, id, ver, sig, error_message)` | member | process | same verification; stores the result in `undelivered1`, pays half the fee |
| `retrydeliver(request_id)` | none required (process signs as member) | process | re-attempts delivery of an `undelivered1` row |
| `cleanup(oracle, batch_size)` | member | process (daily) | erases `undelivered1` rows past `oracle_reward_deadline` |
| `claim(oracle)` | `oracle`, needs an `ostip.a` row | you, by hand | pays unpaid fees plus accrued stipend |
| `setoracles(name[])` | `orng.wax` (msig) | governance | replaces the member set; index = 1-based position; resets strikes / suspension; creates `ostip.a` rows |
| `setpubkey(version, exponent, modulus)` / `retirepubkey(version)` | `orng.wax` (msig) | governance | adds the next version and activates it at once / marks a version retired (`key retired` on `setrand`) |
| `resetsuspen(account)`, `configv2`, `configv3`, `setstipend` | `orng.wax` (msig) | governance | un-suspend; economics |

| Table (scope `orng.wax`) | Key | Fields you read |
| --- | --- | --- |
| `oracles.a` | member name | `oracle_index`, `strikes`, `suspended` |
| `pubkeys` | `ver` | `modulus`, `exponent`, `retired`, `pubkey_hash_id` |
| `config.a` | name | `activever`, `strikesmax`, `minclaimint`, `stipendmonth`, `feepercall`, `paused`, `oraclereward` (seconds a result waits in `undelivered1`) |
| `ostip.a` | member name | `active`, `last_claim`, `last_accrue`, `usd_accrued` (USD × 10⁴) |
| `balances` | member name | `unpaid` fee share |
| `reqs` | `id` | `dapp`, `seed`, `ver`, `nonce`, `assoc_id`, `parts[] {idx, sig_i}` |
| `undelivered1` | `request_id` | `dapp`, `assoc_id`, `error_message`, `oracle_reward_deadline` |
| `signvals.a` | `signing_value` | legacy v1 table kept for old dApps; not used by the member process |
