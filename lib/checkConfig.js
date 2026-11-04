/**
 * `--check-config`: validate a member's configuration and host without a
 * share, without starting the poller or the HTTP API, and without pushing a
 * transaction.
 *
 * Why it exists: the boot self-check (`bootChecks.js`) is fail-closed by
 * design — a process with no share, or a share the chain does not know, exits
 * before anything else runs, so `READONLY_MODE` cannot be used to "try the
 * host" before the key ceremony. This module checks everything that CAN be
 * checked at that stage (runtime, configuration shape, the signing key, the
 * API node, the contract state, the account's permission and resources) and,
 * when SHARE_KEY_* are already staged, runs the same share consistency check
 * the boot path runs.
 *
 * Statuses: `ok`, `fail` (the service would refuse to start or could not
 * sign — exit non-zero), `warn` (worth a look, does not block), `skip` (not
 * applicable yet, or not checkable from here).
 *
 * Output rule: names, public keys, fingerprints and counts only. Never a
 * private key, a share, a verification value, or a prefix of one.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PrivateKey, PublicKey } = require('eosjs/dist/eosjs-key-conversions');
const {
  fetchActivePublicKey,
  fetchOracleIndex,
  assertRuntimeEnv,
  BootCheckError,
} = require('./bootChecks');
const { isTrue } = require('./config/utils');

const ANTELOPE_NAME = /^[a-z1-5.]{1,12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SHARE_FIELDS = [
  'publicKey.n',
  'publicKey.e',
  'sharedKey',
  'verificationKey',
  'verificationKeyShare',
  'vku',
];
// config path → environment variable (config/custom-environment-variables.json)
const SHARE_ENV = {
  'publicKey.n': 'SHARE_KEY_PUBLIC_KEY_N',
  'publicKey.e': 'SHARE_KEY_PUBLIC_KEY_E',
  sharedKey: 'SHARE_KEY_PRIVATE_KEY_HEX',
  verificationKey: 'SHARE_KEY_VERIFICATION_KEY',
  verificationKeyShare: 'SHARE_KEY_VERIFICATION_KEY_SHARE',
  vku: 'SHARE_KEY_VKU',
};
const EXPECTED_SHARE_PARAMS = { threshold: 2, numParties: 3, bits: 4096 };
const HEAD_LAG_WARN_SECONDS = 30;
const MIN_CPU_AVAILABLE_US = 1000000; // 1 s of CPU
const MIN_NET_AVAILABLE_BYTES = 10000;

const get = (obj, dotted) =>
  dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const str = v => (v === undefined || v === null ? '' : String(v).trim());
const isName = s => ANTELOPE_NAME.test(s) && !s.endsWith('.');
const short = s => (s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s);

/** sha256 over the lower-case hex modulus — what the operator guide calls the key fingerprint. */
function fingerprintModulus(modulusHex) {
  return crypto
    .createHash('sha256')
    .update(String(modulusHex).toLowerCase())
    .digest('hex');
}

/** Both spellings of a K1 public key so chain output in either form compares. */
function derivePublicKey(privateKeyString) {
  const pub = PrivateKey.fromString(privateKeyString).getPublicKey();
  return { k1: pub.toString(), legacy: pub.toLegacyString() };
}

function normalisePublicKey(s) {
  try {
    return PublicKey.fromString(String(s)).toString();
  } catch (e) {
    return String(s);
  }
}

class Report {
  constructor() {
    this.checks = [];
  }
  add(name, status, detail) {
    this.checks.push({ name, status, detail });
    return status;
  }
  ok(name, detail) {
    return this.add(name, 'ok', detail);
  }
  fail(name, detail) {
    return this.add(name, 'fail', detail);
  }
  warn(name, detail) {
    return this.add(name, 'warn', detail);
  }
  skip(name, detail) {
    return this.add(name, 'skip', detail);
  }
  get summary() {
    const s = { ok: 0, fail: 0, warn: 0, skip: 0 };
    for (const c of this.checks) s[c.status] += 1;
    return s;
  }
  get passed() {
    return this.summary.fail === 0;
  }
}

