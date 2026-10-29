// Boot self-check (ORC-3 / SIG-5): the member refuses to start unless its share
// is consistent with the on-chain pubkeys row for the active version. The chain
// RPC is mocked; the key set is a throwaway 2-of-3 / 1024-bit key generated
// here (fast) with the library's own dealer.
const { expect } = require('chai');
const sinon = require('sinon');
const { ThresholdRSAKey } = require('@waxio/rsa-threshold-signatures');
const { nameToUint64 } = require('eosjs-account-name');
const ShareKeyService = require('../lib/shareKeyService');
const {
  runBootChecks,
  fetchActivePublicKey,
  getBootCheckStatus,
  resetBootCheckStatus,
  assertRuntimeEnv,
  BootCheckError,
} = require('../lib/bootChecks');

const CONTRACT = 'orng.wax';
const ACTIVEVER = String(nameToUint64('activever'));
const BITS = 1024;

async function generateKeySet(bits, threshold, numParties) {
  const key = new ThresholdRSAKey({ bits });
  await key.generateKeyPair();
  const split = key.splitShares(threshold, numParties);
  const hex = v => v.toString(16);
  const publicKey = { n: hex(split.publicKey.n), e: hex(split.publicKey.e) };
  const member = i => ({
    threshold,
    numParties,
    bits,
    shareIndex: i,
    publicKey,
    sharedKey: hex(split.sharedKey.shares[i - 1]),
    verificationKey: hex(split.sharedKey.v),
    verificationKeyShare: hex(split.sharedKey.verificationKeys[i - 1]),
    vku: hex(split.sharedKey.vku),
  });
  return { publicKey, members: [1, 2, 3].map(member) };
}

/** A fake get_table_rows serving config.a + pubkeys like nodeos (json: true). */
// activeVer: null → no 'activever' row in config.a
function fakeRpc({ activeVer = 1, pubkeys } = {}) {
  const rows = {
    'config.a':
      activeVer === null ? [] : [{ name: ACTIVEVER, value: activeVer }],
    pubkeys: pubkeys || [],
  };
  return {
    get_table_rows: sinon.stub().callsFake(async params => {
      expect(params.code).to.equal(CONTRACT);
      const all = rows[params.table] || [];
      const key = params.table === 'config.a' ? 'name' : 'ver';
      return {
        rows: all.filter(r => String(r[key]) === String(params.lower_bound)),
        more: false,
      };
    }),
  };
}

const pubkeyRow = (publicKey, ver = 1, retired = false) => ({
  ver,
  pubkey_hash_id: 0,
  exponent: publicKey.e,
  modulus: publicKey.n,
  retired,
});

async function service(config) {
  const svc = new ShareKeyService(config);
  await svc.initialize();
  return svc;
}

