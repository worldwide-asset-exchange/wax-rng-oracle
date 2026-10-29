// Combine path with poisoned / malformed partials (ORC-1, SIG-4, SIG-13) —
// no chain needed: parts are built exactly as the contract stores them in
// reqs.parts[] ({idx, sig_i}) and fed to ShareKeyService.combinePartialSignatures
// and to Poller.pollJobsToExecute with the job service / pusher stubbed.
//
// Fail-on-pre-fix: against 762a514 (library 1.3.0) the "poisoned zero" case
// throws `Intermediate verify signature is invalid` instead of completing with
// the two good parts; see the WBP-2067 report.
const { expect } = require('chai');
const sinon = require('sinon');
const ShareKeyService = require('../lib/shareKeyService');
const Poller = require('../lib/poller');
const Storage = require('../lib/storage');
const { shareKey1, shareKey2, shareKey3 } = require('./fixtures/testShareKeys');

const { partsFingerprint } = Storage;

// a partial is "well-formed on chain" when it is a hex string; the library then
// decides whether it is a usable share
function sigHex(signResult) {
  return signResult.signatureShare.toString(16);
}

// the pre-fix combine returned the hex string; the new one returns CombineResult
function signatureOf(result) {
  return typeof result === 'string' ? result : result.signature;
}

