# Changelog

All notable changes to `wax-rng-oracle` (the `orng.wax` 2-of-3 threshold member process) are
documented here. Releases are tags on GitHub (`worldwide-asset-exchange/wax-rng-oracle`, unprefixed
`X.Y.Z`); since 7.2.1 the production container image is built from the release tag by this
repository's release workflow and deployed by digest.

## Version scheme (decided in WBP-2067, corrected 2026-10-29)

The application version follows the **GitHub repository** (`worldwide-asset-exchange/wax-rng-oracle`):
`package.json` `version` is the next GitHub release tag (unprefixed, like `7.1.4`), bumped in the same
change that earns it; `/version` echoes it. The maintainers' image pipeline only builds the
production image: it tags its build `v` + the app version (`v7.2.0` builds `7.2.0`), so the release
tag and the image tag carry one number. The image digest remains the real identity of what deploys.

## 7.2.1 — 2026-11-04

Build-only release: the application logic is unchanged from 7.2.0.

- **No private registry.** The two optional internal packages are gone from `package.json`; every
  dependency is on the public npm registry and pinned in the lockfile (903 entries, no version,
  integrity or URL changed). `npm ci` works again.
- **`lib/config/fetchRetry.js` carries the chain-RPC retry semantics itself** — the ones the
  production image ran through the internal package: `maxTry` total attempts (default 5), a 5 s
  abort per attempt, non-2xx retried except on the last attempt, retries only for `ECONNRESET` /
  `ETIMEDOUT` / `ECONNREFUSED` / `ENOTFOUND` or a timeout, a `100·i` ms pause, and
  `request <url> timeout` when the last attempt timed out. Before this, a build without the internal
  package fell back to a wrapper with **no timeout**, so a hung RPC connection could stall a member.
  Unit-tested (`test/fetch-retry.test.js`); the `X-WAX-Source` header test now always runs.
- **The production image is built here.** `Dockerfile_eks` and `.github/workflows/release.yml`: a
  release tag runs the floors, lint and unit tests, then builds and pushes the image (tag `v` + the
  version). Deployment stays manual and one member at a time.

## 7.2.0 — 2026-10-29 (GitHub tag `7.2.0` on `9f0ea8c`)

Security-hardening release of the member process, adopting `@waxio/rsa-threshold-signatures` 2.0.0
and closing the oracle-side findings of the 2026-10 RNG review (plus the consumer-side findings
against the signing library). **The partial-signature (`submitpart sig_i`) and full-signature
(`setrand` / `markfailed sig`) payloads are byte-identical to 6.0.0** — the library release proves
bit-identical output against 1.3.0 golden vectors, and the oracle still hands the library's
canonical string to the chain unchanged. Ticket: WBP-2067 (epic WBP-2063).

### Dependencies

- `@waxio/rsa-threshold-signatures` `^1.3.0` → `^2.0.0` (lockfile `resolved` registry.npmjs.org,
  integrity `sha512-TaXBgJhZ…`; verified with `npm ci --loglevel http` that the tarball is fetched
  from registry.npmjs.org). `node-forge` range `^1.3.1` → `^1.4.0` so a lockfile regeneration cannot
  reintroduce the `modInverse(0)` hang; the installed tree has a single hoisted `node-forge` 1.4.0.
  `secp256k1` (now an optional peer of the library, unused by the oracle) and its native build step
  drop out of the tree. The optional `@waxio/wax-config` 2.1.0 / `@waxio/fetch-retry` come from a
  private registry and are not required for open-source use.
- New `npm run check:deps` (`scripts/check-dep-floors.js`): fails if **any** installed copy of
  `node-forge` is < 1.4.0 or of the signing library is < 2.0.0. Wired into the GitHub workflow and
  the maintainers' image pipeline (an image that regressed the floors does not build).

### Boot share self-check — refuses to start on a mismatched share

- `lib/bootChecks.js`: after the share is loaded and before any poller or HTTP listener starts, the
  member reads `orng.wax` `config.a[activever]` → `pubkeys[ver]` (must exist, not retired) and runs
  the library's `verifyShareConsistency` on its own share with that row as `expectedPublicKey`
  (binds `v^{s_i} = v_i`, Jacobi checks on `v`/`u`, modulus bit length and hex width, exponent
  primality and `e > numParties`, index range, and n/e agreement with the chain). It also reads
  `oracles.a[nodeOwner]` and requires `oracle_index == SHARE_KEY_SHARE_INDEX` — `submitpart` stamps
  the on-chain index on every partial, so a configured index that differs would mis-label them.
- **Any failed check is fatal**: one log line naming the failed check(s) and the key version — never
  a value — then exit 1, so the pod crash-loops visibly instead of signing confidently and failing
  every combine (the silent-outage shape a wrong share after a re-key used to produce).
