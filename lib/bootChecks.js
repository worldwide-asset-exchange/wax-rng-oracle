/**
 * Boot self-checks for an oracle member (ORC-3 / SIG-5).
 *
 * Before the first partial is signed, the member proves that the share it was
 * handed belongs to the key the contract verifies against and to the slot the
 * contract will stamp on its partials:
 *   1. `config.a[activever]` → `pubkeys[ver]` (must exist, not retired) is the
 *      expected public key; the library's `verifyShareConsistency` binds the
 *      share to it (`v^{s_i} == v_i`, Jacobi checks, modulus width, exponent,
 *      index range, n/e agreement with the chain);
 *   2. `oracles.a[nodeOwner].oracle_index` must equal `shareKey.shareIndex` —
 *      `submitpart` stores the on-chain index, not the configured one, so a
 *      mismatch would mis-label every partial this member submits.
 *
 * Fail-closed policy:
 *  - any failed check → the caller refuses to start (exit non-zero; the pod
 *    crash-loops visibly instead of signing with a mismatched share);
 *  - RPC unreachable, or a row that is simply absent (a replaying / lagging
 *    node answers with empty rows) → bounded exponential retry, then fail
 *    closed. A member that cannot see the chain cannot poll either, so starting
 *    "unchecked" buys nothing; the supervisor restart is the long-term retry;
 *  - chain state that is present but unusable (retired key, malformed row,
 *    index mismatch) is not retried: it will not change by itself.
 *
 * What a lying RPC can and cannot do here: it can only make the check FAIL
 * (refuse to start) or report the member's own true key (pass — identical to
 * today). It cannot make the member sign under a different key: the share and
 * the verifier are built from local config, the chain value is only compared.
 * The key version it reports is also what the poller then signs for
 * (`activeKeyVersion` guard), so a stale answer makes the member skip newer
 * requests rather than poison them.
 *
 * Logging rule: check NAMES and the key version only — never a value.
 */
const { nameToUint64 } = require('eosjs-account-name');
const logger = require('./config/logger');

const ACTIVE_VERSION_CONFIG_KEY = 'activever';
const DEFAULT_RETRY = { attempts: 6, baseDelayMs: 2000, maxDelayMs: 30000 };

class BootCheckError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{retryable?: boolean}} [opts]  retryable = the row may simply not
   *   be visible yet (lagging node); non-retryable = present but unusable
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'BootCheckError';
    this.code = code;
    this.retryable = opts.retryable === true;
  }
}

const emptyStatus = () => ({
  ran: false,
  ok: false,
  rpcReachable: false,
  activeKeyFound: false,
  oracleIndexMatches: false,
  shareConsistent: false,
  activeVer: null,
  failedChecks: [],
});

let lastStatus = emptyStatus();

/** Booleans only (plus the public key version) — safe for /health-check. */
function getBootCheckStatus() {
  return {
    ran: lastStatus.ran,
    ok: lastStatus.ok,
    rpcReachable: lastStatus.rpcReachable,
    activeKeyFound: lastStatus.activeKeyFound,
    oracleIndexMatches: lastStatus.oracleIndexMatches,
    shareConsistent: lastStatus.shareConsistent,
    activeVer: lastStatus.activeVer,
  };
}

/**
 * NODE_ENV=test selects config/test.json, which carries a fixture share and a
 * dev chain key. That file is for the mocha runner only; a process started as
 * the oracle must never load it.
 */
function assertRuntimeEnv(...args) {
  const env = args.length ? args[0] : process.env.NODE_ENV;
  if (env === 'test') {
    throw new Error(
      'NODE_ENV=test is reserved for the test runner (it selects config/test.json fixtures) — refusing to start the oracle'
    );
  }
}

async function getSingleRow(rpc, code, table, key) {
  const res = await rpc.get_table_rows({
    json: true,
    code,
    scope: code,
    table,
    lower_bound: key,
    upper_bound: key,
    limit: 1,
  });
  return res && Array.isArray(res.rows) ? res.rows[0] : undefined;
}

