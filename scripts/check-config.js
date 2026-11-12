#!/usr/bin/env node
/**
 * `npm run check:config` / `node index.js --check-config`
 *
 * Validate this host's configuration for an orng.wax member without a share:
 * runtime, configuration shape, signing key, API node, contract state, the
 * account's permission and resources — and the share itself when SHARE_KEY_*
 * are already staged. `--proposal <proposer>/<name>` (or CHECK_PROPOSAL) also
 * checks the share and index against the pending eosio.msig switch.
 * Starts nothing, pushes nothing, prints no secret.
 * Exit 0 when nothing would stop the service from starting, 1 otherwise.
 */
require('dotenv').config();
// node-config writes two WARNING lines to stderr when no config/<NODE_ENV>.json
// exists (production members have none by design: environment variables only).
// They are unconditional and the service prints the same at every start; the
// report itself goes to stdout and stays clean. SUPPRESS_NO_CONFIG_WARNING only
// covers the separate "no configurations found" case.
process.env.SUPPRESS_NO_CONFIG_WARNING =
  process.env.SUPPRESS_NO_CONFIG_WARNING || 'y';
// The share service logs through winston at the configured level; keep the
// report free of INFO lines unless the operator asked for them.
process.env.LOGGER_LEVEL = process.env.LOGGER_LEVEL || 'error';

async function main() {
  const config = require('../lib/config/configLoader').loadConfig();
  const { createPlainRpc } = require('../lib/config/eos');
  const {
    runConfigChecks,
    formatReport,
    parseProposalArg,
  } = require('../lib/checkConfig');
  const { version } = require('../package.json');

  const proposal = parseProposalArg(process.argv.slice(2)); // throws → exit 2
  const report = await runConfigChecks({
    config,
    rpc: createPlainRpc(),
    proposal,
  });
  process.stdout.write(`${formatReport(report, { version })}\n`);
  return report.passed ? 0 : 1;
}

/** Exit 0 = nothing would stop the service, 1 = FAIL lines, 2 = the checker itself failed. */
function runCli() {
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

if (require.main === module) {
  runCli();
}

module.exports = { main, runCli };
