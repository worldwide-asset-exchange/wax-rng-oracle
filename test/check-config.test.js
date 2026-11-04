// --check-config dry run: validates a member host before the key ceremony
// without a share, and runs the share consistency check once SHARE_KEY_* are
// staged. Chain RPC is stubbed; the share tests use a throwaway 1024-bit key
// dealt here. Nothing in the report may ever echo a private value.
const { expect } = require('chai');
const sinon = require('sinon');
const os = require('os');
const path = require('path');
const { ThresholdRSAKey } = require('@waxio/rsa-threshold-signatures');
const { nameToUint64 } = require('eosjs-account-name');
const {
  runConfigChecks,
  formatReport,
  fingerprintModulus,
  derivePublicKey,
} = require('../lib/checkConfig');

const CHAIN_ID =
  '1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4';
const CONTRACT = 'orng.wax';
const OWNER = 'rng4.wax';
const ACTIVEVER = String(nameToUint64('activever'));
// The public Antelope development key (never a real credential).
const DEV_WIF = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const DEV_PUB_LEGACY = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';
const ENV = { NODE_ENV: 'production' };
const NOW = () => Date.parse('2026-11-04T12:00:00Z');

async function generateKeySet(bits = 1024, threshold = 2, numParties = 3) {
  const key = new ThresholdRSAKey({ bits });
  await key.generateKeyPair();
  const split = key.splitShares(threshold, numParties);
  const hex = v => v.toString(16);
  const publicKey = { n: hex(split.publicKey.n), e: hex(split.publicKey.e) };
  const member = i => ({
    publicKey,
    sharedKey: hex(split.sharedKey.shares[i - 1]),
    verificationKey: hex(split.sharedKey.v),
    verificationKeyShare: hex(split.sharedKey.verificationKeys[i - 1]),
    vku: hex(split.sharedKey.vku),
  });
  return { publicKey, members: [1, 2, 3].map(member) };
}

function baseConfig(overrides = {}) {
  return {
    readOnlyMode: false,
    clusterMode: false,
    shareKey: {
      threshold: '2',
      numParties: '3',
      bits: '4096',
      shareIndex: '1',
      publicKey: { n: '', e: '' },
      sharedKey: '',
      verificationKey: '',
      verificationKeyShare: '',
      vku: '',
    },
    metrics: { host: 'localhost', port: '8125', prefix: 'wax-rng-oracle' },
    eos: {
      chainId: CHAIN_ID,
      apiUrl: 'https://wax.example.net',
      orng: {
        nodeOwner: OWNER,
        contractName: CONTRACT,
        maxCpu: '100',
        privateKey: DEV_WIF,
        auth: 'rngops',
      },
    },
    db: { file: path.join(os.tmpdir(), 'check-config-test-db.json') },
    expressApp: { enable: true, port: '3000' },
    slackWebhook: '',
    ...overrides,
  };
}

function fakeRpc({
  chainId = CHAIN_ID,
  headAgeSeconds = 1,
  activeVer = 1,
  pubkeys = [],
  oracles = [],
  account,
  getInfoError,
} = {}) {
  const rows = {
    'config.a':
      activeVer === null ? [] : [{ name: ACTIVEVER, value: activeVer }],
    pubkeys,
    'oracles.a': oracles,
  };
  const keyField = {
    'config.a': 'name',
    pubkeys: 'ver',
    'oracles.a': 'oracle',
  };
  const headTime = new Date(NOW() - headAgeSeconds * 1000)
    .toISOString()
    .replace('Z', '');
  return {
    get_info: sinon.stub().callsFake(async () => {
      if (getInfoError) throw getInfoError;
      return { chain_id: chainId, head_block_time: headTime };
    }),
    get_account: sinon.stub().callsFake(async name => {
      if (account === null) throw new Error('unknown key');
      expect(name).to.equal(OWNER);
      return (
        account || {
          permissions: [
            {
              perm_name: 'rngops',
              parent: 'active',
              required_auth: {
                threshold: 1,
                keys: [{ key: DEV_PUB_LEGACY, weight: 1 }],
                accounts: [],
              },
            },
          ],
          cpu_limit: { available: 50000000 },
          net_limit: { available: 1000000 },
        }
      );
    }),
    get_table_rows: sinon.stub().callsFake(async params => {
      expect(params.code).to.equal(CONTRACT);
      const all = rows[params.table] || [];
      return {
        rows: all.filter(
          r => String(r[keyField[params.table]]) === String(params.lower_bound)
        ),
        more: false,
      };
    }),
  };
}

