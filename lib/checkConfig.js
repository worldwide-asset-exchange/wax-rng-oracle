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
 * the boot path runs. With `--proposal <proposer>/<name>` it also decodes the
 * pending `eosio.msig` proposal that will switch the key and the member list,
 * and checks the staged share and configured index against *that* — the only
 * confirmation available while a staged member sits in its expected
 * crash loop before the switch.
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
const os = require('os');
const path = require('path');
const { PrivateKey, PublicKey } = require('eosjs/dist/eosjs-key-conversions');
const {
  fetchActivePublicKey,
  fetchOracleIndex,
  assertRuntimeEnv,
  BootCheckError,
} = require('./bootChecks');
const { isTrue } = require('./config/utils');

// 1–12 chars from [a-z1-5.], an optional 13th from [a-j1-5.]; no trailing dot
const ANTELOPE_NAME = /^[a-z1-5.]{1,12}[a-j1-5.]?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SHARE_FIELDS = [
  'publicKey.n',
  'publicKey.e',
  'sharedKey',
  'verificationKey',
  'verificationKeyShare',
  'vku',
];
// config path → environment variable, from the one mapping the service uses
const ENV_NAMES = require('../config/custom-environment-variables.json');
const shareEnv = field => get(ENV_NAMES.shareKey, field) || field;
const EXPECTED_SHARE_PARAMS = { threshold: 2, numParties: 3, bits: 4096 };
const MAX_CPU_WARN_MS = 150; // above the chain's default per-transaction limit
const HEAD_LAG_WARN_SECONDS = 30;
const MIN_CPU_AVAILABLE_US = 1000000; // 1 s of CPU
const MIN_NET_AVAILABLE_BYTES = 10000;
const MSIG_CONTRACT = 'eosio.msig';
const RSA_EXPONENT = '10001';