describe('boot self-check', function() {
  this.timeout(30000);
  let keySet;
  let otherKeySet;
  const noSleep = async () => {};

  before(async () => {
    keySet = await generateKeySet(BITS, 2, 3);
    otherKeySet = await generateKeySet(BITS, 2, 3);
  });

  beforeEach(() => resetBootCheckStatus());

  it('passes for a consistent member and remembers booleans for /health-check', async () => {
    const rpc = fakeRpc({ pubkeys: [pubkeyRow(keySet.publicKey)] });
    const status = await runBootChecks({
      shareKeyService: await service(keySet.members[1]),
      rpc,
      contractName: CONTRACT,
      sleep: noSleep,
    });
    expect(status.ok).to.equal(true);
    expect(status.failedChecks).to.deep.equal([]);
    expect(getBootCheckStatus()).to.deep.equal({
      ran: true,
      ok: true,
      rpcReachable: true,
      activeKeyFound: true,
      shareConsistent: true,
      activeVer: 1,
    });
    // no value from the share config or the chain row leaks into the status
    expect(JSON.stringify(getBootCheckStatus())).to.not.include(
      keySet.publicKey.n.slice(0, 16)
    );
  });

  it('reads the pubkeys row for the ACTIVE version, not the first one', async () => {
    const rpc = fakeRpc({
      activeVer: 2,
      pubkeys: [
        pubkeyRow(otherKeySet.publicKey, 1, true),
        pubkeyRow(keySet.publicKey, 2),
      ],
    });
    const onChain = await fetchActivePublicKey(rpc, CONTRACT);
    expect(onChain.ver).to.equal(2);
    expect(onChain.modulus).to.equal(keySet.publicKey.n);
    const status = await runBootChecks({
      shareKeyService: await service(keySet.members[0]),
      rpc,
      contractName: CONTRACT,
      sleep: noSleep,
    });
    expect(status.ok).to.equal(true);
    expect(status.activeVer).to.equal(2);
  });

  it('refuses a wrong share (share of member 2 configured as member 1)', async () => {
    const mixed = {
      ...keySet.members[0],
      sharedKey: keySet.members[1].sharedKey,
    };
    const status = await runBootChecks({
      shareKeyService: await service(mixed),
      rpc: fakeRpc({ pubkeys: [pubkeyRow(keySet.publicKey)] }),
      contractName: CONTRACT,
      sleep: noSleep,
    });
    expect(status.ok).to.equal(false);
    expect(status.shareConsistent).to.equal(false);
    expect(status.failedChecks).to.include('verificationKeyShare');
  });

  it('refuses a wrong index (verification key share of another member)', async () => {
    const wrongIndex = {
      ...keySet.members[0],
      shareIndex: 2,
      verificationKeyShare: keySet.members[1].verificationKeyShare,
    };
    const status = await runBootChecks({
      shareKeyService: await service(wrongIndex),
      rpc: fakeRpc({ pubkeys: [pubkeyRow(keySet.publicKey)] }),
      contractName: CONTRACT,
      sleep: noSleep,
    });
    expect(status.ok).to.equal(false);
    expect(status.failedChecks).to.include('verificationKeyShare');
  });

  it('refuses when the on-chain modulus differs from the local public key', async () => {
    const status = await runBootChecks({
      shareKeyService: await service(keySet.members[0]),
      rpc: fakeRpc({ pubkeys: [pubkeyRow(otherKeySet.publicKey)] }),
      contractName: CONTRACT,
      sleep: noSleep,
    });
    expect(status.ok).to.equal(false);
    expect(status.rpcReachable).to.equal(true);
    expect(status.activeKeyFound).to.equal(true);
    expect(status.shareConsistent).to.equal(false);
    expect(status.failedChecks).to.deep.equal(['expectedPublicKey']);
  });

  it('refuses when the on-chain exponent differs', async () => {
    const row = pubkeyRow(keySet.publicKey);
    row.exponent = '3';
    const status = await runBootChecks({
      shareKeyService: await service(keySet.members[0]),
      rpc: fakeRpc({ pubkeys: [row] }),
      contractName: CONTRACT,
      sleep: noSleep,
    });
    expect(status.ok).to.equal(false);
    expect(status.failedChecks).to.deep.equal(['expectedPublicKey']);
  });

  it('refuses when the on-chain modulus is not the full width (truncated / unpadded row)', async () => {
    const row = pubkeyRow(keySet.publicKey);
    row.modulus = keySet.publicKey.n.replace(/^0+/, '').slice(1);
    const status = await runBootChecks({
      shareKeyService: await service(keySet.members[0]),
      rpc: fakeRpc({ pubkeys: [row] }),
      contractName: CONTRACT,
      sleep: noSleep,
    });
    expect(status.ok).to.equal(false);
    expect(status.failedChecks).to.deep.equal(['expectedPublicKey']);
  });

  it('fails closed when the active key row is missing or retired (no retry)', async () => {
    for (const rpc of [
      fakeRpc({ pubkeys: [] }),
      fakeRpc({ pubkeys: [pubkeyRow(keySet.publicKey, 1, true)] }),
      fakeRpc({ activeVer: null, pubkeys: [pubkeyRow(keySet.publicKey)] }),
    ]) {
      const status = await runBootChecks({
        shareKeyService: await service(keySet.members[0]),
        rpc,
        contractName: CONTRACT,
        retry: { attempts: 4 },
        sleep: noSleep,
      });
      expect(status.ok).to.equal(false);
      expect(status.rpcReachable).to.equal(true);
      expect(status.activeKeyFound).to.equal(false);
      expect(status.failedChecks).to.have.length(1);
      expect(status.failedChecks[0]).to.match(/^ACTIVE_(KEY|VERSION)_/);
      // deterministic chain state is not retried
      expect(rpc.get_table_rows.callCount).to.be.at.most(2);
    }
  });

  it('retries a bounded number of times with backoff when the RPC is unreachable, then fails closed', async () => {
    const rpc = {
      get_table_rows: sinon.stub().rejects(new Error('ECONNREFUSED')),
    };
    const sleep = sinon.stub().resolves();
    const status = await runBootChecks({
      shareKeyService: await service(keySet.members[0]),
      rpc,
      contractName: CONTRACT,
      retry: { attempts: 4, baseDelayMs: 10, maxDelayMs: 25 },
      sleep,
    });
    expect(status.ok).to.equal(false);
    expect(status.rpcReachable).to.equal(false);
    expect(status.failedChecks).to.deep.equal(['RPC_UNREACHABLE']);
    expect(rpc.get_table_rows.callCount).to.equal(4);
    expect(sleep.args.map(a => a[0])).to.deep.equal([10, 20, 25]);
    expect(getBootCheckStatus().ok).to.equal(false);
  });

  it('recovers when the RPC comes back within the retry budget', async () => {
    const good = fakeRpc({ pubkeys: [pubkeyRow(keySet.publicKey)] });
    const flaky = {
      get_table_rows: sinon
        .stub()
        .onFirstCall()
        .rejects(new Error('ETIMEDOUT'))
        .callsFake(good.get_table_rows),
    };
    const status = await runBootChecks({
      shareKeyService: await service(keySet.members[0]),
      rpc: flaky,
      contractName: CONTRACT,
      retry: { attempts: 3, baseDelayMs: 1 },
      sleep: noSleep,
    });
    expect(status.ok).to.equal(true);
  });

  it('ignores unusable retry settings (NaN from env) and uses the defaults', async () => {
    const rpc = {
      get_table_rows: sinon.stub().rejects(new Error('ECONNREFUSED')),
    };
    const sleep = sinon.stub().resolves();
    const status = await runBootChecks({
      shareKeyService: await service(keySet.members[0]),
      rpc,
      contractName: CONTRACT,
      retry: { attempts: NaN, baseDelayMs: NaN },
      sleep,
    });
    expect(status.ok).to.equal(false);
    expect(rpc.get_table_rows.callCount).to.equal(6);
    expect(sleep.firstCall.args[0]).to.equal(2000);
  });

  it('exposes BootCheckError codes for unusable chain state', async () => {
    let err;
    try {
      await fetchActivePublicKey(fakeRpc({ pubkeys: [] }), CONTRACT);
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(BootCheckError);
    expect(err.code).to.equal('ACTIVE_KEY_MISSING');
  });

  describe('assertRuntimeEnv', () => {
    it('refuses NODE_ENV=test', () => {
      expect(() => assertRuntimeEnv('test')).to.throw(/NODE_ENV=test/);
    });
    it('accepts production / staging / unset', () => {
      for (const env of ['production', 'staging', 'local1', undefined]) {
        expect(() => assertRuntimeEnv(env)).to.not.throw();
      }
    });
  });
});
