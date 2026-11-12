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
  parseProposalArg,
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
  proposals = {}, // proposer → [{ proposal_name, packed_transaction }]
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
      if (params.code === 'eosio.msig') {
        expect(params.table).to.equal('proposal');
        const mine = (proposals[params.scope] || []).filter(
          r => r.proposal_name === params.lower_bound
        );
        return { rows: mine, more: false };
      }
      expect(params.code).to.equal(CONTRACT);
      const all = rows[params.table] || [];
      if (params.lower_bound === undefined) return { rows: all, more: false };
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

  describe('--proposal: the pending eosio.msig switch', () => {
    const PROPOSER = 'admin2.wax';
    const NAME = 'rng.switch';
    const NEW_LIST = ['eosphereiobp', OWNER, 'waxswedenorg'];
    const act = (name, data) => ({
      account: CONTRACT,
      name,
      authorization: [{ actor: CONTRACT, permission: 'active' }],
      data,
    });
    // A decoded switch transaction built around the test key set (keySet =
    // the proposed key, `old` = what the chain still carries).
    const switchTrx = ({
      modulus = keySet.publicKey.n,
      exponent = '10001',
      version = 2,
      oracles = NEW_LIST,
      expiration = '2026-11-11T12:00:00.000',
      tail = [act('pauserequest', { paused: false })],
      extra = [],
    } = {}) => ({
      expiration,
      actions: [
        act('setstipend', { oracle: 'rng1.wax', active: false }),
        act('setpubkey', { version, exponent, modulus }),
        act('setoracles', { oracles }),
        ...extra,
        ...tail,
      ],
    });
    const PACKED = 'deadbeef';
    const rpcWith = (decoded, more = {}) =>
      fakeRpc({
        pubkeys: more.pubkeys || [],
        oracles: more.oracles || [],
        headAgeSeconds: more.headAgeSeconds,
        proposals: {
          [PROPOSER]: [{ proposal_name: NAME, packed_transaction: PACKED }],
        },
      });
    const run = (config, decoded, more = {}) =>
      runConfigChecks({
        config,
        rpc: rpcWith(decoded, more),
        env: ENV,
        now: NOW,
        proposal: { proposer: PROPOSER, name: NAME },
        decodeTransaction: async packed => {
          expect(packed).to.equal(PACKED);
          return decoded;
        },
      });
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
    let old;
    let third; // a key nobody holds a share of and the chain does not carry
    before(async () => {
      old = await generateKeySet();
      third = await generateKeySet();
    });
    const oldRow = () => ({
      ver: 1,
      modulus: old.publicKey.n,
      exponent: old.publicKey.e,
      retired: false,
    });

    it('a correctly staged member passes: share matches the proposed key, chain mismatch is a warning', async () => {
      const report = await run(withShare(2), switchTrx(), {
        pubkeys: [oldRow()],
      });
      expect(report.passed, JSON.stringify(report.checks)).to.equal(true);
      expect(statusOf(report, 'proposal.found')).to.deep.equal(['ok']);
      expect(statusOf(report, 'proposal.actions')).to.deep.equal(['ok']);
      expect(statusOf(report, 'proposal.setpubkey')).to.deep.equal(['ok']);
      expect(byName(report, 'proposal.setpubkey')[0].detail).to.include(
        fingerprintModulus(keySet.publicKey.n)
      );
      expect(statusOf(report, 'proposal.setoracles')).to.deep.equal(['ok']);
      expect(statusOf(report, 'proposal.unpause')).to.deep.equal(['ok']);
      expect(statusOf(report, 'share.consistent')).to.deep.equal(['warn']);
      expect(byName(report, 'share.consistent')[0].detail).to.include(
        'pubkeys[2]'
      );
      expect(statusOf(report, 'share.consistentProposed')).to.deep.equal([
        'ok',
      ]);
      expect(statusOf(report, 'chain.oracleRow')).to.deep.equal(['warn']);
    });

    it('without the proposal the same member still fails share.consistent (unchanged behaviour)', async () => {
      const report = await runConfigChecks({
        config: withShare(2),
        rpc: fakeRpc({ pubkeys: [oldRow()] }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'share.consistent')).to.deep.equal(['fail']);
      expect(byName(report, 'proposal.found')).to.have.length(0);
      expect(byName(report, 'share.consistentProposed')).to.have.length(0);
    });

    it('a share for a different key than the proposed one fails both comparisons', async () => {
      const report = await run(
        withShare(2),
        switchTrx({ modulus: third.publicKey.n }),
        {
          pubkeys: [oldRow()],
        }
      );
      expect(statusOf(report, 'proposal.setpubkey')).to.deep.equal(['fail']);
      expect(byName(report, 'proposal.setpubkey')[0].detail).to.include(
        'different key'
      );
      expect(statusOf(report, 'share.consistentProposed')).to.deep.equal([
        'fail',
      ]);
      // the staged share matches neither the chain key nor the proposed one
      expect(statusOf(report, 'share.consistent')).to.deep.equal(['fail']);
      expect(report.passed).to.equal(false);
    });

    it('wrong index: the account is in the proposed list at another position', async () => {
      const report = await run(withShare(1), switchTrx(), {
        pubkeys: [oldRow()],
      });
      expect(statusOf(report, 'proposal.setoracles')).to.deep.equal(['fail']);
      expect(byName(report, 'proposal.setoracles')[0].detail).to.include(
        'position 2'
      );
      expect(report.passed).to.equal(false);
    });

    it('account missing from the proposed list', async () => {
      const report = await run(
        withShare(2),
        switchTrx({
          oracles: ['eosphereiobp', 'ivote4waxusa', 'waxswedenorg'],
        }),
        { pubkeys: [oldRow()] }
      );
      expect(statusOf(report, 'proposal.setoracles')).to.deep.equal(['fail']);
      expect(byName(report, 'proposal.setoracles')[0].detail).to.include(
        'not in the proposed list'
      );
    });

    it('no share staged: the proposal is described, the comparison skipped', async () => {
      const config = baseConfig();
      config.shareKey.shareIndex = '2';
      config.shareKey.bits = '1024'; // the test key; a size mismatch is a failure
      const report = await run(config, switchTrx(), { pubkeys: [oldRow()] });
      expect(statusOf(report, 'proposal.setpubkey')).to.deep.equal(['skip']);
      expect(byName(report, 'proposal.setpubkey')[0].detail).to.include(
        fingerprintModulus(keySet.publicKey.n)
      );
      expect(statusOf(report, 'proposal.setoracles')).to.deep.equal(['ok']);
      expect(byName(report, 'share.consistentProposed')).to.have.length(0);
      expect(report.passed, JSON.stringify(report.checks)).to.equal(true);
    });

    it('missing proposal is a failure and nothing else is reported about it', async () => {
      const report = await runConfigChecks({
        config: withShare(2),
        rpc: fakeRpc({ pubkeys: [oldRow()] }),
        env: ENV,
        now: NOW,
        proposal: { proposer: PROPOSER, name: 'rng.other' },
        decodeTransaction: async () => {
          throw new Error('must not be called');
        },
      });
      expect(statusOf(report, 'proposal.found')).to.deep.equal(['fail']);
      expect(byName(report, 'proposal.found')[0].detail).to.include(
        'rng.other'
      );
      expect(byName(report, 'proposal.setpubkey')).to.have.length(0);
      expect(statusOf(report, 'share.consistent')).to.deep.equal(['fail']);
    });

    it('expired proposal is a failure', async () => {
      const report = await run(
        withShare(2),
        switchTrx({ expiration: '2026-11-04T11:59:59.000' }),
        { pubkeys: [oldRow()] }
      );
      expect(statusOf(report, 'proposal.found')).to.deep.equal(['fail']);
      expect(byName(report, 'proposal.found')[0].detail).to.include('expired');
    });

    it('decode failure is a failure that names the cause', async () => {
      const report = await runConfigChecks({
        config: withShare(2),
        rpc: rpcWith(null, { pubkeys: [oldRow()] }),
        env: ENV,
        now: NOW,
        proposal: { proposer: PROPOSER, name: NAME },
        decodeTransaction: async () => {
          throw new Error('abi not found');
        },
      });
      expect(statusOf(report, 'proposal.found')).to.deep.equal(['fail']);
      expect(byName(report, 'proposal.found')[0].detail).to.include(
        'abi not found'
      );
    });

    it('an action on another contract fails the proposal', async () => {
      const report = await run(
        withShare(2),
        switchTrx({
          extra: [
            {
              account: 'eosio.token',
              name: 'transfer',
              authorization: [],
              data: {},
            },
          ],
        }),
        { pubkeys: [oldRow()] }
      );
      expect(statusOf(report, 'proposal.actions')).to.deep.equal(['fail']);
      expect(byName(report, 'proposal.actions')[0].detail).to.include(
        'eosio.token::transfer'
      );
    });

    it('bad setpubkey shapes fail: exponent, upper-case hex, size', async () => {
      for (const bad of [
        { exponent: '3' },
        { modulus: keySet.publicKey.n.toUpperCase() },
        { modulus: keySet.publicKey.n.slice(2) },
      ]) {
        const report = await run(withShare(2), switchTrx(bad), {
          pubkeys: [oldRow()],
        });
        expect(
          statusOf(report, 'proposal.setpubkey'),
          JSON.stringify(bad).slice(0, 40)
        ).to.deep.equal(['fail']);
      }
    });

    it('a proposal that does not end with pauserequest(false) is a warning', async () => {
      const report = await run(withShare(2), switchTrx({ tail: [] }), {
        pubkeys: [oldRow()],
      });
      expect(statusOf(report, 'proposal.unpause')).to.deep.equal(['warn']);
      expect(report.passed, JSON.stringify(report.checks)).to.equal(true);
    });

    it('never echoes share material with the proposal checks on', async () => {
      const report = await run(withShare(2), switchTrx(), {
        pubkeys: [oldRow()],
      });
      const text = formatReport(report) + JSON.stringify(report.checks);
      for (const f of ['sharedKey', 'verificationKeyShare', 'vku']) {
        expect(text, f).to.not.include(keySet.members[1][f].slice(0, 16));
      }
    });

    it('an existing member whose index moves: chain.oracleRow becomes a warning', async () => {
      const report = await run(withShare(2), switchTrx(), {
        pubkeys: [oldRow()],
        oracles: [{ oracle: OWNER, oracle_index: 1, strikes: 0, suspended: 0 }],
      });
      expect(statusOf(report, 'chain.oracleRow')).to.deep.equal(['warn']);
      expect(byName(report, 'chain.oracleRow')[0].detail).to.include(
        'ORACLE_INDEX_MISMATCH'
      );
      expect(report.passed, JSON.stringify(report.checks)).to.equal(true);
    });

    it('an index that matches neither the chain nor the proposal stays a failure', async () => {
      const report = await run(withShare(3), switchTrx(), {
        pubkeys: [oldRow()],
        oracles: [{ oracle: OWNER, oracle_index: 1, strikes: 0, suspended: 0 }],
      });
      expect(statusOf(report, 'chain.oracleRow')).to.deep.equal(['fail']);
      expect(statusOf(report, 'proposal.setoracles')).to.deep.equal(['fail']);
    });

    it('key-only proposal: fine for a member registered at its index, a failure otherwise', async () => {
      const noOracles = switchTrx();
      noOracles.actions = noOracles.actions.filter(
        a => a.name !== 'setoracles'
      );
      const registered = await run(withShare(2), noOracles, {
        pubkeys: [oldRow()],
        oracles: [{ oracle: OWNER, oracle_index: 2, strikes: 0, suspended: 0 }],
      });
      expect(statusOf(registered, 'proposal.setoracles')).to.deep.equal([
        'warn',
      ]);
      expect(registered.passed, JSON.stringify(registered.checks)).to.equal(
        true
      );
      const unregistered = await run(withShare(2), noOracles, {
        pubkeys: [oldRow()],
      });
      expect(statusOf(unregistered, 'proposal.setoracles')).to.deep.equal([
        'fail',
      ]);
      expect(byName(unregistered, 'proposal.setoracles')[0].detail).to.include(
        'not in oracles.a'
      );
    });

    it('setpubkey must be the next version and a new modulus', async () => {
      const wrongVer = await run(withShare(2), switchTrx({ version: 3 }), {
        pubkeys: [oldRow()],
      });
      expect(statusOf(wrongVer, 'proposal.setpubkey')).to.deep.equal(['fail']);
      expect(byName(wrongVer, 'proposal.setpubkey')[0].detail).to.include(
        'requires 2'
      );
      const reinstall = await run(
        withShare(2),
        switchTrx({ modulus: old.publicKey.n }),
        { pubkeys: [oldRow()] }
      );
      expect(byName(reinstall, 'proposal.setpubkey')[0].detail).to.include(
        'already installed as pubkeys[1]'
      );
      // the highest version counts, retired or not
      const retiredHigher = await run(withShare(2), switchTrx({ version: 2 }), {
        pubkeys: [
          oldRow(),
          { ...oldRow(), ver: 3, retired: true, modulus: 'ab' },
        ],
      });
      expect(byName(retiredHigher, 'proposal.setpubkey')[0].detail).to.include(
        'requires 4'
      );
    });

    it('setoracles list must have numParties distinct members', async () => {
      const four = await run(
        withShare(2),
        switchTrx({ oracles: [...NEW_LIST, 'fourth.wax'] }),
        { pubkeys: [oldRow()] }
      );
      expect(statusOf(four, 'proposal.setoracles')).to.deep.equal(['fail']);
      expect(byName(four, 'proposal.setoracles')[0].detail).to.include(
        'does not fit'
      );
      const dup = await run(
        withShare(2),
        switchTrx({ oracles: ['eosphereiobp', OWNER, OWNER] }),
        { pubkeys: [oldRow()] }
      );
      expect(byName(dup, 'proposal.setoracles')[0].detail).to.include('twice');
    });

    it('an action not authorised by the contract, or not decodable, fails proposal.actions', async () => {
      const trx = switchTrx();
      trx.actions[1].authorization = [
        { actor: 'admin2.wax', permission: 'active' },
      ];
      const unauth = await run(withShare(2), trx, { pubkeys: [oldRow()] });
      expect(statusOf(unauth, 'proposal.actions')).to.deep.equal(['fail']);
      expect(byName(unauth, 'proposal.actions')[0].detail).to.include(
        'not authorised by orng.wax: orng.wax::setpubkey'
      );
      expect(byName(unauth, 'proposal.setpubkey')).to.have.length(0);
      const trx2 = switchTrx();
      trx2.actions[0].decodeError = 'abi missing';
      const undec = await run(withShare(2), trx2, { pubkeys: [oldRow()] });
      expect(byName(undec, 'proposal.actions')[0].detail).to.include(
        'abi missing'
      );
    });

    it('a missing proposal on a lagging node is a warning', async () => {
      const report = await runConfigChecks({
        config: withShare(2),
        rpc: fakeRpc({ pubkeys: [oldRow()], headAgeSeconds: 400 }),
        env: ENV,
        now: NOW,
        proposal: { proposer: PROPOSER, name: NAME },
        decodeTransaction: async () => {
          throw new Error('must not be called');
        },
      });
      expect(statusOf(report, 'proposal.found')).to.deep.equal(['warn']);
      expect(byName(report, 'proposal.found')[0].detail).to.include('lagging');
    });

    it('parseProposalArg: a blank CHECK_PROPOSAL means unset', () => {
      expect(parseProposalArg([], { CHECK_PROPOSAL: '' })).to.equal(null);
      expect(parseProposalArg([], { CHECK_PROPOSAL: '  ' })).to.equal(null);
    });

    it('parseProposalArg: flag, flag=value, env, none, malformed', () => {
      expect(
        parseProposalArg(['--proposal', 'admin2.wax/rng.switch'], {})
      ).to.deep.equal({
        proposer: 'admin2.wax',
        name: 'rng.switch',
      });
      expect(
        parseProposalArg(
          ['--check-config', '--proposal=admin2.wax/rng.switch'],
          {}
        )
      ).to.deep.equal({ proposer: 'admin2.wax', name: 'rng.switch' });
      expect(
        parseProposalArg([], { CHECK_PROPOSAL: 'admin2.wax/rng.switch' })
      ).to.deep.equal({ proposer: 'admin2.wax', name: 'rng.switch' });
      expect(parseProposalArg(['--check-config'], {})).to.equal(null);
      for (const bad of ['rng.switch', 'Admin/rng.switch', 'a/b/c', '--x']) {
        expect(() => parseProposalArg(['--proposal', bad], {}), bad).to.throw(
          /proposer\/name/
        );
      }
      expect(parseProposalArg(['--proposal'], {})).to.equal(null); // no value = unset
    });
  });

  describe('accepts what the service accepts', () => {
    it('13-character account names, EOS_ORNG_MAX_CPU=0, upper-case chain id', async () => {
      const config = baseConfig();
      config.eos.orng.contractName = 'abcdefghijkl1';
      config.eos.orng.maxCpu = '0';
      config.eos.chainId = CHAIN_ID.toUpperCase();
      const report = await runConfigChecks({
        config,
        rpc: fakeRpc({ pubkeys: [pubkeyRow()] }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'config.accounts')).to.deep.equal(['ok']);
      expect(statusOf(report, 'config.maxCpu')).to.deep.equal(['ok']);
      expect(statusOf(report, 'config.chainId')).to.deep.equal(['ok']);
      expect(statusOf(report, 'chain.chainId')).to.deep.equal(['ok']);
    });

    it('EOS_ORNG_MAX_CPU above 150 is a warning, a non-integer a failure', async () => {
      const config = baseConfig();
      config.eos.orng.maxCpu = '200';
      let report = await runConfigChecks({
        config,
        rpc: fakeRpc({ pubkeys: [pubkeyRow()] }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'config.maxCpu')).to.deep.equal(['warn']);
      config.eos.orng.maxCpu = 'lots';
      report = await runConfigChecks({
        config,
        rpc: fakeRpc({ pubkeys: [pubkeyRow()] }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'config.maxCpu')).to.deep.equal(['fail']);
    });

    it('unlimited resources (-1) are not "little available"', async () => {
      const account = {
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
        cpu_limit: { used: -1, available: -1, max: -1 },
        net_limit: { used: -1, available: -1, max: -1 },
      };
      const report = await runConfigChecks({
        config: baseConfig(),
        rpc: fakeRpc({ pubkeys: [pubkeyRow()], account }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'account.resources')).to.deep.equal(['ok']);
      expect(byName(report, 'account.resources')[0].detail).to.include(
        'unlimited'
      );
    });

    it('a permission satisfied through delegated accounts is a warning, not a failure', async () => {
      const account = {
        permissions: [
          {
            perm_name: 'rngops',
            parent: 'active',
            required_auth: {
              threshold: 1,
              keys: [],
              accounts: [
                {
                  permission: { actor: OWNER, permission: 'signer' },
                  weight: 1,
                },
              ],
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
      expect(statusOf(report, 'account.permission')).to.deep.equal(['warn']);
    });

    it('rows missing on a lagging node are a warning, not a failure', async () => {
      const report = await runConfigChecks({
        config: baseConfig(),
        rpc: fakeRpc({ activeVer: null, headAgeSeconds: 400 }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'chain.rpc')).to.deep.equal(['warn']);
      expect(statusOf(report, 'chain.activeKey')).to.deep.equal(['warn']);
      expect(statusOf(report, 'chain.oracleRow')).to.deep.equal(['warn']);
      expect(report.passed).to.equal(true);
    });

    it('rows missing on a synced node are failures', async () => {
      const report = await runConfigChecks({
        config: baseConfig(),
        rpc: fakeRpc({ activeVer: null }),
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'chain.activeKey')).to.deep.equal(['fail']);
    });

    it('head_block_time that already carries a zone still yields a lag', async () => {
      const rpc = fakeRpc({ pubkeys: [pubkeyRow()], headAgeSeconds: 100 });
      const plain = rpc.get_info;
      rpc.get_info = async () => {
        const info = await plain();
        return { ...info, head_block_time: `${info.head_block_time}Z` };
      };
      const report = await runConfigChecks({
        config: baseConfig(),
        rpc,
        env: ENV,
        now: NOW,
      });
      expect(statusOf(report, 'chain.rpc')).to.deep.equal(['warn']);
      expect(byName(report, 'chain.rpc')[0].detail).to.include('100 s');
    });

    it('fetch failures print the cause', async () => {
      const err = new Error('fetch failed');
      err.cause = Object.assign(
        new Error('getaddrinfo ENOTFOUND wax.example.net'),
        { code: 'ENOTFOUND' }
      );
      const report = await runConfigChecks({
        config: baseConfig(),
        rpc: fakeRpc({ getInfoError: err }),
        env: ENV,
        now: NOW,
      });
      expect(byName(report, 'chain.rpc')[0].detail).to.include('ENOTFOUND');
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
