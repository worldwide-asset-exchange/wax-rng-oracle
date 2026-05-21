/**
 * Fetch retry shim that provides compatibility between:
 * - @waxio/fetch-retry (internal WAX fetch with retry)
 * - A simple fetch wrapper with retry logic for open source usage
 *
 * Usage: const fetch = require('./fetchRetry').default(maxRetries);
 */

let fetchRetryFactory;

try {
  // Try internal WAX fetch-retry
  fetchRetryFactory = require('@waxio/fetch-retry').default;
} catch (err) {
  if (err.code === 'MODULE_NOT_FOUND') {
    // Fall back to simple fetch with retry wrapper
    fetchRetryFactory = createFetchRetryFactory();
  } else {
    throw err;
  }
}

/**
 * Creates a fetch factory function with retry logic
 * @returns {Function} Factory function that takes maxRetries and returns fetch
 */
function createFetchRetryFactory() {
  // Use native fetch (Node 18+) or fall back to node-fetch
  let baseFetch;
  if (typeof globalThis.fetch === 'function') {
    baseFetch = globalThis.fetch;
  } else {
    baseFetch = require('node-fetch');
  }

  return function fetchRetryFactory(maxRetries = 3) {
    return async function fetchWithRetry(url, options = {}) {
      let lastError;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const response = await baseFetch(url, options);
          return response;
        } catch (error) {
          lastError = error;

          // Don't retry on the last attempt
          if (attempt < maxRetries) {
            // Exponential backoff: 100ms, 200ms, 400ms, etc.
            const delay = Math.min(100 * Math.pow(2, attempt), 5000);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      throw lastError;
    };
  };
}

module.exports = { default: fetchRetryFactory };
