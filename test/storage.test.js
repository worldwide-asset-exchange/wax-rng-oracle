// Retry policy for combine failures: a job whose parts did not combine is not
// retried while the on-chain parts are unchanged; once they change (another
// member submits) the normal backoff applies again.
const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Storage = require('../lib/storage');

const { partsFingerprint } = Storage;

describe('Storage combine-failure retry policy', () => {
  let storage;
  let dbFile;
  const job = (parts, id = 11) => ({
    id,
    nonce: 1,
    ver: 1,
    seed: 'ab'.repeat(32),
    dapp: 'dapp.wax',
    parts,
  });
  const partsA = [
    { idx: 1, sig_i: 'aa' },
    { idx: 2, sig_i: '0' },
  ];
  const partsB = [
    { idx: 1, sig_i: 'aa' },
    { idx: 2, sig_i: '0' },
    { idx: 3, sig_i: 'cc' },
  ];

  beforeEach(async () => {
    dbFile = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'rng-storage-')),
      'db.json'
    );
    storage = new Storage(3);
    await storage.init(dbFile);
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
  });

  it('fingerprint is order-independent and sensitive to any part change', () => {
    expect(partsFingerprint(partsA)).to.equal(
      partsFingerprint([...partsA].reverse())
    );
    expect(partsFingerprint(partsA)).to.not.equal(partsFingerprint(partsB));
    expect(partsFingerprint(partsA)).to.not.equal(
      partsFingerprint([
        { idx: 1, sig_i: 'aa' },
        { idx: 2, sig_i: '1' },
      ])
    );
    expect(partsFingerprint(undefined)).to.equal(partsFingerprint([]));
  });

  it('does not retry a combine failure while the parts are unchanged, even after the backoff', async () => {
    const failed = await storage.jobFailed(job(partsA), {
      partsFingerprint: partsFingerprint(partsA),
    });
    expect(failed.partsFingerprint).to.equal(partsFingerprint(partsA));
    // push createdAt into the past so a plain backoff would already retry
    failed.createdAt = Date.now() - 60 * 1000;
    await storage.setFailedJob(failed);

    expect(storage.shouldExecuteJob(job(partsA))).to.equal(false);
    expect(storage.shouldExecuteJob(job([...partsA].reverse()))).to.equal(
      false
    );
  });

  it('retries (under the normal backoff) once the parts change', async () => {
    const failed = await storage.jobFailed(job(partsA), {
      partsFingerprint: partsFingerprint(partsA),
    });
    failed.createdAt = Date.now() - 60 * 1000;
    await storage.setFailedJob(failed);

    expect(storage.shouldExecuteJob(job(partsB))).to.equal(true);
  });

  it('keeps the existing backoff for failures that are not combine failures', async () => {
    const failed = await storage.jobFailed(job(partsA));
    expect(failed.partsFingerprint).to.equal(undefined);
    expect(failed.nextRetry).to.equal(500);
    // too early
    expect(storage.shouldExecuteJob(job(partsA))).to.equal(false);
    failed.createdAt = Date.now() - 60 * 1000;
    await storage.setFailedJob(failed);
    expect(storage.shouldExecuteJob(job(partsA))).to.equal(true);

    await storage.jobFailed(job(partsA));
    expect(storage.getFailedJobById(11).nextRetry).to.equal(1000);
  });

  it('a later non-combine failure clears the pin; a later combine failure re-pins', async () => {
    await storage.jobFailed(job(partsA), {
      partsFingerprint: partsFingerprint(partsA),
    });
    await storage.jobFailed(job(partsA));
    expect(storage.getFailedJobById(11).partsFingerprint).to.equal(undefined);
    await storage.jobFailed(job(partsB), {
      partsFingerprint: partsFingerprint(partsB),
    });
    expect(storage.getFailedJobById(11).partsFingerprint).to.equal(
      partsFingerprint(partsB)
    );
    expect(storage.getFailedJobById(11).nextRetry).to.equal(2000);
  });
});