function checkRuntime(report, env) {
  try {
    assertRuntimeEnv(env.NODE_ENV);
  } catch (e) {
    return report.fail('runtime.nodeEnv', e.message);
  }
  const nodeEnv = str(env.NODE_ENV) || '(unset)';
  if (nodeEnv !== 'production') {
    return report.warn(
      'runtime.nodeEnv',
      `NODE_ENV=${nodeEnv}; the service unit sets NODE_ENV=production`
    );
  }
  return report.ok('runtime.nodeEnv', 'NODE_ENV=production');
}

function checkShape(report, config) {
  const chainId = str(get(config, 'eos.chainId'));
  if (!HEX64.test(chainId)) {
    report.fail(
      'config.chainId',
      'EOS_CHAIN_ID must be 64 lower-case hex characters'
    );
  } else {
    report.ok('config.chainId', short(chainId));
  }

  const apiUrl = str(get(config, 'eos.apiUrl'));
  let url;
  try {
    url = new URL(apiUrl);
  } catch (e) {
    url = null;
  }
  if (!url || !/^https?:$/.test(url.protocol)) {
    report.fail('config.apiUrl', 'EOS_API_URL must be an http(s) URL');
  } else {
    report.ok('config.apiUrl', url.origin);
  }

  const owner = str(get(config, 'eos.orng.nodeOwner'));
  const contract = str(get(config, 'eos.orng.contractName'));
  const auth = str(get(config, 'eos.orng.auth'));
  const bad = [
    ['EOS_ORNG_NODE_OWNER', owner],
    ['EOS_ORNG_CONTRACT_NAME', contract],
    ['EOS_ORNG_AUTH_PERMISSION', auth],
  ].filter(([, v]) => !isName(v));
  if (bad.length) {
    report.fail(
      'config.accounts',
      `not a valid Antelope name: ${bad.map(([k]) => k).join(', ')}`
    );
  } else {
    report.ok('config.accounts', `${owner}@${auth} → ${contract}`);
    if (auth === 'active' || auth === 'owner') {
      report.warn(
        'config.permission',
        `signing as ${owner}@${auth}; the guide recommends a dedicated permission linked to the five actions (section 1)`
      );
    }
  }

  const maxCpu = Number(get(config, 'eos.orng.maxCpu'));
  if (!Number.isInteger(maxCpu) || maxCpu < 1 || maxCpu > 150) {
    report.fail(
      'config.maxCpu',
      'EOS_ORNG_MAX_CPU must be an integer between 1 and 150 (ms)'
    );
  } else {
    report.ok('config.maxCpu', `${maxCpu} ms per transaction`);
  }

  const threshold = Number(get(config, 'shareKey.threshold'));
  const numParties = Number(get(config, 'shareKey.numParties'));
  const bits = Number(get(config, 'shareKey.bits'));
  const shareIndex = Number(get(config, 'shareKey.shareIndex'));
  const problems = [];
  if (!Number.isInteger(numParties) || numParties < 2)
    problems.push('SHARE_KEY_NUM_PARTIES');
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > numParties)
    problems.push('SHARE_KEY_THRESHOLD');
  if (!Number.isInteger(bits) || bits < 1024) problems.push('SHARE_KEY_BITS');
  if (
    !Number.isInteger(shareIndex) ||
    shareIndex < 1 ||
    shareIndex > numParties
  )
    problems.push('SHARE_KEY_SHARE_INDEX');
  if (problems.length) {
    report.fail('config.shareParams', `out of range: ${problems.join(', ')}`);
  } else {
    report.ok(
      'config.shareParams',
      `${threshold}-of-${numParties}, ${bits}-bit, share index ${shareIndex}`
    );
    const e = EXPECTED_SHARE_PARAMS;
    if (
      threshold !== e.threshold ||
      numParties !== e.numParties ||
      bits !== e.bits
    ) {
      report.warn(
        'config.shareParams',
        `mainnet uses ${e.threshold}-of-${e.numParties} / ${e.bits}-bit; this is not that`
      );
    }
  }

  const dbFile = str(get(config, 'db.file')) || 'db.json';
  const dbPath = path.resolve(dbFile);
  const probe = fs.existsSync(dbPath) ? dbPath : path.dirname(dbPath);
  try {
    fs.accessSync(probe, fs.constants.W_OK);
    report.ok('config.dbFile', `${dbPath} is writable`);
  } catch (e) {
    report.fail(
      'config.dbFile',
      `${dbPath}: ${
        fs.existsSync(path.dirname(dbPath))
          ? 'not writable'
          : 'directory does not exist'
      } (DB_FILE; under ProtectSystem=strict it must be inside ReadWritePaths)`
    );
  }

  if (isTrue(get(config, 'expressApp.enable'))) {
    const port = Number(get(config, 'expressApp.port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      report.fail('config.expressPort', 'EXPRESS_APP_PORT must be 1–65535');
    } else {
      report.ok(
        'config.expressPort',
        `${port} (firewall it: the API listens on all interfaces)`
      );
    }
  } else {
    report.skip(
      'config.expressPort',
      'EXPRESS_APP_ENABLE=false (no /health-check)'
    );
  }

  const metricsPort = Number(get(config, 'metrics.port'));
  if (
    !Number.isInteger(metricsPort) ||
    metricsPort < 1 ||
    metricsPort > 65535
  ) {
    report.fail('config.metricsPort', 'METRICS_PORT must be 1–65535');
  } else {
    report.ok(
      'config.metricsPort',
      `statsd ${str(get(config, 'metrics.host')) || 'localhost'}:${metricsPort}`
    );
  }

  const slack = str(get(config, 'slackWebhook'));
  if (!slack) {
    report.skip('config.slackWebhook', 'SLACK_WEBHOOK not set (no alerts)');
  } else if (!slack.startsWith('https://hooks.slack.com/')) {
    report.warn(
      'config.slackWebhook',
      'SLACK_WEBHOOK does not look like a Slack incoming webhook URL'
    );
  } else {
    report.ok('config.slackWebhook', 'set');
  }

  if (isTrue(get(config, 'clusterMode'))) {
    report.warn(
      'config.clusterMode',
      'CLUSTER_MODE=true forks one worker per CPU; the guide recommends false'
    );
  }
  if (isTrue(get(config, 'readOnlyMode'))) {
    report.warn(
      'config.readOnlyMode',
      'READONLY_MODE=true: this member would serve the API and sign nothing'
    );
  }
}