/**
 * Read the contract's active public key: `config.a[activever]` → `pubkeys[ver]`.
 * @returns {Promise<{ver: number, modulus: string, exponent: string}>}
 * @throws BootCheckError for unusable chain state; anything else is an RPC error
 */
async function fetchActivePublicKey(rpc, contractName) {
  const key = String(nameToUint64(ACTIVE_VERSION_CONFIG_KEY));
  const cfgRow = await getSingleRow(rpc, contractName, 'config.a', key);
  if (!cfgRow || String(cfgRow.name) !== key) {
    throw new BootCheckError(
      'ACTIVE_VERSION_MISSING',
      `${contractName} config.a has no '${ACTIVE_VERSION_CONFIG_KEY}' row`,
      { retryable: true }
    );
  }
  const ver = Number(cfgRow.value);
  if (!Number.isInteger(ver) || ver < 1) {
    throw new BootCheckError(
      'ACTIVE_VERSION_INVALID',
      `${contractName} ${ACTIVE_VERSION_CONFIG_KEY} is not a positive integer`
    );
  }
  const pkRow = await getSingleRow(rpc, contractName, 'pubkeys', ver);
  if (!pkRow || Number(pkRow.ver) !== ver) {
    throw new BootCheckError(
      'ACTIVE_KEY_MISSING',
      `${contractName} pubkeys has no row for active version ${ver}`,
      { retryable: true }
    );
  }
  if (pkRow.retired) {
    throw new BootCheckError(
      'ACTIVE_KEY_RETIRED',
      `${contractName} pubkeys[${ver}] is retired`
    );
  }
  if (typeof pkRow.modulus !== 'string' || typeof pkRow.exponent !== 'string') {
    throw new BootCheckError(
      'ACTIVE_KEY_MALFORMED',
      `${contractName} pubkeys[${ver}] modulus/exponent are not strings`
    );
  }
  return { ver, modulus: pkRow.modulus, exponent: pkRow.exponent };
}

/**
 * Read this member's `oracles.a` row and return its on-chain oracle_index.
 * @throws BootCheckError when the member is not a registered oracle
 */