const byName = (report, name) => report.checks.filter(c => c.name === name);
const statusOf = (report, name) => byName(report, name).map(c => c.status);

describe('--check-config dry run', function() {
  this.timeout(60000);
  let keySet;
  before(async () => {
    keySet = await generateKeySet();
  });
  const pubkeyRow = (ver = 1, retired = false) => ({
    ver,
    modulus: keySet.publicKey.n,
    exponent: keySet.publicKey.e,
    retired,
  });

  describe('before the ceremony (no share, not registered)', () => {
    it('passes with the share skipped and the oracle row a warning', async () => {
      const report = await runConfigChecks({
        config: baseConfig(),
        rpc: fakeRpc({ pubkeys: [pubkeyRow()] }),
        env: ENV,
        now: NOW,
      });
      expect(report.passed, JSON.stringify(report.checks)).to.equal(true);
      expect(statusOf(report, 'share.configured')).to.deep.equal(['skip']);
      expect(statusOf(report, 'chain.oracleRow')).to.deep.equal(['warn']);
      expect(statusOf(report, 'account.permission')).to.deep.equal(['ok']);
      expect(byName(report, 'chain.activeKey')[0].detail).to.include(
        fingerprintModulus(keySet.publicKey.n)
      );
      expect(byName(report, 'signingKey.parses')[0].detail).to.include(
        DEV_PUB_LEGACY
      );
    });

    it('never echoes the private key in the report', async () => {
      const report = await runConfigChecks({
        config: baseConfig(),
        rpc: fakeRpc({ pubkeys: [pubkeyRow()] }),
        env: ENV,
        now: NOW,
      });
      const text =
        formatReport(report, { version: 'x' }) + JSON.stringify(report.checks);
      expect(text).to.not.include(DEV_WIF);
      expect(text).to.not.include(DEV_WIF.slice(0, 12));
    });
  });

  describe('hard failures', () => {
    it('NODE_ENV=test is refused', async () => {
      const report = await runConfigChecks({
        config: baseConfig(),
        rpc: fakeRpc({ pubkeys: [pubkeyRow()] }),
        env: { NODE_ENV: 'test' },
        now: NOW,
      });
      expect(statusOf(report, 'runtime.nodeEnv')).to.deep.equal(['fail']);
      expect(report.passed).to.equal(false);
    });

    it('chain id that does not match the node', async () => {
      const report = await runConfigChecks({
        config: baseConfig(),
        rpc: fakeRpc({ chainId: 'f'.repeat(64), pubkeys: [pubkeyRow()] }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'chain.chainId')).to.deep.equal(['fail']);
    });

    it('unreachable RPC fails once and skips the chain checks', async () => {
      const report = await runConfigChecks({
        config: baseConfig(),
        rpc: fakeRpc({ getInfoError: new Error('ECONNREFUSED') }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'chain.rpc')).to.deep.equal(['fail']);
      expect(statusOf(report, 'chain.activeKey')).to.deep.equal(['skip']);
      expect(statusOf(report, 'account.permission')).to.deep.equal(['skip']);
      expect(report.passed).to.equal(false);
    });

    it('signing key that does not parse', async () => {
      const config = baseConfig();
      config.eos.orng.privateKey = 'not-a-key';
      const report = await runConfigChecks({
        config,
        rpc: fakeRpc({ pubkeys: [pubkeyRow()] }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'signingKey.parses')).to.deep.equal(['fail']);
      expect(statusOf(report, 'account.permission')).to.deep.equal(['skip']);
      expect(JSON.stringify(report.checks)).to.not.include('not-a-key');
    });

    it('permission missing on the account', async () => {
      const config = baseConfig();
      config.eos.orng.auth = 'signing';
      const report = await runConfigChecks({
        config,
        rpc: fakeRpc({ pubkeys: [pubkeyRow()] }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'account.permission')).to.deep.equal(['fail']);
    });

    it('permission that does not carry the signing key', async () => {
      const account = {
        permissions: [
          {
            perm_name: 'rngops',
            parent: 'active',
            required_auth: {
              threshold: 1,
              keys: [
                {
                  key: 'EOS8QKJN1URiGhCwF3q6jFuYhcTpUBPbC7ZpZd86oWuCK5aVvy6Yq',
                  weight: 1,
                },
              ],
              accounts: [],
            },
          },
        ],
        cpu_limit: { available: 50000000 },
        net_limit: { available: 1000000 },
      };
      const report = await runConfigChecks({
        config: baseConfig(),
        rpc: fakeRpc({ pubkeys: [pubkeyRow()], account }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'account.permission')).to.deep.equal(['fail']);
    });

    it('share index that differs from the registered oracle_index', async () => {
      const report = await runConfigChecks({
        config: baseConfig(),
        rpc: fakeRpc({
          pubkeys: [pubkeyRow()],
          oracles: [
            { oracle: OWNER, oracle_index: 2, strikes: 0, suspended: 0 },
          ],
        }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'chain.oracleRow')).to.deep.equal(['fail']);
    });

    it('DB_FILE in a directory that does not exist', async () => {
      const config = baseConfig({
        db: {
          file: path.join(os.tmpdir(), 'no-such-dir-check-config', 'db.json'),
        },
      });
      const report = await runConfigChecks({
        config,
        rpc: fakeRpc({ pubkeys: [pubkeyRow()] }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'config.dbFile')).to.deep.equal(['fail']);
    });

    it('share parameters out of range', async () => {
      const config = baseConfig();
      config.shareKey.shareIndex = '4';
      const report = await runConfigChecks({
        config,
        rpc: fakeRpc({ pubkeys: [pubkeyRow()] }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'config.shareParams')).to.deep.equal(['fail']);
    });

    it('partially staged SHARE_KEY_* names the missing variables, not values', async () => {
      const config = baseConfig();
      config.shareKey.sharedKey = keySet.members[0].sharedKey;
      const report = await runConfigChecks({
        config,
        rpc: fakeRpc({ pubkeys: [pubkeyRow()] }),
        env: ENV,
        now: NOW,
      });
      const [c] = byName(report, 'share.configured');
      expect(c.status).to.equal('fail');
      expect(c.detail).to.include('SHARE_KEY_VKU');
      expect(JSON.stringify(report.checks)).to.not.include(
        keySet.members[0].sharedKey.slice(0, 16)
      );
    });
  });

  describe('warnings', () => {
    it('lagging node, low resources, active permission, slack URL shape', async () => {
      const config = baseConfig({ slackWebhook: 'https://example.com/hook' });
      config.eos.orng.auth = 'active';
      const account = {
        permissions: [
          {
            perm_name: 'active',
            parent: 'owner',
            required_auth: {
              threshold: 1,
              keys: [{ key: DEV_PUB_LEGACY, weight: 1 }],
              accounts: [],
            },
          },
        ],
        cpu_limit: { available: 1000 },
        net_limit: { available: 100 },
      };
      const report = await runConfigChecks({
        config,
        rpc: fakeRpc({ pubkeys: [pubkeyRow()], headAgeSeconds: 120, account }),
        env: ENV,
        now: NOW,
      });
      expect(report.passed, JSON.stringify(report.checks)).to.equal(true);
      expect(statusOf(report, 'chain.rpc')).to.deep.equal(['warn']);
      expect(statusOf(report, 'account.resources')).to.deep.equal(['warn']);
      expect(statusOf(report, 'config.permission')).to.deep.equal(['warn']);
      expect(statusOf(report, 'config.slackWebhook')).to.deep.equal(['warn']);
    });
  });

  describe('with a staged share', () => {
    const withShare = (i, bits = '1024') => {
      const config = baseConfig();
      config.shareKey = {
        ...config.shareKey,
        bits,
        shareIndex: String(i),
        ...keySet.members[i - 1],
      };
      return config;
    };

    it('matches the active on-chain key and the registered index', async () => {
      const report = await runConfigChecks({
        config: withShare(2),
        rpc: fakeRpc({
          pubkeys: [pubkeyRow()],
          oracles: [
            { oracle: OWNER, oracle_index: 2, strikes: 0, suspended: 0 },
          ],
        }),
        env: ENV,
        now: NOW,
      });
      expect(report.passed, JSON.stringify(report.checks)).to.equal(true);
      expect(statusOf(report, 'share.parses')).to.deep.equal(['ok']);
      expect(statusOf(report, 'share.consistent')).to.deep.equal(['ok']);
      expect(statusOf(report, 'config.shareParams')).to.deep.equal([
        'ok',
        'warn',
      ]); // 1024-bit
    });

    it('a share for a key the chain does not have fails the consistency check', async () => {
      const other = await generateKeySet();
      const report = await runConfigChecks({
        config: withShare(1),
        rpc: fakeRpc({
          pubkeys: [
            {
              ver: 1,
              modulus: other.publicKey.n,
              exponent: other.publicKey.e,
              retired: false,
            },
          ],
        }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'share.consistent')).to.deep.equal(['fail']);
      expect(report.passed).to.equal(false);
    });

    it('is skipped, not failed, when the chain has no active key to compare', async () => {
      const report = await runConfigChecks({
        config: withShare(1),
        rpc: fakeRpc({ activeVer: null }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'chain.activeKey')).to.deep.equal(['fail']);
      expect(statusOf(report, 'share.consistent')).to.deep.equal(['skip']);
    });

    it('never echoes share material', async () => {
      const report = await runConfigChecks({
        config: withShare(1),
        rpc: fakeRpc({ pubkeys: [pubkeyRow()] }),
        env: ENV,
        now: NOW,
      });
      const text = formatReport(report) + JSON.stringify(report.checks);
      for (const f of [
        'sharedKey',
        'verificationKeyShare',
        'vku',
        'verificationKey',
      ]) {
        expect(text, f).to.not.include(keySet.members[0][f].slice(0, 16));
      }
    });
  });

  describe('helpers', () => {
    it('derivePublicKey gives both spellings', () => {
      const pub = derivePublicKey(DEV_WIF);
      expect(pub.legacy).to.equal(DEV_PUB_LEGACY);
      expect(pub.k1).to.match(/^PUB_K1_/);
    });

    it('fingerprint is sha256 of the lower-case modulus', () => {
      expect(fingerprintModulus('ABCD')).to.equal(fingerprintModulus('abcd'));
      expect(fingerprintModulus('abcd')).to.match(/^[0-9a-f]{64}$/);
    });

    it('formatReport ends with the exit verdict', async () => {
      const report = await runConfigChecks({
        config: baseConfig(),
        rpc: fakeRpc({ pubkeys: [pubkeyRow()] }),
        env: ENV,
        now: NOW,
      });
      const text = formatReport(report, { version: '7.3.0' });
      expect(text).to.include('(7.3.0)');
      expect(text).to.include('No transaction was pushed');
      expect(text).to.include('0 FAIL');
    });
  });
});
