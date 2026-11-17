const { RpcError } = require('./config/eos');

/**
 * Classify why a pushed transaction was rejected, so the execute path can tell
 * a delivery failure (the dApp's callback asserted → the result belongs in
 * `undelivered1` via `markfailed`) from a rejection by the API node (CPU/NET,
 * subjective billing, whitelist, expiry — the request is still deliverable and
 * must simply be retried).
 *
 * Antelope error codes come in families of 10 000. The failures that mean
 * "the contract code refused / crashed", and therefore would do so on every
 * replay, are:
 *   3050000 action_validate_exception  (eosio_assert, abort, unknown action,
 *                                       inline action too big, RAM billed to a
 *                                       non-authorising account, …)
 *   3070000 wasm_exception             (execution error, out of memory, …)
 *   3080001 ram_usage_exceeded         (the dApp's payer is out of RAM)
 *   3090004 missing_auth_exception     (require_auth inside the callback)
 * Everything else — the rest of resource_exhausted (3080000: tx_cpu_usage_exceeded
 * is also what nodeos uses for the subjective "exceeded failure limit"
 * refusal), whitelist/blacklist (3130000, "not on the actor whitelist"), the
 * rest of authorization (3090000), transaction (3040000: expired, duplicate),
 * chain/plugin errors — is the node refusing to carry the transaction, not the
 * dApp refusing the result. An objective CPU overrun of a heavy callback is
 * indistinguishable from the subjective one and is treated as node-side.
 */
const CONTRACT_FAMILIES = [3050000, 3070000];
const CONTRACT_CODES = new Set([3080001, 3090004]);
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

/**
 * eosjs builds RpcError from three response shapes: `{error}` (push rejected,
 * HTTP 500), `{processed: {except}}` and `{result: {except}}` (send_transaction
 * with return_failure_trace). Normalise them to {code, name, message}.
 */
function rpcErrorBody(err) {
  const json = (err && err.json) || {};
  if (json.error) {
    const e = json.error;
    const d = Array.isArray(e.details)
      ? e.details.find(x => x && typeof x.message === 'string')
      : null;
    return {
      code: e.code,
      name: e.name,
      message: (d && d.message) || e.what || json.message || '',
    };
  }
  const except =
    (json.processed && json.processed.except) ||
    (json.result && json.result.except);
  if (except) {
    const frame = Array.isArray(except.stack)
      ? except.stack.find(f => f && (f.data || f.format))
      : null;
    const assertion =
      frame && frame.data && typeof frame.data.s === 'string'
        ? `assertion failure with message: ${frame.data.s}`
        : frame && typeof frame.format === 'string'
        ? frame.format
        : '';
    return {
      code: except.code,
      name: except.name,
      message: assertion || except.message || json.message || '',
    };
  }
  return { code: undefined, name: undefined, message: json.message || '' };
}

/**
 * The node's first error line for any RpcError, without assuming the body has
 * `error.details[0]` (a proxy 502 has none). Empty string for non-RPC errors.
 */
function rpcErrorMessage(err) {
  if (!(err instanceof RpcError)) return '';
  return rpcErrorBody(err).message || err.message || '';
}

function isContractCode(code) {
  if (!Number.isInteger(code)) return false;
  if (CONTRACT_CODES.has(code)) return true;
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
  const body = rpcErrorBody(err);
  const message = body.message || err.message || '';
  const code = Number.isInteger(body.code) ? body.code : null;
  const name = body.name || 'rpc_error';

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

module.exports = { classifyPushError, rpcErrorMessage, KIND };
