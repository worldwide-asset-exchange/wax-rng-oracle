/**
 * Boot self-checks for an oracle member (ORC-3 / SIG-5).
 *
 * Before the first partial is signed, the member proves that the share it was
 * handed belongs to the key the contract verifies against: it reads the
 * `orng.wax` `pubkeys` row for the active version (`config.a` → `activever`)
 * and runs the signing library's `verifyShareConsistency` with that row as the
 * expected public key (binding `v^{s_i} == v_i`, Jacobi checks, modulus width,
 * exponent, index range, and n/e agreement with the chain).
 *
 * Fail-closed policy:
 *  - any failed check → the caller refuses to start (exit non-zero; the pod
 *    crash-loops visibly instead of signing with a mismatched share);
 *  - RPC unreachable → bounded exponential retry, then fail closed. A member
 *    that cannot see the chain cannot poll either, so starting "unchecked" buys
 *    nothing; the supervisor restart is the long-term retry;
 *  - chain state that cannot be used (no active version, missing or retired
 *    key row) is not retried: it will not change by itself, and a restart loop
 *    is the right signal.
 *
 * What a lying RPC can and cannot do here: it can only make the check FAIL
 * (refuse to start) or report the member's own true key (pass — identical to
 * today). It cannot make the member sign under a different key: the share and
 * the verifier are built from local config, the chain value is only compared.
 *
 * Logging rule: check NAMES and the key version only — never a value.
 */
const { nameToUint64 } = require('eosjs-account-name');
const logger = require('./config/logger');

const ACTIVE_VERSION_CONFIG_KEY = 'activever';
const DEFAULT_RETRY = { attempts: 6, baseDelayMs: 2000, maxDelayMs: 30000 };

class BootCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BootCheckError';
    this.code = code;
  }
}

const emptyStatus = () => ({
  ran: false,
  ok: false,
  rpcReachable: false,
  activeKeyFound: false,
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
      `${contractName} config.a has no '${ACTIVE_VERSION_CONFIG_KEY}' row`
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
      `${contractName} pubkeys has no row for active version ${ver}`
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

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run the boot self-checks. Never throws for a failed check: returns the
 * status (and remembers it for /health-check) so the caller decides to exit.
 *
 * @param {Object} opts
 * @param {import('./shareKeyService')} opts.shareKeyService  initialized
 * @param {{get_table_rows: Function}} opts.rpc
 * @param {string} opts.contractName
 * @param {{attempts?: number, baseDelayMs?: number, maxDelayMs?: number}} [opts.retry]
 * @param {(ms: number) => Promise<void>} [opts.sleep]  injectable for tests
 */
async function runBootChecks({
  shareKeyService,
  rpc,
  contractName,
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

  let onChain;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      onChain = await fetchActivePublicKey(rpc, contractName);
      status.rpcReachable = true;
      status.activeKeyFound = true;
      status.activeVer = onChain.ver;
      break;
    } catch (err) {
      if (err instanceof BootCheckError) {
        status.rpcReachable = true;
        status.failedChecks = [err.code];
        logger.error(
          `Boot self-check FAILED: ${err.message} (${err.code}). Refusing to start.`
        );
        return status;
      }
      const delay = Math.min(
        maxDelayMs,
        baseDelayMs * Math.pow(2, attempt - 1)
      );
      logger.warn(
        `Boot self-check: chain RPC unavailable (attempt ${attempt}/${attempts}): ${
          err && err.message ? err.message : err
        }`
      );
      if (attempt < attempts) {
        await sleep(delay);
      }
    }
  }
  if (!onChain) {
    status.failedChecks = ['RPC_UNREACHABLE'];
    logger.error(
      `Boot self-check FAILED: chain RPC unreachable after ${attempts} attempts (RPC_UNREACHABLE). Refusing to start rather than sign unchecked.`
    );
    return status;
  }

  const result = shareKeyService.verifyConsistency({
    expectedPublicKey: { n: onChain.modulus, e: onChain.exponent },
  });
  status.shareConsistent = result.ok;
  if (!result.ok) {
    status.failedChecks = Object.keys(result.checks).filter(
      name => result.checks[name] === false
    );
    logger.error(
      `Boot self-check FAILED: share configuration is inconsistent with on-chain pubkeys[${
        onChain.ver
      }] — failed checks: ${status.failedChecks.join(', ')}. Refusing to start.`
    );
    return status;
  }

  status.ok = true;
  logger.info(
    `Boot self-check passed: share index ${shareKeyService.shareIndex} is consistent with on-chain pubkeys[${onChain.ver}] (${result.bits}-bit modulus)`
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
  getBootCheckStatus,
  resetBootCheckStatus,
  assertRuntimeEnv,
  BootCheckError,
  DEFAULT_RETRY,
};