function get(obj, dotted) {
  return dotted
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
const str = v => (v === undefined || v === null ? '' : String(v).trim());
const isName = s => ANTELOPE_NAME.test(s) && !s.endsWith('.');
const short = s => (s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s);
/** nodeos and eosjs give zone-less UTC timestamps; a proxy may already add a zone. ms or NaN. */
const parseChainTime = text => {
  const t = str(text);
  return Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`);
};

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
  /** Soften an earlier FAIL to a warn with an explanation (a later check explained it). */
  downgrade(name, why) {
    const c = this.checks.find(x => x.name === name && x.status === 'fail');
    if (c) {
      c.status = 'warn';
      c.detail = `${c.detail} — ${why}`;
    }
    return Boolean(c);
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
  // eosjs decodes the chain id case-insensitively; so do we
  const chainId = str(get(config, 'eos.chainId')).toLowerCase();
  if (!HEX64.test(chainId)) {
    report.fail('config.chainId', 'EOS_CHAIN_ID must be 64 hex characters');
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

  // pushAction sends `max_cpu_usage_ms: maxCpu || 0`; 0 = no explicit cap
  const maxCpu = Number(get(config, 'eos.orng.maxCpu'));
  if (!Number.isInteger(maxCpu) || maxCpu < 0) {
    report.fail(
      'config.maxCpu',
      'EOS_ORNG_MAX_CPU must be a non-negative integer (ms; 0 = chain default)'
    );
  } else if (maxCpu > MAX_CPU_WARN_MS) {
    report.warn(
      'config.maxCpu',
      `${maxCpu} ms is above the chain's default per-transaction limit (${MAX_CPU_WARN_MS} ms); the cap will never bind`
    );
  } else {
    report.ok(
      'config.maxCpu',
      maxCpu === 0
        ? 'no explicit cap (chain default)'
        : `${maxCpu} ms per transaction`
    );
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
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      report.warn(
        'config.dbFile',
        `${dbPath} is writable by root, which proves nothing about the unit's user; run the dry run as the service user (section 4)`
      );
    } else {
      report.ok(
        'config.dbFile',
        `${dbPath} is writable by ${os.userInfo().username}`
      );
    }
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
  const chainState = { onChain: null, oracleIndex: null, lagging: false };

  let info;
  try {
    info = await rpc.get_info();
  } catch (e) {
    // native fetch says only "fetch failed"; the reason is in e.cause
    const cause =
      e && e.cause ? ` (${e.cause.code || ''} ${e.cause.message || ''})` : '';
    report.fail(
      'chain.rpc',
      `API node unreachable: ${e && e.message ? e.message : e}${cause}`
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
  const lag = Math.round((now() - parseChainTime(info.head_block_time)) / 1000);
  // Rows missing on a lagging node are not evidence (bootChecks.js retries
  // them); below, retryable misses on such a node are warnings, not failures.
  const lagging = !Number.isFinite(lag) || lag > HEAD_LAG_WARN_SECONDS;
  chainState.lagging = lagging;
  if (lagging) {
    report.warn(
      'chain.rpc',
      `reachable, but head block is ${
        Number.isFinite(lag) ? `${lag} s old` : 'of unknown age'
      } (lagging node → missed requests)`
    );
  } else {
    report.ok('chain.rpc', `reachable, head block ${lag} s old`);
  }

  const configured = str(get(config, 'eos.chainId')).toLowerCase();
  if (str(info.chain_id).toLowerCase() !== configured) {
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
    if (e instanceof BootCheckError && e.retryable && lagging) {
      report.warn(
        'chain.activeKey',
        `${e.message} (${e.code}) — on a lagging node this proves nothing; re-run against a synced one`
      );
    } else {
      report.fail(
        'chain.activeKey',
        e instanceof BootCheckError
          ? `${e.message} (${e.code})`
          : `read failed: ${e.message}`
      );
    }
  }

  try {
    chainState.oracleIndex = await fetchOracleIndex(rpc, contract, owner);
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
        lagging
          ? `${owner} not visible in ${contract} oracles.a on this lagging node; re-run against a synced one`
          : `${owner} is not in ${contract} oracles.a yet (expected before the cutover; the service will not start until it is)`
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
    const accounts = (perm.required_auth && perm.required_auth.accounts) || [];
    const mine = keys.find(k => normalisePublicKey(k.key) === pub.k1);
    const threshold =
      Number(perm.required_auth && perm.required_auth.threshold) || 1;
    if (!mine && accounts.length) {
      // authority delegated to another permission: the key may sit one level
      // down; not walked from here
      report.warn(
        'account.permission',
        `${owner}@${auth} does not carry ${
          pub.legacy
        } itself but delegates to ${accounts
          .map(a => `${a.permission.actor}@${a.permission.permission}`)
          .join(', ')}; make sure the key satisfies one of those`
      );
    } else if (!mine) {
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
  // nodeos reports -1 for an unlimited (privileged) account
  const cpuAvail = Number(cpu.available);
  const netAvail = Number(net.available);
  const cpuText =
    cpuAvail < 0 ? 'CPU unlimited' : `CPU ${Math.round(cpuAvail / 1000)} ms`;
  const netText =
    netAvail < 0 ? 'NET unlimited' : `NET ${Math.round(netAvail / 1024)} KiB`;
  const low = [];
  if (!(cpuAvail < 0 || cpuAvail >= MIN_CPU_AVAILABLE_US)) low.push(cpuText);
  if (!(netAvail < 0 || netAvail >= MIN_NET_AVAILABLE_BYTES)) low.push(netText);
  if (low.length) {
    report.warn(
      'account.resources',
      `${owner} has little available: ${low.join(
        ', '
      )} (stake more, guide section 1.3)`
    );
  } else {
    report.ok('account.resources', `${owner} ${cpuText}, ${netText} available`);
  }
  return chainState;
}

/**
 * `--proposal`: read and decode the pending eosio.msig transaction and check
 * what it would install against this member's configuration. Returns the
 * proposed key ({ version, modulus, exponent }) when the proposal carries a
 * well-formed `setpubkey`, else null; `checkShare` compares the share to it.
 */
async function checkProposal(
  report,
  { config, rpc, proposal, decodeTransaction, now, chainState }
) {
  const contract = str(get(config, 'eos.orng.contractName'));
  const owner = str(get(config, 'eos.orng.nodeOwner'));
  const label = `${proposal.proposer}/${proposal.name}`;
  const outcome = { proposed: null, ownerAtIndex: false };
  let trx;
  try {
    const res = await rpc.get_table_rows({
      json: true,
      code: MSIG_CONTRACT,
      scope: proposal.proposer,
      table: 'proposal',
      lower_bound: proposal.name,
      upper_bound: proposal.name,
      limit: 1,
    });
    const row = (res.rows || []).find(
      r => String(r.proposal_name) === proposal.name
    );
    if (!row) {
      const missing = `no proposal '${proposal.name}' under proposer ${proposal.proposer}`;
      if (chainState.lagging) {
        report.warn(
          'proposal.found',
          `${missing} on this lagging node; re-run against a synced one`
        );
      } else {
        report.fail(
          'proposal.found',
          `${missing} (not proposed yet, executed, cancelled, or a typo)`
        );
      }
      return outcome;
    }
    trx = await decodeTransaction(row.packed_transaction);
  } catch (e) {
    report.fail(
      'proposal.found',
      `${label}: could not read or decode the proposal: ${e.message}`
    );
    return outcome;
  }
  const actions = Array.isArray(trx.actions) ? trx.actions : [];
  const expiresAt = parseChainTime(trx.expiration);
  if (!Number.isFinite(expiresAt)) {
    report.fail(
      'proposal.found',
      `${label}: unreadable expiration '${str(trx.expiration)}'`
    );
    return outcome;
  }
  if (expiresAt <= now()) {
    report.fail(
      'proposal.found',
      `${label}: expired at ${new Date(
        expiresAt
      ).toISOString()}; it can no longer be executed`
    );
    return outcome;
  }
  report.ok(
    'proposal.found',
    `${label}: ${actions.length} action(s), expires ${new Date(
      expiresAt
    ).toISOString()}`
  );

  // Every switch action is require_auth(orng.wax): an action on another
  // contract, one not authorised by orng.wax, or one whose data could not be
  // decoded with the contract ABI cannot be the switch.
  const describe = a => `${a.account}::${a.name}`;
  const foreign = actions.filter(a => str(a.account) !== contract);
  const unauthorised = actions.filter(
    a =>
      !(Array.isArray(a.authorization) ? a.authorization : []).some(
        x => str(x.actor) === contract
      )
  );
  const undecoded = actions.filter(a => a.decodeError);
  const actionProblems = [];
  if (foreign.length)
    actionProblems.push(
      `not on ${contract}: ${foreign.map(describe).join(', ')}`
    );
  if (unauthorised.length)
    actionProblems.push(
      `not authorised by ${contract}: ${unauthorised.map(describe).join(', ')}`
    );
  if (undecoded.length)
    actionProblems.push(
      `data not decodable with the ABI: ${undecoded
        .map(a => `${describe(a)} (${a.decodeError})`)
        .join(', ')}`
    );
  if (actionProblems.length) {
    report.fail('proposal.actions', actionProblems.join('; '));
    return outcome;
  }
  report.ok(
    'proposal.actions',
    `all on ${contract}, authorised by it: ${actions
      .map(a => a.name)
      .join(', ')}`
  );

  // What the contract will accept: version == highest pubkeys ver + 1 and a
  // modulus not already installed (orng.cpp setpubkey).
  let pubkeyRows = null;
  try {
    const res = await rpc.get_table_rows({
      json: true,
      code: contract,
      scope: contract,
      table: 'pubkeys',
      limit: 100,
    });
    pubkeyRows = Array.isArray(res.rows) ? res.rows : [];
  } catch (e) {
    pubkeyRows = null;
  }

  let proposed = null;
  const pubkeyActions = actions.filter(a => a.name === 'setpubkey');
  if (pubkeyActions.length === 0) {
    report.warn(
      'proposal.setpubkey',
      'no setpubkey in the proposal (a member change without a new key?)'
    );
  } else if (pubkeyActions.length > 1) {
    report.fail(
      'proposal.setpubkey',
      `${pubkeyActions.length} setpubkey actions in one proposal`
    );
  } else {
    const d = pubkeyActions[0].data || {};
    const modulus = str(d.modulus);
    const exponent = str(d.exponent);
    const version = Number(d.version);
    const bits = modulus.length * 4;
    const wantBits = Number(get(config, 'shareKey.bits'));
    const problems = [];
    if (pubkeyRows === null) {
      report.warn(
        'proposal.keyVersion',
        `${contract} pubkeys not readable; cannot check that version ${version} is the next one`
      );
    } else {
      const maxVer = pubkeyRows.reduce((m, r) => Math.max(m, Number(r.ver)), 0);
      const installed = pubkeyRows.find(r => str(r.modulus) === modulus);
      if (installed)
        problems.push(
          `this modulus is already installed as pubkeys[${installed.ver}] (the contract rejects it)`
        );
      if (version !== maxVer + 1)
        problems.push(
          `version ${version}, but the contract requires ${maxVer +
            1} (highest pubkeys ver is ${maxVer})`
        );
    }
    if (
      !/^[0-9a-f]+$/.test(modulus) ||
      modulus.length % 2 ||
      modulus[0] === '0'
    )
      problems.push('modulus is not lower-case hex without a leading zero');
    if (exponent !== RSA_EXPONENT)
      problems.push(`exponent ${exponent} != ${RSA_EXPONENT}`);
    if (Number.isFinite(wantBits) && bits !== wantBits)
      problems.push(`${bits}-bit modulus, SHARE_KEY_BITS is ${wantBits}`);
    if (!Number.isInteger(version) || version < 1)
      problems.push(`version '${d.version}' is not a positive integer`);
    const fp = fingerprintModulus(modulus);
    const what = `version ${version}, ${bits}-bit, fingerprint ${fp}`;
    if (problems.length) {
      report.fail('proposal.setpubkey', `${what} — ${problems.join('; ')}`);
    } else {
      proposed = { version, modulus, exponent };
      outcome.proposed = proposed;
      const localN = str(get(config, 'shareKey.publicKey.n'));
      if (!localN) {
        report.skip(
          'proposal.setpubkey',
          `${what} — no share staged to compare with (compare the fingerprint with the one received on the second channel)`
        );
      } else if (fingerprintModulus(localN) === fp) {
        report.ok(
          'proposal.setpubkey',
          `${what} — equals the fingerprint of the staged ${shareEnv(
            'publicKey.n'
          )}`
        );
      } else {
        report.fail(
          'proposal.setpubkey',
          `${what} — the staged ${shareEnv(
            'publicKey.n'
          )} has fingerprint ${fingerprintModulus(
            localN
          )}: this share is for a different key`
        );
      }
    }
  }

  const oracleActions = actions.filter(a => a.name === 'setoracles');
  const idx = Number(get(config, 'shareKey.shareIndex'));
  const registered =
    chainState.oracleIndex !== null && chainState.oracleIndex !== undefined;
  if (oracleActions.length === 0) {
    if (registered && Number(chainState.oracleIndex) === idx) {
      report.warn(
        'proposal.setoracles',
        `no setoracles in the proposal (a key rotation without a member change); ${owner} stays at oracle_index ${idx}`
      );
      outcome.ownerAtIndex = true;
    } else {
      report.fail(
        'proposal.setoracles',
        `no setoracles in the proposal, and ${owner} is ${
          registered
            ? `registered with oracle_index ${chainState.oracleIndex}, not ${idx}`
            : 'not in oracles.a'
        }: the boot check would still refuse to start after the switch`
      );
    }
  } else if (oracleActions.length > 1) {
    report.fail(
      'proposal.setoracles',
      `${oracleActions.length} setoracles actions in one proposal`
    );
  } else {
    const list = (oracleActions[0].data || {}).oracles;
    const names = Array.isArray(list) ? list.map(str) : [];
    const shown = names.map((n, i) => `${i + 1}:${n}`).join(' ');
    const at = names.indexOf(owner) + 1;
    const parties = Number(get(config, 'shareKey.numParties'));
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (Number.isFinite(parties) && names.length !== parties) {
      report.fail(
        'proposal.setoracles',
        `${names.length} members proposed [${shown}] but ${shareEnv(
          'numParties'
        )} is ${parties}: the list does not fit the staged share`
      );
    } else if (dup) {
      report.fail(
        'proposal.setoracles',
        `${dup} appears twice in the proposed list [${shown}]`
      );
    } else if (at === idx && at > 0) {
      report.ok(
        'proposal.setoracles',
        `${owner} at position ${idx} of [${shown}]`
      );
      outcome.ownerAtIndex = true;
    } else if (at > 0) {
      report.fail(
        'proposal.setoracles',
        `${owner} is at position ${at} of [${shown}] but ${shareEnv(
          'shareIndex'
        )} is ${idx} (ORACLE_INDEX_MISMATCH after the switch)`
      );
    } else {
      report.fail(
        'proposal.setoracles',
        `${owner} is not in the proposed list [${shown}] (ORACLE_NOT_REGISTERED after the switch)`
      );
    }
  }

  const last = actions[actions.length - 1];
  if (
    last &&
    last.name === 'pauserequest' &&
    (last.data || {}).paused === false
  ) {
    report.ok('proposal.unpause', 'ends with pauserequest(false)');
  } else {
    report.warn(
      'proposal.unpause',
      'does not end with pauserequest(false); if requests are paused for the switch the producers must unpause separately'
    );
  }
  return outcome;
}

async function checkShare(
  report,
  { config, chainState, ShareKeyService, proposed = null }
) {
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
      `partially set; missing ${missing.map(shareEnv).join(', ')}`
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

  // Against the proposed key first (when --proposal gave one), so a chain
  // mismatch that is explained by the pending switch can be reported as such.
  const compare = key => {
    try {
      return service.verifyConsistency({
        expectedPublicKey: { n: key.modulus, e: key.exponent },
      });
    } catch (e) {
      return { error: e && e.name ? e.name : 'Error' };
    }
  };
  const failedChecks = r =>
    Object.keys(r.checks || {}).filter(k => r.checks[k] === false);
  const vsProposed = proposed ? compare(proposed) : null;
  const matchesProposed = Boolean(vsProposed && vsProposed.ok);

  if (!chainState.onChain) {
    report.skip('share.consistent', 'no on-chain active key to compare with');
  } else {
    const result = compare(chainState.onChain);
    const ver = chainState.onChain.ver;
    if (result.error) {
      report.fail('share.consistent', `could not compare (${result.error})`);
    } else if (result.ok) {
      report.ok(
        'share.consistent',
        `share matches on-chain pubkeys[${ver}] (${result.bits}-bit)`
      );
    } else if (matchesProposed) {
      report.warn(
        'share.consistent',
        `share does not match the active pubkeys[${ver}] but matches the proposed pubkeys[${proposed.version}] — expected before the switch`
      );
    } else {
      report.fail(
        'share.consistent',
        `share does not match on-chain pubkeys[${ver}] — failed: ${failedChecks(
          result
        ).join(
          ', '
        )} (a ceremony for a new key version that is not active yet looks like this too; run with --proposal to check against the pending switch)`
      );
    }
  }

  if (!proposed) return;
  if (vsProposed.error) {
    report.fail(
      'share.consistentProposed',
      `could not compare with the proposed key (${vsProposed.error})`
    );
  } else if (vsProposed.ok) {
    report.ok(
      'share.consistentProposed',
      `share matches the proposed pubkeys[${proposed.version}] (${vsProposed.bits}-bit)`
    );
  } else {
    report.fail(
      'share.consistentProposed',
      `share does not match the proposed pubkeys[${
        proposed.version
      }] — failed: ${failedChecks(vsProposed).join(', ')}`
    );
  }
}

/**
 * `--proposal <proposer>/<name>` from argv, else CHECK_PROPOSAL from env.
 * Returns { proposer, name } or null; throws on a malformed value.
 */
function parseProposalArg(argv, env = process.env) {
  let value;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === '--proposal') {
      value = argv[i + 1] === undefined ? '' : String(argv[i + 1]);
      break;
    }
    if (a.startsWith('--proposal=')) {
      value = a.slice('--proposal='.length);
      break;
    }
  }
  if (value === undefined) value = env.CHECK_PROPOSAL;
  if (str(value) === '') return null; // unset, or a blank placeholder line
  const parts = String(value)
    .trim()
    .split('/');
  const [proposer, name] = parts;
  if (parts.length !== 2 || !isName(proposer) || !isName(name)) {
    throw new Error(
      `--proposal expects proposer/name (two Antelope account names, like admin2.wax/rng.switch), got '${value}'`
    );
  }
  return { proposer, name };
}

/** Decode a packed eosio.msig transaction with the contract ABIs the node serves. */
function createTransactionDecoder(rpc) {
  const { Api } = require('eosjs');
  const { TextEncoder, TextDecoder } = require('util');
  const { hexToUint8Array } = require('eosjs/dist/eosjs-serialize');
  const api = new Api({
    rpc,
    textDecoder: new TextDecoder(),
    textEncoder: new TextEncoder(),
  });
  return async packed => {
    const trx = api.deserializeTransaction(hexToUint8Array(String(packed)));
    // one action at a time: an action whose ABI the node cannot serve must
    // not hide the others (checkProposal names it instead)
    const actions = [];
    for (const a of trx.actions || []) {
      try {
        actions.push((await api.deserializeActions([a]))[0]);
      } catch (e) {
        actions.push({
          ...a,
          decodeError: e && e.message ? e.message : 'decode failed',
        });
      }
    }
    return { ...trx, actions };
  };
}

/**
 * Run every check. No exit, no chain write; this module logs nothing itself
 * (the share service it constructs logs at the configured level — the CLI
 * sets LOGGER_LEVEL=error unless the operator chose otherwise).
 * @param {Object} opts
 * @param {Object} opts.config      the loaded config (property access)
 * @param {{get_info: Function, get_account: Function, get_table_rows: Function}} opts.rpc
 * @param {Object} [opts.env]       defaults to process.env
 * @param {Function} [opts.now]     ms clock, injectable
 * @param {Function} [opts.ShareKeyService]  injectable for tests
 * @param {{proposer: string, name: string}} [opts.proposal]  the pending eosio.msig switch to check against
 * @param {Function} [opts.decodeTransaction]  packed hex → { expiration, actions }, injectable for tests
 */
async function runConfigChecks({
  config,
  rpc,
  env = process.env,
  now = Date.now,
  ShareKeyService = require('./shareKeyService'),
  proposal = null,
  decodeTransaction,
}) {
  const report = new Report();
  checkRuntime(report, env);
  checkShape(report, config);
  const pub = checkSigningKey(report, config);
  const chainState = await checkChain(report, { config, rpc, pub, now });
  let proposed = null;
  if (proposal) {
    const outcome = await checkProposal(report, {
      config,
      rpc,
      proposal,
      decodeTransaction: decodeTransaction || createTransactionDecoder(rpc),
      now,
      chainState,
    });
    proposed = outcome.proposed;
    if (outcome.ownerAtIndex) {
      // an index that only matches after the switch is the expected
      // ORACLE_INDEX_MISMATCH crash loop, not a misconfiguration
      report.downgrade(
        'chain.oracleRow',
        'the proposed setoracles puts this account at the configured index; expected before the switch'
      );
    }
  }
  await checkShare(report, { config, chainState, ShareKeyService, proposed });
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
  parseProposalArg,
  Report,
};