- **RPC unreachable at boot, or a row not visible yet** (a replaying / lagging node answers with
  empty rows): bounded exponential retry — `BOOT_CHECK_RPC_RETRIES` × `BOOT_CHECK_RPC_RETRY_BASE_MS`,
  default 6 attempts, 2 s doubling, 30 s cap per wait (≈ 62 s of waiting plus request time) — then
  **fail closed**. The check uses a plain RPC client (no `fetch-retry` wrapper), so that budget is
  the whole budget. A member that cannot see the chain cannot poll either, so starting unchecked
  buys nothing; the supervisor restart is the long-horizon retry. Chain state that is present but
  unusable (retired key, malformed row, index mismatch) is not retried.
- A lying RPC can only make the check fail or echo the member's true key (equivalent to today); the
  share and the verifier come from local configuration, the chain value is only compared. The key
  version it reports becomes the poller's **`activeKeyVersion` guard**: requests carrying any other
  `ver` are skipped (never signed, never combined, one log line per unseen version +
  `key_version_skipped` metric), so after a key rotation — or with a stale RPC answer at boot — the
  member must restart and re-check rather than submit partials from the wrong share.
- `/health-check` now also reports `bootCheck: { ran, ok, rpcReachable, activeKeyFound,
  oracleIndexMatches, shareConsistent, activeVer }` (booleans + the public key version) and is
  `healthy: false` / 500 unless the check passed.
- The check runs in every mode, including `READONLY_MODE` (an API-only replica now needs a
  chain-consistent share to start) and in every cluster worker; a worker that exits now takes the
  primary down with it instead of leaving a half-dead member (`cluster.on('exit')` → `exit 1`).
- Library parse errors on a malformed share value are redacted (`…; got <redacted>`) before they
  reach a log line or the crash-loop stack — the library's own message quotes a prefix of the value.

### Combine diagnostics and retry policy

- `ShareKeyService.combinePartialSignatures` screens every `reqs.parts[]` row (integer `idx`,
  hex-string `sig_i`) before the library sees it, then uses the library's `combineSignatureMessage`:
  partials that are zero, ≥ n, not coprime to n or malformed are **rejected and skipped** (the
  library's own guard), and the combine iterates k-subsets until one verifies instead of
  taking the first k. A single poisoned part on chain no longer stalls the request: the two good
  parts deliver.
- The poller logs the diagnostics with the job id and this oracle's index — `rejectedShares`
  (share index, position, reason; never the value), `failedSubsets`, `suspectShareIndices`,
  `usedShareIndices` — and emits `combine_rejected_part` / `combine_suspect_share` metrics.
- A `CombineError` (`INVALID_SHARE` when fewer than k well-formed parts remain, `NO_VALID_SUBSET`,
  `DUPLICATE_INDEX`, `NOT_ENOUGH_SHARES`) is a per-job failure, not a crash and not an RPC error: it
  is recorded **pinned to a fingerprint of the parts it failed on**, and the job is skipped until
  the on-chain parts change (another member submits, or the request is re-created). Every other
  failure keeps the existing exponential back-off / abandon policy. `combine_failed` metric with the
  error code. The Slack alert for combine failures is throttled to one post per minute per member,
  carrying the count of suppressed alerts, so a bad member cannot drown the signal.
- The verifier is built once from this member's own key set rather than per combine from global
  config; the signature-share bound check now compares integers (it compared against the hex string
  before and could never fire).

### Runtime environment

- The maintainers' image bakes `NODE_ENV=production` (after the build steps, which need
  devDependencies). The deployment environment already sets it too — the image no longer depends
  on that, so `config/test.json` (fixture share + dev chain key) can never be merged by an image
  started without the env.
- `index.js` refuses to start with `NODE_ENV=test` (reserved for the mocha runner).

### Vendored contract

- `docs/orng.cpp` / `docs/orng.hpp` and `test/artifacts/wax.orng.{wasm,abi}` are now `wax-orng`
  **v3.4.0** (wasm sha256 `fa4bee5f…`, abi `ea4e9436…`) instead of the v3.2.1-era copy. v3.4.0
  requires the oracle's authority on `submitpart` (the pusher already signs as `oracle@<auth>`) and
  accepts only the canonical full signature on `setrand`/`markfailed` (the only form this process
  has ever emitted). No oracle-facing action/table/field changed.

### Tests

- New, chain-free: `test/combine-partials.test.js`, `test/boot-checks.test.js`,
  `test/storage.test.js`, `test/check-dep-floors.test.js`; `/health-check` boot-check cases added.
  `test/fixtures/testShareKeys.js` derives the 4096-bit throwaway key set used by `poller.test.js`
  from `config/threshold-keys-test.json` at load time (the inline copy is gone). `npm run test:unit`
  now runs 11 files.
- Against 6.0.0 (`762a514`, library 1.3.0) the poisoned-zero combine case throws
  `Intermediate verify signature is invalid` and the poller delivers nothing — the behaviour this
  release removes.

### Version

- `package.json` `7.1.4` → `7.2.0` (see *Version scheme* above). `/version` reports `7.2.0`.
  Image tag for this release: `v7.2.0`.

## 6.0.0 — 2026-08-30

First production container image from the maintainers' image pipeline. Package version at the
time: 7.1.4.
