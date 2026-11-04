# wax-rng-oracle

> **Running a signing member?** Start with the
> **[Operator guide](docs/OPERATOR-GUIDE.md)** — account and permissions, getting your key
> share, configuration, running, verifying the boot self-check, and day-to-day operation.

Node.js member process for the WAX `orng.wax` randomness service. Each member holds one share of
a 2-of-3 threshold RSA key, polls the contract's `reqs` table, submits a partial signature for
every request (`submitpart`), combines the on-chain partials into the full signature (`setrand`),
and reports delivery failures (`markfailed`, `retrydeliver`, `cleanup`). Membership and key
versions are set on the contract by producer governance; the process verifies its share against
the active on-chain key before it signs anything.

## Development

Requires Node.js 20 (the version CI and the released build run on; `engines` in
`package.json` states the floor).

Install dependencies first:

```bash
$ npm install
```

### Run all unit tests:

```bash
$ npm test
```

`npm run test:unit` runs the chain-free files only; `npm run test:integration` starts a local WAX
chain in Docker through `qtest-js`.

### Local sandbox (development only)

The `Makefile` can bring up a throwaway chain and three member processes on one machine. It is a
development aid, not a tutorial: it has not been kept in step with the contract and needs the
manual steps below before it produces a random value. For running a real member see the
[Operator guide](docs/OPERATOR-GUIDE.md).

What the targets do:

- `make setup-env` — `start-wax-all` pulls `waxteam/wax-all:latest` and starts a local chain with
  5 producers (API on `:8888`), then `setup-rng-decentralize`: creates the example dApp account
  `diceexample1`, deploys the benchmark `dicegame` contract to it (built from
  `benchmark/dice-contract/`, needs `cdt-cpp` via `make build-benchmark-contract` first) and
  `test/artifacts/wax.orng.{wasm,abi}` to `orng.wax`, adds `eosio.code` to `diceexample1@active`,
  creates `oracle1`, `oracle2`, `oracle3`, configures `orng.wax` (`setpubkey` with a sample
  modulus, `configv2`, `setoracles`, a `treasury` transfer) and funds the dApp.
- `make start-node1` / `start-node2` / `start-node3` — start one member each under PM2 with
  `NODE_ENV=local1|2|3`, reading `config/local<N>.json` (gitignored; copy
  `config/local<N>.example.json` and fill in `eos.orng.privateKey` and the `shareKey` block —
  all three nodes must hold shares of one keyset whose `publicKey.n` is the modulus registered
  with `setpubkey`). `make stop-node<N>` stops one.
- `make start-rng-nodes` / `stop-rng-nodes` — **broken**: they also reference `start-node4` /
  `stop-node5`, which do not exist. Use the per-node targets.

Before `setup-env`, unlock a local wallet holding the dev chain's default key (the one `wax-all`
seeds; the Makefile creates `diceexample1` and `oracle1` with its public key):

```bash
$ cleos wallet unlock
$ cleos wallet import --private-key <wax-all default dev key>
```

> Dev-chain keys are throwaway credentials for the local Docker chain only. Never reuse them on a
> public network.

Known gaps (fix by hand or patch the Makefile locally):

- `create-oracle-account` creates `oracle2` and `oracle3` with public keys of their own, not the
  imported dev key; the matching private keys are not in this repository, so either edit the
  target to use the dev key or create those accounts with keys you control and put the private
  keys in `config/local2.json` / `config/local3.json`.
