/**
 * Config loader shim that provides compatibility between:
 * - @waxio/wax-config (internal WAX secrets management)
 * - config (standard npm config library for open source usage)
 *
 * This allows the project to work both in internal deployments with
 * secrets management and in open source deployments using standard config files.
 */

let configInstance;

function loadConfig() {
  if (configInstance) return configInstance;

  try {
    // Try internal WAX config (with secrets management)
    const waxConfig = require('@waxio/wax-config');
    configInstance = waxConfig.loadConfig();
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      // Fall back to standard config library
      configInstance = require('config');
    } else {
      throw err;
    }
  }

  return configInstance;
}

module.exports = { loadConfig };