function checkSigningKey(report, config) {
  const wif = str(get(config, 'eos.orng.privateKey'));
  if (!wif) {
    report.fail('signingKey.parses', 'EOS_ORNG_PRIVATE_KEY is not set');
    return null;
  }
  try {
    const pub = derivePublicKey(wif);
    report.ok('signingKey.parses', `public key ${pub.legacy}`);
    return pub;
  } catch (e) {
    report.fail(
      'signingKey.parses',
      'EOS_ORNG_PRIVATE_KEY does not parse as a WAX private key'
    );
    return null;
  }
}

function shareConfigured(config) {
  const set = SHARE_FIELDS.filter(
    f => str(get(config, `shareKey.${f}`)) !== ''
  );
  return { set, missing: SHARE_FIELDS.filter(f => !set.includes(f)) };
}

async function checkChain(report, { config, rpc, pub, now }) {
  const contract = str(get(config, 'eos.orng.contractName'));
  const owner = str(get(config, 'eos.orng.nodeOwner'));
  const auth = str(get(config, 'eos.orng.auth'));
  const chainState = { onChain: null, oracleIndex: null, registered: false };

  let info;
  try {
    info = await rpc.get_info();
  } catch (e) {
    report.fail(
      'chain.rpc',
      `API node unreachable: ${e && e.message ? e.message : e}`
    );
    for (const n of [
      'chain.chainId',
      'chain.activeKey',
      'chain.oracleRow',
      'account.permission',
      'account.resources',
    ])
      report.skip(n, 'RPC unreachable');
    return chainState;
  }
  const lag = Math.round(
    (now() - Date.parse(`${info.head_block_time}Z`)) / 1000
  );
  if (Number.isFinite(lag) && lag > HEAD_LAG_WARN_SECONDS) {
    report.warn(
      'chain.rpc',
      `reachable, but head block is ${lag} s old (lagging node → missed requests)`
    );
  } else {
    report.ok(
      'chain.rpc',
      `reachable, head block ${Number.isFinite(lag) ? `${lag} s` : '?'} old`
    );
  }

  const configured = str(get(config, 'eos.chainId'));
  if (str(info.chain_id) !== configured) {
    report.fail(
      'chain.chainId',
      `node reports ${short(str(info.chain_id))}, EOS_CHAIN_ID is ${short(
        configured
      )} (wrong network?)`
    );
  } else {
    report.ok('chain.chainId', 'matches the API node');
  }

  try {
    chainState.onChain = await fetchActivePublicKey(rpc, contract);
    const { ver, modulus } = chainState.onChain;
    report.ok(
      'chain.activeKey',
      `${contract} pubkeys[${ver}] active, fingerprint ${fingerprintModulus(
        modulus
      )}`
    );
  } catch (e) {
    report.fail(
      'chain.activeKey',
      e instanceof BootCheckError
        ? `${e.message} (${e.code})`
        : `read failed: ${e.message}`
    );
  }

  try {
    chainState.oracleIndex = await fetchOracleIndex(rpc, contract, owner);
    chainState.registered = true;
    const idx = Number(get(config, 'shareKey.shareIndex'));
    if (chainState.oracleIndex !== idx) {
      report.fail(
        'chain.oracleRow',
        `${owner} is registered with oracle_index ${chainState.oracleIndex} but SHARE_KEY_SHARE_INDEX is ${idx} (ORACLE_INDEX_MISMATCH)`
      );
    } else {
      report.ok(
        'chain.oracleRow',
        `${owner} registered, oracle_index ${chainState.oracleIndex} == share index`
      );
    }
  } catch (e) {
    if (e instanceof BootCheckError && e.code === 'ORACLE_NOT_REGISTERED') {
      report.warn(
        'chain.oracleRow',
        `${owner} is not in ${contract} oracles.a yet (expected before the cutover; the service will not start until it is)`
      );
    } else {
      report.fail(
        'chain.oracleRow',
        e instanceof BootCheckError
          ? `${e.message} (${e.code})`
          : `read failed: ${e.message}`
      );
    }
  }

  let account;
  try {
    account = await rpc.get_account(owner);
  } catch (e) {
    report.fail(
      'account.permission',
      `${owner}: get_account failed (does the account exist?)`
    );
    report.skip('account.resources', 'account not readable');
    return chainState;
  }
  const perm = (account.permissions || []).find(p => p.perm_name === auth);
  if (!perm) {
    report.fail(
      'account.permission',
      `${owner} has no permission named '${auth}' (EOS_ORNG_AUTH_PERMISSION; guide section 1.1)`
    );
  } else if (!pub) {
    report.skip(
      'account.permission',
      `${owner}@${auth} exists; signing key did not parse, cannot compare`
    );
  } else {
    const keys = (perm.required_auth && perm.required_auth.keys) || [];
    const mine = keys.find(k => normalisePublicKey(k.key) === pub.k1);
    const threshold =
      Number(perm.required_auth && perm.required_auth.threshold) || 1;
    if (!mine) {
      report.fail(
        'account.permission',
        `${owner}@${auth} does not carry the public key of EOS_ORNG_PRIVATE_KEY (${pub.legacy})`
      );
    } else if (Number(mine.weight) < threshold) {
      report.warn(
        'account.permission',
        `${owner}@${auth} carries the key with weight ${mine.weight} < threshold ${threshold}; this key alone cannot sign`
      );
    } else {
      report.ok('account.permission', `${owner}@${auth} carries ${pub.legacy}`);
    }
  }
  report.skip(
    'account.linkauth',
    `action links are not readable over the chain API; the first submitpart proves them (guide section 1.2)`
  );

  const cpu = account.cpu_limit || {};
  const net = account.net_limit || {};
  const cpuAvail = Number(cpu.available);
  const netAvail = Number(net.available);
  const low = [];
  if (!(cpuAvail >= MIN_CPU_AVAILABLE_US))
    low.push(`CPU ${Math.round(cpuAvail / 1000)} ms`);
  if (!(netAvail >= MIN_NET_AVAILABLE_BYTES)) low.push(`NET ${netAvail} bytes`);
  if (low.length) {
    report.warn(
      'account.resources',
      `${owner} has little available: ${low.join(
        ', '
      )} (stake more, guide section 1.3)`
    );
  } else {
    report.ok(
      'account.resources',
      `${owner} CPU ${Math.round(cpuAvail / 1000)} ms, NET ${Math.round(
        netAvail / 1024
      )} KiB available`
    );
  }
  return chainState;
}