- `config-rng-decentralize` registers a sample modulus with `setpubkey`; the members' boot
  self-check refuses to start unless their `shareKey` matches it. Generate a 2-of-3 keyset with
  [`@waxio/rsa-threshold-signatures`](https://github.com/worldwide-asset-exchange/rsa-threshold-sigs-js),
  put its `publicKey.n` in that `setpubkey` call and the shares in the three `local<N>.json`.
- `configv2` takes **two** arguments in contract v3.4.0 (`fee_per_call`, `strike_max`); the
  Makefile still passes four, so that step fails until trimmed.
- `stake-dapp` transfers to `orng.wax` with memo `deposit`; v3.4.0 only accepts
  `stake-<dapp>`, `deposit-<dapp>` or `treasury`, so use `deposit-diceexample1`.

Requesting a value: the deployed example contract is `dicegame` on `diceexample1`, whose
`rolldie(player)` action sends `orng.wax::requestrand` inline and receives the result in
`receiverand` (legacy callback form):

```bash
$ cleos push action diceexample1 rolldie '["diceexample1"]' -p diceexample1@active
$ cleos get table orng.wax orng.wax reqs      # pending requests and their parts
```

`node benchmark/benmark.js` batch-creates requests against this sandbox and polls until they are
resolved. `NODE_ENV=local3 CLUSTER_MODE=true node index.js` runs one member in cluster mode.

## Safety checks (since 7.2.0)

- **Boot share self-check.** Before signing anything the member reads the `orng.wax` `pubkeys` row
  for the active key version (`config.a` → `activever`) and verifies its own share against it with
  `verifyShareConsistency` from `@waxio/rsa-threshold-signatures` (share ↔ verification key binding,
  Jacobi checks, modulus width, exponent, index range, n/e agreement with the chain), and checks that
  `oracles.a[EOS_ORNG_NODE_OWNER].oracle_index == SHARE_KEY_SHARE_INDEX`. **Any failed check is
  fatal** — one log line naming the failed check (never a value), exit 1, visible crash loop. If the
  RPC is unreachable or a row is not visible yet, the check retries with back-off (default 6
  attempts, ≈ 1 min of waiting, plain RPC client with no inner retry) and then fails closed (see
  `BOOT_CHECK_*` below). It runs in every mode, `READONLY_MODE` included. `/health-check` reports the
  outcome as booleans under `bootCheck` and is unhealthy unless it passed. The verified key version
  also gates the poller: requests with another `ver` are skipped until the member restarts and
  re-checks (key rotation = re-key + restart).
- **Combine diagnostics.** Partials read from `reqs.parts` are screened (hex string, integer index)
  and the library rejects zero / out-of-range / non-coprime values and tries k-subsets, so a single
  poisoned partial on chain no longer stalls a request. Rejected parts, failed subsets and the
  suspect share index are logged with the job id and this oracle's index; a job whose parts cannot
  combine is parked until the on-chain parts change instead of being retried identically. The Slack
  alert for combine failures is throttled to one per minute (with a suppressed count).
- **Dependency floors.** `npm run check:deps` fails if any installed copy of `node-forge` is below
  1.4.0 or of `@waxio/rsa-threshold-signatures` below 2.0.0. It runs in CI and in the release
  workflow, and again inside the image build.

## Versioning

`package.json` `version` is the GitHub release tag (unprefixed, e.g. `7.2.0` → `7.2.1`); bump it
in the same change that earns it, record it in `CHANGELOG.md`, and `/version` echoes it. The
production container image is built from the release tag by this repository's release workflow
(`Dockerfile_eks`). **How to release: [`RELEASING.md`](RELEASING.md).**

## Run the application

### Configuration

This project uses the standard [config](https://www.npmjs.com/package/config) library for configuration management. Configuration files are located in the `config/` directory.

Default configuration is set in [config/default.json](./config/default.json). You can override settings using environment-specific config files or environment variables (full reference: operator guide, Appendix A):

- `NODE_ENV`: selects `config/<NODE_ENV>.json` on top of `default.json`. Run a member with
  `NODE_ENV=production` (no `config/production.json` is needed); `NODE_ENV=test` is reserved for
  the test runner (`config/test.json` is a fixture) and the oracle refuses to start with it
- `LOGGER_LEVEL`: winston level, default `debug`. **Run `LOGGER_LEVEL=info` in production** — the
  default `debug` logs full signatures and partials on every request
- `BOOT_CHECK_RPC_RETRIES`, `BOOT_CHECK_RPC_RETRY_BASE_MS`: how long the boot share self-check waits
  for the chain RPC before failing closed (default 6 attempts, 2 s doubling, 30 s cap per wait,
  ≈ 62 s of waiting plus request time; no inner fetch retry)
- `READONLY_MODE`: run express app only
- `METRICS_HOST`, `METRICS_PORT`, `METRICS_PREFIX`: StatsD target (default `localhost:8125`,
  prefix `wax-rng-oracle`)
- `EOS_CHAIN_ID`: wax chain id
- `EOS_API_URL`: wax chain api url
- `EOS_ORNG_NODE_OWNER`: this member's account name
- `EOS_ORNG_CONTRACT_NAME`: must be `orng.wax`
- `EOS_ORNG_AUTH_PERMISSION`: permission the process signs with (default `active`; a dedicated
  permission linked to the oracle actions is recommended — operator guide, section 1)
- `EOS_ORNG_MAX_CPU`: max CPU to push transaction to blockchain
- `EOS_ORNG_PRIVATE_KEY`: private key of that permission (secret)
- `SHARE_KEY_*`: this member's threshold share and the dealer's public values (operator guide,
  section 2.3; `SHARE_KEY_PRIVATE_KEY_HEX` is secret)
- `JOB_RETRY_MAX_RETRIES`: Maximum execution retry times if fail
- `JOB_PENDING_ALERT_MAX_JOB_PENDING`: send alert message to slack channel if pending job greater than this config
- `DB_FILE`: Path to db file
- `EXPRESS_APP_ENABLE`: enable express app
- `EXPRESS_APP_PORT`: express app port
- `CLUSTER_MODE`: run app as cluster mode
- `SLACK_WEBHOOK`: slack webhook channel

```bash
$ npm start
```

#### Optional: AWS Secrets Manager via `@waxio/wax-config`

With the optional `@waxio/wax-config` package installed, `SECRETS_MANAGER_SECRET_ID`,
`ENCRYPTED_KEYS` (comma-separated config paths, e.g.
`shareKey.sharedKey,eos.orng.privateKey,shareKey.verificationKeyShare,shareKey.vku`) and
`DECRYPTION_ENVIRONMENTS` resolve those config paths from an AWS Secrets Manager secret using the
host's IAM role. Leave all three unset to read plain config/env; setting any of them without the
package installed makes the process refuse to boot rather than run on placeholders. Any secret
manager that injects environment variables works without it. Custody guidance: operator guide,
section 3.1.

### Stats metrics

StatsD (`hot-shots`), prefix `METRICS_PREFIX`. Names as emitted by `lib/poller.js` and
`lib/jobService.js`:

| Metric | Type | Tags | Meaning |
| --- | --- | --- | --- |
| `set_rand_heart_beat` | gauge | — | `submitpart` poll loop ran |
| `seeds_to_be_send_loaded` | gauge | — | requests found that still need this member's partial |
| `seeds_sent` | counter | `contract` | partial signatures submitted |
| `set_part_failed` | counter | `contract` | `submitpart` failed (other than the cases below) |
| `job_collision` | counter | `contract` | work already done by another member (`duplicate part` on submit, `no request found` on execute) |
| `execute_heart_beat` | gauge | — | combine/`setrand` poll loop ran |
| `seeds_to_execute_loaded` | gauge | — | requests with enough partials to combine |
| `executed_job` | counter | `contract` | full signatures delivered via `setrand` |
| `execute_failed` | counter | `contract` | combine or `setrand`/`markfailed` path failed |
| `markfail_failed` | counter | `contract` | `markfailed` itself was rejected |
| `combine_failed` | counter | `contract`, `code` | on-chain parts did not combine; `code` is the library's `CombineError` code |
| `combine_rejected_part` | counter | `contract`, `idx` | a partial from share index `idx` was malformed and skipped |
| `combine_suspect_share` | counter | `contract`, `idx` | share index `idx` appeared only in failing subsets |
| `key_version_skipped` | counter | `ver` | request under a key version this member did not verify at boot |
| `seeds_pending` | gauge | — | pending requests on chain (Slack alert at `JOB_PENDING_ALERT_MAX_JOB_PENDING`) |
| `retry_deliver_heart_beat` | gauge | — | `retrydeliver` poll loop ran |
| `undelivered_jobs_loaded` | gauge | — | `undelivered1` rows eligible for a delivery retry |
| `retry_deliver_success` / `retry_deliver_failed` | counter | `dapp` | outcome of each `retrydeliver` |
| `cleanup_heart_beat` | gauge | — | `cleanup` loop ran |
| `cleanup_success` / `cleanup_failed` | counter | — | outcome of each `cleanup` push |
| `eos.response_time.get_seeds_to_be_send` | timing | — | RPC time to page `reqs` for requests to sign |
| `eos.response_time.get_job_to_execute` | timing | — | RPC time to page `reqs` for requests to combine |
| `eos.response_time.get_undelivered_to_retry` | timing | — | RPC time to page `undelivered1` |
