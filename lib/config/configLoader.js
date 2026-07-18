/**
 * Config loader shim that provides compatibility between:
 * - @waxio/wax-config (internal WAX secrets management)
 * - config (standard npm config library for open source usage)
 *
 * This allows the project to work both in internal deployments with
 * secrets management and in open source deployments using standard config files.
 *
 * The fallback is guarded two ways, because a silent fallback here means a
 * custody deployment booting on placeholder secrets:
 * - only a MODULE_NOT_FOUND for @waxio/wax-config ITSELF falls back — a missing
 *   transitive dependency (broken/partial install) rethrows loudly;
 * - a deployment that signals secrets intent (SECRETS_MANAGER_SECRET_ID,
 *   ENCRYPTED_KEYS or WAX_CONFIG_REQUIRE_RESOLUTION in the environment) never
 *   falls back at all — a missing wax-config fails the boot instead.
 */

let configInstance;

// Deployment-injected env that only exists where secrets are meant to resolve
// (mirrors wax-config's own presence-based activation). Pure open-source usage
// sets none of these and keeps the plain-config fallback.
function deploymentExpectsSecrets() {
  return Boolean(
    (process.env.SECRETS_MANAGER_SECRET_ID || '').trim() ||
      (process.env.ENCRYPTED_KEYS || '').trim() ||
      (process.env.WAX_CONFIG_REQUIRE_RESOLUTION || '').trim()
  );
}

// True only when the require failure is @waxio/wax-config itself being absent —
// "Cannot find module 'import-fresh'" (a wax-config internal) must NOT read as
// "wax-config is not installed".
function isWaxConfigMissing(err) {
  return (
    err.code === 'MODULE_NOT_FOUND' &&
    String(err.message).includes("'@waxio/wax-config'")
  );
}

function loadConfig() {
  if (configInstance) return configInstance;

  let waxConfig;
  try {
    waxConfig = require('@waxio/wax-config');
  } catch (err) {
    if (!isWaxConfigMissing(err)) {
      throw err;
    }
    if (deploymentExpectsSecrets()) {
      throw new Error(
        'configLoader: this deployment expects @waxio/wax-config ' +
          '(SECRETS_MANAGER_SECRET_ID / ENCRYPTED_KEYS / ' +
          'WAX_CONFIG_REQUIRE_RESOLUTION is set) but the module is not ' +
          'installed — refusing to boot on the plain-config fallback with ' +
          'unresolved secrets'
      );
    }
    // Fall back to standard config library (open-source usage)
    configInstance = require('config');
    return configInstance;
  }

  // cluster: true (wax-config >= 2.1.0): the cluster primary resolves secrets
  // from AWS once and hands workers their values over cluster IPC — workers make
  // no Secrets Manager call. Standalone / CLUSTER_MODE=false processes count as
  // a primary and behave exactly as before. This call site runs in both the
  // primary and the workers (index.js loads config before any fork), which is
  // exactly the shape the option expects.
  configInstance = waxConfig.loadConfig({ cluster: true });
  return configInstance;
}

module.exports = { loadConfig };
