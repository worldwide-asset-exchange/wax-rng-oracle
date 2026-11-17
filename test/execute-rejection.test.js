// WBP-2083 regression: Poller.pollJobsToExecute must push markfailed only when
// the delivery itself failed inside contract code. A setrand the API node
// refuses (subjective failure limit, actor whitelist, CPU/NET, expiry) leaves
// the request deliverable, so the poller backs off and retries instead of
// parking a good result in undelivered1. Fail-on-pre-fix: against 7.4.0 three
// cases fail — the two node rejections call markFailed, and the bodiless RPC
// error throws a TypeError out of the loop.
const { expect } = require('chai');
const sinon = require('sinon');
const Poller = require('../lib/poller');
const { RpcError } = require('../lib/config/eos');
const slack = require('../lib/config/slack');

function rpcError(code, name, message) {
  return new RpcError({
    code: 500,
    message: 'Internal Service Error',
    error: {
      code,
      name,
      what: name,
      details: [{ message, file: 'x.cpp', line_number: 1, method: 'm' }],
    },
  });
}

const SIG = 'ab'.repeat(512);

describe('Poller.pollJobsToExecute — setrand rejected (WBP-2083)', () => {
  let rngPusher;
  let jobService;
  let poller;
  const job = () => ({
    id: 42,
    dapp: 'dapp.wax',
    assoc_id: 5,
    seed: '11'.repeat(32),
    nonce: 7,
    ver: 1,
    parts: [
      { idx: 1, sig_i: '01' },
      { idx: 2, sig_i: '02' },
    ],
  });

  beforeEach(() => {
    const shareKeyService = {
      make_msg: () => '00',
      combinePartialSignatures: () => ({
        signature: SIG,
        rejectedShares: [],
        failedSubsets: [],
        usedShareIndices: [1, 2],
      }),
    };
    rngPusher = {
      setRandomNumber: sinon.stub(),
      markFailed: sinon.stub().resolves({ transactionId: 'tx' }),
    };
    jobService = {
      getJobsToExecute: sinon.stub().resolves([job()]),
      jobSeedFailed: sinon.stub().callsFake(async j => j),
    };
    poller = new Poller(
      'waxswedenorg',
      shareKeyService,
      rngPusher,
      jobService,
      3
    );
  });

  afterEach(() => sinon.restore());

  it('dApp payer out of RAM (ram_usage_exceeded) is a delivery failure: markfailed', async () => {
    rngPusher.setRandomNumber.rejects(
      rpcError(
        3080001,
        'ram_usage_exceeded',
        'account dapp.wax has insufficient ram; needs 1000 bytes has 10 bytes'
      )
    );

    await poller.pollJobsToExecute();

    expect(rngPusher.markFailed.callCount).to.equal(1);
  });

  it('node rejections are alerted once per interval, not once per job', async () => {
    const post = sinon.stub(slack, 'postMessage').resolves();
    jobService.getJobsToExecute.resolves([
      job(),
      { ...job(), id: 43 },
      { ...job(), id: 44 },
    ]);
    rngPusher.setRandomNumber.rejects(
      rpcError(
        3080004,
        'tx_cpu_usage_exceeded',
        'transaction ' +
          'ee'.repeat(32) +
          ' exceeded failure limit for account waxswedenorg until 2026-11-16T12:00:00.500'
      )
    );

    await poller.pollJobsToExecute();

    expect(rngPusher.markFailed.callCount).to.equal(0);
    expect(jobService.jobSeedFailed.callCount).to.equal(3);
    expect(post.callCount).to.equal(1);
    expect(post.firstCall.args[0]).to.include('REJECTED by API node');

    poller.rejectedAlert.lastPostAt -= 61 * 1000;
    jobService.getJobsToExecute.resolves([{ ...job(), id: 45 }]);
    await poller.pollJobsToExecute();
    expect(post.callCount).to.equal(2);
    expect(post.secondCall.args[0]).to.include(
      '+2 similar alert(s) suppressed'
    );
  });

  it('the pusher reporting the request gone (skipped) is a collision: no retry, no markfailed, no alert', async () => {
    const post = sinon.stub(slack, 'postMessage').resolves();
    rngPusher.setRandomNumber.resolves({
      skipped: 'assertion failure with message: no request found',
    });

    await poller.pollJobsToExecute();

    expect(rngPusher.markFailed.callCount).to.equal(0);
    expect(jobService.jobSeedFailed.callCount).to.equal(0);
    expect(post.callCount).to.equal(0);
  });

  it('subjective failure limit: backs off, retries later, no markfailed', async () => {
    rngPusher.setRandomNumber.rejects(
      rpcError(
        3080004,
        'tx_cpu_usage_exceeded',
        'transaction ' +
          'cd'.repeat(32) +
          ' exceeded failure limit for account waxswedenorg until 2026-11-16T12:00:00.500'
      )
    );

    await poller.pollJobsToExecute();

    expect(rngPusher.setRandomNumber.callCount).to.equal(1);
    expect(rngPusher.markFailed.callCount).to.equal(0);
    expect(jobService.jobSeedFailed.callCount).to.equal(1);
  });

  it('actor whitelist on the push node: no markfailed', async () => {
    rngPusher.setRandomNumber.rejects(
      rpcError(
        3130001,
        'actor_whitelist_exception',
        'authorizing actor(s) in transaction are not on the actor whitelist: ["orng.wax"]'
      )
    );

    await poller.pollJobsToExecute();

    expect(rngPusher.markFailed.callCount).to.equal(0);
    expect(jobService.jobSeedFailed.callCount).to.equal(1);
  });

  it('dApp callback asserts: markfailed with the computed signature and the assertion text', async () => {
    rngPusher.setRandomNumber.rejects(
      rpcError(
        3050003,
        'eosio_assert_message_exception',
        'assertion failure with message: dapp refuses this result'
      )
    );

    await poller.pollJobsToExecute();

    expect(rngPusher.markFailed.callCount).to.equal(1);
    const [
      calledJob,
      oracle,
      ver,
      sig,
      msg,
    ] = rngPusher.markFailed.firstCall.args;
    expect(calledJob.id).to.equal(42);
    expect(oracle).to.equal('waxswedenorg');
    expect(ver).to.equal(1);
    expect(sig).to.equal(SIG);
    expect(msg).to.equal(
      'assertion failure with message: dapp refuses this result'
    );
  });

  it('"no request found" (twin or another member delivered): neither markfailed nor alert', async () => {
    const post = sinon.stub(slack, 'postMessage').resolves();
    rngPusher.setRandomNumber.rejects(
      rpcError(
        3050003,
        'eosio_assert_message_exception',
        'assertion failure with message: no request found'
      )
    );

    await poller.pollJobsToExecute();

    expect(rngPusher.markFailed.callCount).to.equal(0);
    expect(post.callCount).to.equal(0);
  });

  it('an RPC error without an error body does not throw out of the poll loop', async () => {
    rngPusher.setRandomNumber.rejects(
      new RpcError({ code: 502, message: 'Bad Gateway' })
    );

    await poller.pollJobsToExecute();

    expect(rngPusher.markFailed.callCount).to.equal(0);
    expect(jobService.jobSeedFailed.callCount).to.equal(1);
  });

  it('markfailed itself failing is reported, not thrown', async () => {
    rngPusher.setRandomNumber.rejects(
      rpcError(
        3050003,
        'eosio_assert_message_exception',
        'assertion failure with message: dapp refuses this result'
      )
    );
    rngPusher.markFailed.rejects(new Error('boom'));

    await poller.pollJobsToExecute();

    expect(rngPusher.markFailed.callCount).to.equal(1);
  });
});
