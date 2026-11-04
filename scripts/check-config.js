#!/usr/bin/env node
/**
 * `npm run check:config` / `node index.js --check-config`
 *
 * Validate this host's configuration for an orng.wax member without a share:
 * runtime, configuration shape, signing key, API node, contract state, the
 * account's permission and resources — and the share itself when SHARE_KEY_*
 * are already staged. Starts nothing, pushes nothing, prints no secret.
 * Exit 0 when nothing would stop the service from starting, 1 otherwise.
 */
require('dotenv').config();
// node-config prints a warning when no config/<NODE_ENV>.json exists; production
// members have none by design (environment variables only), so keep it quiet.
process.env.SUPPRESS_NO_CONFIG_WARNING =
  process.env.SUPPRESS_NO_CONFIG_WARNING || 'y';

async function main() {
  const config = require('../lib/config/configLoader').loadConfig();
  const { createPlainRpc } = require('../lib/config/eos');
  const { runConfigChecks, formatReport } = require('../lib/checkConfig');
  const { version } = require('../package.json');

  const report = await runConfigChecks({ config, rpc: createPlainRpc() });
  process.stdout.write(`${formatReport(report, { version })}\n`);
  return report.passed ? 0 : 1;
}

if (require.main === module) {
  main().then(
    code => process.exit(code),
    err => {
      process.stderr.write(
        `check-config: ${err && err.message ? err.message : err}\n`
      );
      process.exit(2);
    }
  );
}

module.exports = { main };