async function checkShare(report, { config, chainState, ShareKeyService }) {
  const { set, missing } = shareConfigured(config);
  if (set.length === 0) {
    report.skip(
      'share.configured',
      'SHARE_KEY_* not set (expected before the ceremony)'
    );
    return;
  }
  if (missing.length) {
    report.fail(
      'share.configured',
      `partially set; missing ${missing.map(f => SHARE_ENV[f]).join(', ')}`
    );
    return;
  }
  const shareKey = get(config, 'shareKey');
  const service = new ShareKeyService({
    ...shareKey,
    publicKey: { ...shareKey.publicKey },
  });
  try {
    await service.initialize();
  } catch (e) {
    report.fail(
      'share.parses',
      `share configuration rejected (${e && e.name ? e.name : 'Error'}): ${
        e.message
      }`
    );
    return;
  }
  report.ok(
    'share.parses',
    `local fingerprint ${fingerprintModulus(shareKey.publicKey.n)}`
  );

  if (!chainState.onChain) {
    report.skip('share.consistent', 'no on-chain active key to compare with');
    return;
  }
  let result;
  try {
    result = service.verifyConsistency({
      expectedPublicKey: {
        n: chainState.onChain.modulus,
        e: chainState.onChain.exponent,
      },
    });
  } catch (e) {
    report.fail(
      'share.consistent',
      `could not compare (${e && e.name ? e.name : 'Error'})`
    );
    return;
  }
  if (!result.ok) {
    const failed = Object.keys(result.checks).filter(
      k => result.checks[k] === false
    );
    report.fail(
      'share.consistent',
      `share does not match on-chain pubkeys[${
        chainState.onChain.ver
      }] — failed: ${failed.join(
        ', '
      )} (a ceremony for a new key version that is not active yet looks like this too)`
    );
    return;
  }
  report.ok(
    'share.consistent',
    `share matches on-chain pubkeys[${chainState.onChain.ver}] (${result.bits}-bit)`
  );
}

