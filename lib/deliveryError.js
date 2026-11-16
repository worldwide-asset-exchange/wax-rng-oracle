const { RpcError } = require('./config/eos');

/**
 * Classify why a pushed transaction was rejected, so the execute path can tell
 * a delivery failure (the dApp's callback asserted → the result belongs in
 * `undelivered1` via `markfailed`) from a rejection by the API node (CPU/NET,
 * subjective billing, whitelist, expiry — the request is still deliverable and
 * must simply be retried).
 *
 * Antelope error codes come in families of 10 000. The two families that mean
 * "the contract code refused / crashed", and therefore would do so on every
 * replay, are:
 *   3050000 action_validate_exception  (eosio_assert, abort, unknown action,
 *                                       inline action too big, RAM billed to a
 *                                       non-authorising account, …)
 *   3070000 wasm_exception             (execution error, out of memory, …)
 * Everything else — resource_exhausted (3080000: tx_cpu_usage_exceeded is also
 * what nodeos uses for the subjective "exceeded failure limit" refusal),
 * whitelist/blacklist (3130000, "not on the actor whitelist"), authorization
 * (3090000), transaction (3040000: expired, duplicate), chain/plugin errors —
 * is the node refusing to carry the transaction, not the dApp refusing the
 * result.
 */
const CONTRACT_FAMILIES = [3050000, 3070000];
const FAMILY = 10000;

const KIND = Object.freeze({
  /** the request no longer exists on chain (someone else delivered it) */
  COLLISION: 'collision',
  /** the delivery itself failed inside contract code: push markfailed */
  CONTRACT: 'contract',
  /** the API node refused the transaction: retry, do not markfailed */
  NODE: 'node',
  /** not an RPC error at all (network, bug) */
  UNKNOWN: 'unknown',
});

function firstDetailMessage(error) {
  if (error && Array.isArray(error.details)) {
    const d = error.details.find(x => x && typeof x.message === 'string');
    if (d) return d.message;
  }
  return '';
}

function isContractCode(code) {
  if (!Number.isInteger(code)) return false;
  return CONTRACT_FAMILIES.some(f => code >= f && code < f + FAMILY);
}

/**
 * @param {Error} err  whatever the pusher threw
 * @returns {{kind: string, code: number|null, name: string, message: string}}
 *   `message` is the node's first detail line (what the old code stored in
 *   `markfailed.error_message`), falling back to `what` / the HTTP message.
 */
function classifyPushError(err) {
  if (!(err instanceof RpcError)) {
    return {
      kind: KIND.UNKNOWN,
      code: null,
      name: (err && err.name) || 'Error',
      message: (err && err.message) || String(err),
    };
  }
  const json = err.json || {};
  const error = json.error || {};
  const detail = firstDetailMessage(error);
  const message = detail || error.what || json.message || err.message || '';
  const code = Number.isInteger(error.code) ? error.code : null;
  const name = error.name || 'rpc_error';

  if (message.includes('no request found')) {
    return { kind: KIND.COLLISION, code, name, message };
  }
  if (
    isContractCode(code) ||
    // a node that reports no code but an assertion text is still the contract
    (code === null &&
      /^assertion failure with (message|error code)/.test(message))
  ) {
    return { kind: KIND.CONTRACT, code, name, message };
  }
  return { kind: KIND.NODE, code, name, message };
}

module.exports = { classifyPushError, KIND };