describe('combine partial signatures (reqs.parts → setrand sig)', function() {
  this.timeout(60000);

  const services = {};
  const parts = {};
  let msg;
  let goodSignature;

  before(async () => {
    for (const key of [shareKey1, shareKey2, shareKey3]) {
      const svc = new ShareKeyService(key);
      await svc.initialize();
      services[key.shareIndex] = svc;
    }
    msg = Buffer.from(
      services[1].make_msg('11'.repeat(32), 'dapp.wax', 7),
      'hex'
    );
    for (const idx of [1, 2, 3]) {
      parts[idx] = { idx, sig_i: sigHex(await services[idx].sign(msg)) };
    }
    goodSignature = signatureOf(
      services[1].combinePartialSignatures([parts[1], parts[2]], msg)
    );
  });

  it('combines two honest parts into the canonical full signature', () => {
    expect(goodSignature).to.match(/^[0-9a-f]+$/);
    expect(goodSignature.length).to.equal(shareKey1.bits / 4);
    // any honest pair yields the same RSA signature (deterministic)
    expect(
      signatureOf(
        services[2].combinePartialSignatures([parts[2], parts[3]], msg)
      )
    ).to.equal(goodSignature);
    const result = services[1].combinePartialSignatures(
      [parts[1], parts[2]],
      msg
    );
    expect(result.rejectedShares).to.deep.equal([]);
    expect(result.failedSubsets).to.deep.equal([]);
    expect(result.usedShareIndices).to.deep.equal([1, 2]);
  });

  it('completes with the two good parts when a poisoned zero part is on chain (pre-fix: throws)', () => {
    const result = services[1].combinePartialSignatures(
      [{ idx: 3, sig_i: '0' }, parts[1], parts[2]],
      msg
    );
    expect(signatureOf(result)).to.equal(goodSignature);
    expect(result.rejectedShares).to.deep.equal([
      { position: 0, shareIndex: 3, reason: 'zero' },
    ]);
  });

  it('rejects a part >= n and reports its index and position', () => {
    const result = services[1].combinePartialSignatures(
      [parts[1], { idx: 2, sig_i: shareKey1.publicKey.n }, parts[3]],
      msg
    );
    expect(result.signature).to.equal(goodSignature);
    expect(result.rejectedShares).to.have.length(1);
    expect(result.rejectedShares[0]).to.include({
      position: 1,
      shareIndex: 2,
      reason: 'not less than n',
    });
    expect(result.usedShareIndices).to.deep.equal([1, 3]);
  });

  it('never hands a non-hex or non-string part to the library', () => {
    const result = services[1].combinePartialSignatures(
      [{ idx: 2, sig_i: 'zz' }, parts[1], { idx: 9, sig_i: 12345 }, parts[3]],
      msg
    );
    expect(result.signature).to.equal(goodSignature);
    expect(
      result.rejectedShares.map(r => [r.position, r.shareIndex])
    ).to.deep.equal([
      [0, 2],
      [2, 9],
    ]);
    expect(result.rejectedShares[0].reason).to.match(/not a hex string/);
  });

  it('throws CombineError INVALID_SHARE (not a crash) when fewer than k well-formed parts remain', () => {
    let err;
    try {
      services[1].combinePartialSignatures(
        [parts[1], { idx: 2, sig_i: '0' }],
        msg
      );
    } catch (e) {
      err = e;
    }
    expect(err).to.exist;
    expect(ShareKeyService.isCombineError(err)).to.equal(true);
    expect(err.code).to.equal('INVALID_SHARE');
    expect(err.rejectedShares).to.deep.equal([
      { position: 1, shareIndex: 2, reason: 'zero' },
    ]);
  });

  it('throws CombineError INVALID_SHARE when the malformed parts alone drop the set below k', () => {
    let err;
    try {
      services[1].combinePartialSignatures(
        [{ idx: 2, sig_i: 'zz' }, parts[1]],
        msg
      );
    } catch (e) {
      err = e;
    }
    expect(err.code).to.equal('INVALID_SHARE');
    expect(err.rejectedShares[0]).to.include({ position: 0, shareIndex: 2 });
  });

  it('skips a well-formed but wrong part (signature over another message) and names it as suspect', async () => {
    const wrong = sigHex(
      await services[3].sign(Buffer.from('22'.repeat(32), 'hex'))
    );
    const result = services[1].combinePartialSignatures(
      [{ idx: 3, sig_i: wrong }, parts[1], parts[2]],
      msg
    );
    expect(result.signature).to.equal(goodSignature);
    expect(result.failedSubsets).to.deep.equal([[3, 1]]);
    expect(result.suspectShareIndices).to.deep.equal([3]);
    expect(result.usedShareIndices).to.deep.equal([1, 2]);
  });

  it('throws CombineError NO_VALID_SUBSET when no k-subset verifies', async () => {
    const wrongMsg = Buffer.from('33'.repeat(32), 'hex');
    const wrong1 = sigHex(await services[1].sign(wrongMsg));
    const wrong2 = sigHex(await services[2].sign(wrongMsg));
    let err;
    try {
      services[1].combinePartialSignatures(
        [
          { idx: 1, sig_i: wrong1 },
          { idx: 2, sig_i: wrong2 },
        ],
        msg
      );
    } catch (e) {
      err = e;
    }
    expect(err.code).to.equal('NO_VALID_SUBSET');
    expect(err.attemptedSubsets).to.deep.equal([[1, 2]]);
  });

  describe('Poller.pollJobsToExecute', () => {
    let rngPusher;
    let jobService;
    let poller;
    const baseJob = () => ({
      id: 42,
      dapp: 'dapp.wax',
      assoc_id: 5,
      seed: '11'.repeat(32),
      nonce: 7,
      ver: 1,
    });

    beforeEach(() => {
      rngPusher = {
        setRandomNumber: sinon.stub().resolves({ transactionId: 'tx' }),
        markFailed: sinon.stub().resolves({ transactionId: 'tx' }),
      };
      jobService = {
        getJobsToExecute: sinon.stub(),
        jobSeedFailed: sinon.stub().callsFake(async job => ({ id: job.id })),
      };
      poller = new Poller('rng1.wax', services[1], rngPusher, jobService, 1);
    });

    afterEach(() => sinon.restore());

    it('delivers setrand with the good parts when a poisoned part is present', async () => {
      const job = {
        ...baseJob(),
        parts: [{ idx: 3, sig_i: '0' }, parts[1], parts[2]],
      };
      jobService.getJobsToExecute.resolves([job]);

      await poller.pollJobsToExecute();

      expect(rngPusher.setRandomNumber.callCount).to.equal(1);
      const [
        calledJob,
        oracle,
        ver,
        sig,
      ] = rngPusher.setRandomNumber.firstCall.args;
      expect(calledJob.id).to.equal(42);
      expect(oracle).to.equal('rng1.wax');
      expect(ver).to.equal(1);
      expect(sig).to.equal(goodSignature);
      expect(jobService.jobSeedFailed.callCount).to.equal(0);
    });

    it('parks the job (pinned to its parts) instead of crashing or retrying when fewer than k parts are valid', async () => {
      const job = {
        ...baseJob(),
        parts: [parts[1], { idx: 2, sig_i: '0' }],
      };
      jobService.getJobsToExecute.resolves([job]);

      await poller.pollJobsToExecute();

      expect(rngPusher.setRandomNumber.callCount).to.equal(0);
      expect(rngPusher.markFailed.callCount).to.equal(0);
      expect(jobService.jobSeedFailed.callCount).to.equal(1);
      const [failedJob, meta] = jobService.jobSeedFailed.firstCall.args;
      expect(failedJob.id).to.equal(42);
      expect(meta).to.deep.equal({
        partsFingerprint: partsFingerprint(job.parts),
      });
    });

    it('keeps going with the next job after a combine failure', async () => {
      const bad = {
        ...baseJob(),
        id: 1,
        parts: [parts[1], { idx: 2, sig_i: '0' }],
      };
      const good = { ...baseJob(), id: 2, parts: [parts[1], parts[2]] };
      jobService.getJobsToExecute.resolves([bad, good]);

      await poller.pollJobsToExecute();

      expect(rngPusher.setRandomNumber.callCount).to.equal(1);
      expect(rngPusher.setRandomNumber.firstCall.args[0].id).to.equal(2);
    });
  });
});