async function fetchOracleIndex(rpc, contractName, nodeOwner) {
  const row = await getSingleRow(rpc, contractName, 'oracles.a', nodeOwner);
  if (!row || row.oracle !== nodeOwner) {
    throw new BootCheckError(
      'ORACLE_NOT_REGISTERED',
      `${contractName} oracles.a has no row for ${nodeOwner}`,
      { retryable: true }
    );
  }
  const idx = Number(row.oracle_index);
  if (!Number.isInteger(idx) || idx < 1) {
    throw new BootCheckError(
      'ORACLE_INDEX_MALFORMED',
      `${contractName} oracles.a[${nodeOwner}].oracle_index is not a positive integer`
    );
  }
  return idx;
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run the boot self-checks. Never throws for a failed check: returns the
 * status (and remembers it for /health-check) so the caller decides to exit.
 *
 * @param {Object} opts
 * @param {import('./shareKeyService')} opts.shareKeyService  initialized
 * @param {{get_table_rows: Function}} opts.rpc  a PLAIN JsonRpc (no fetch-retry
 *   wrapper) so the retry budget below is the whole budget
 * @param {string} opts.contractName
 * @param {string} opts.nodeOwner  this member's oracle account
 * @param {{attempts?: number, baseDelayMs?: number, maxDelayMs?: number}} [opts.retry]
 * @param {(ms: number) => Promise<void>} [opts.sleep]  injectable for tests
 */
async function runBootChecks({
  shareKeyService,
  rpc,
  contractName,
  nodeOwner,
  retry = {},
  sleep = defaultSleep,
}) {
  // config values arrive as strings/NaN from env; anything unusable → default
  const pick = name =>
    Number.isFinite(retry[name]) && retry[name] > 0
      ? retry[name]
      : DEFAULT_RETRY[name];
  const attempts = Math.floor(pick('attempts'));
  const baseDelayMs = pick('baseDelayMs');
  const maxDelayMs = pick('maxDelayMs');
  const status = { ...emptyStatus(), ran: true };
  lastStatus = status;

  const fail = (checks, line) => {
    status.failedChecks = checks;
    logger.error(`Boot self-check FAILED: ${line} Refusing to start.`);
    return status;
  };

  let onChain;
  let oracleIndex;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      onChain = await fetchActivePublicKey(rpc, contractName);
      status.rpcReachable = true;
      status.activeKeyFound = true;
      status.activeVer = onChain.ver;
      oracleIndex = await fetchOracleIndex(rpc, contractName, nodeOwner);
      break;
    } catch (err) {
      lastErr = err;
      if (err instanceof BootCheckError) {
        status.rpcReachable = true;
        if (!err.retryable) {
          return fail([err.code], `${err.message} (${err.code}).`);
        }
      }
      const delay = Math.min(
        maxDelayMs,
        baseDelayMs * Math.pow(2, attempt - 1)
      );
      logger.warn(
        `Boot self-check: chain state not available yet (attempt ${attempt}/${attempts}): ${
          err && err.message ? err.message : err
        }`
      );
      if (attempt < attempts) {
        await sleep(delay);
      }
    }
  }
  if (!onChain || oracleIndex === undefined) {
    if (lastErr instanceof BootCheckError) {
      return fail(
        [lastErr.code],
        `${lastErr.message} after ${attempts} attempts (${lastErr.code}).`
      );
    }
    return fail(
      ['RPC_UNREACHABLE'],
      `chain RPC unreachable after ${attempts} attempts (RPC_UNREACHABLE). Not signing unchecked.`
    );
  }

  if (oracleIndex !== shareKeyService.shareIndex) {
    return fail(
      ['ORACLE_INDEX_MISMATCH'],
      `${contractName} oracles.a[${nodeOwner}].oracle_index is ${oracleIndex} but this member is configured with share index ${shareKeyService.shareIndex} (ORACLE_INDEX_MISMATCH).`
    );
  }
  status.oracleIndexMatches = true;

  let result;
  try {
    result = shareKeyService.verifyConsistency({
      expectedPublicKey: { n: onChain.modulus, e: onChain.exponent },
    });
  } catch (err) {
    // the library throws (rather than reporting) when a value does not even
    // parse — e.g. an on-chain modulus that is not hex. Name it, never echo it.
    return fail(
      ['SHARE_CONFIG_UNPARSEABLE'],
      `share configuration or on-chain pubkeys[${
        onChain.ver
      }] could not be parsed (${
        err && err.name ? err.name : 'Error'
      }) (SHARE_CONFIG_UNPARSEABLE).`
    );
  }
  status.shareConsistent = result.ok;
  if (!result.ok) {
    return fail(
      Object.keys(result.checks).filter(name => result.checks[name] === false),
      `share configuration is inconsistent with on-chain pubkeys[${
        onChain.ver
      }] — failed checks: ${Object.keys(result.checks)
        .filter(name => result.checks[name] === false)
        .join(', ')}.`
    );
  }

  status.ok = true;
  logger.info(
    `Boot self-check passed: ${nodeOwner} share index ${shareKeyService.shareIndex} is consistent with on-chain pubkeys[${onChain.ver}] (${result.bits}-bit modulus) and oracles.a`
  );
  return status;
}

/** For tests: forget the remembered status. */
function resetBootCheckStatus() {
  lastStatus = emptyStatus();
}

module.exports = {
  runBootChecks,
  fetchActivePublicKey,
  fetchOracleIndex,
  getBootCheckStatus,
  resetBootCheckStatus,
  assertRuntimeEnv,
  BootCheckError,
  DEFAULT_RETRY,
};