/**
 * Run every check. Pure with respect to the process: no exit, no logger, no
 * chain write.
 * @param {Object} opts
 * @param {Object} opts.config      the loaded config (property access)
 * @param {{get_info: Function, get_account: Function, get_table_rows: Function}} opts.rpc
 * @param {Object} [opts.env]       defaults to process.env
 * @param {Function} [opts.now]     ms clock, injectable
 * @param {Function} [opts.ShareKeyService]  injectable for tests
 */
async function runConfigChecks({
  config,
  rpc,
  env = process.env,
  now = Date.now,
  ShareKeyService = require('./shareKeyService'),
}) {
  const report = new Report();
  checkRuntime(report, env);
  checkShape(report, config);
  const pub = checkSigningKey(report, config);
  const chainState = await checkChain(report, { config, rpc, pub, now });
  await checkShare(report, { config, chainState, ShareKeyService });
  return report;
}

function formatReport(report, { version } = {}) {
  const label = { ok: 'ok  ', fail: 'FAIL', warn: 'warn', skip: 'skip' };
  const width = Math.max(...report.checks.map(c => c.name.length));
  const lines = [
    `wax-rng-oracle --check-config${version ? ` (${version})` : ''}`,
    '',
  ];
  for (const c of report.checks) {
    lines.push(`${label[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`);
  }
  const s = report.summary;
  lines.push('');
  lines.push(
    `${s.ok} ok, ${s.warn} warn, ${s.skip} skip, ${s.fail} FAIL — ${
      report.passed
        ? 'nothing here would stop the service from starting.'
        : 'fix the FAIL lines; the service would refuse to start or could not sign.'
    }`
  );
  lines.push('No transaction was pushed and no secret was printed.');
  return lines.join('\n');
}

module.exports = {
  runConfigChecks,
  formatReport,
  fingerprintModulus,
  derivePublicKey,
  Report,
};
