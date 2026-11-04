/**
 * Fetch with retry for the chain RPC client.
 *
 * Usage: const fetch = require('./fetchRetry').default(maxTry);
 *
 * Semantics (the production image ran exactly these from 2023 to v7.2.0 through an internal
 * package; they are kept so the signer's RPC behaviour does not change):
 * - `maxTry` is the TOTAL number of attempts (default 5).
 * - Every attempt is aborted after `timeout` ms (default 5000). Without this a hung RPC
 *   connection would stall the poller forever.
 * - A non-2xx response is retried, except on the last attempt, which returns it as-is.
 * - A network error is retried only for ECONNRESET / ETIMEDOUT / ECONNREFUSED / ENOTFOUND,
 *   or when this wrapper's own timeout aborted the attempt; any other error is thrown at once.
 * - Attempt i (0-based) is followed by a 100·i ms pause before the next one.
 * - When the last attempt timed out, the error is `request <url> timeout`.
 */
const nodeFetch = require('node-fetch');

const DEFAULT_MAX_TRY = 5;
const DEFAULT_TIMEOUT_MS = 5000;
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// node-fetch puts the system error code on the error itself; keep reading `cause` too so a
// future switch to native fetch (undici: TypeError('fetch failed', { cause })) stays correct.
function errorCode(err) {
  return (err && (err.code || (err.cause && err.cause.code))) || undefined;
}

function fetchRetryFactory(
  maxTry = DEFAULT_MAX_TRY,
  timeout = DEFAULT_TIMEOUT_MS,
  baseFetch = nodeFetch
) {
  return async function fetchWithRetry(url, opts = {}) {
    let latestError;
    let latestTimedOut = false;
    for (let i = 0; i < maxTry; i++) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeout);
      try {
        const response = await baseFetch(url, {
          ...opts,
          signal: controller.signal,
        });
        if (
          (response.status < 200 || response.status >= 300) &&
          i < maxTry - 1
        ) {
          clearTimeout(timer);
          await sleep(100 * i);
          continue;
        }
        return response;
      } catch (err) {
        if (!timedOut && !RETRYABLE_CODES.has(errorCode(err))) {
          throw err;
        }
        latestError = err;
        latestTimedOut = timedOut;
        await sleep(100 * i);
      } finally {
        clearTimeout(timer);
      }
    }
    if (latestTimedOut) {
      throw new Error('request ' + url + ' timeout');
    }
    throw latestError;
  };
}

module.exports = {
  default: fetchRetryFactory,
  DEFAULT_MAX_TRY,
  DEFAULT_TIMEOUT_MS,
};
