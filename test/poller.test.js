let config = require('../lib/config/configLoader').loadConfig();
const { expect } = require('chai');
const sinon = require('sinon');
const { Chain } = require('qtest-js');
let { eosRpc, getOrngContract } = require('../lib/config/eos');
const eosHelper = require('./eosHelper');
const Storage = require('../lib/storage');
const JobService = require('../lib/jobService');
const Poller = require('../lib/poller');
const ShareKeyService = require('../lib/shareKeyService');
const { sha256 } = require('./eosHelper');
const RngPusher = require('../lib/rngPusher');
const { request } = require('express');

const { shareKey1, shareKey2 } = require('./fixtures/testShareKeys');

describe('test rng oracle poller', async () => {
  let chain;
  let orngContract = 'orng.wax';
  let orngOracle = 'oracle.wax';
  let orngOracle2 = 'oracle2.wax';
  let orngV1Oracle = 'oraclev1.wax';
  let dappContract = 'dapp.wax';
  let node1 = 'node1';
  let requestRandContract;

  let jobService1, jobService2;
  let storage1, storage2;
  let poller1;
  let poller2;
  let rngPusher;

  before('Before all', async function() {
    this.timeout(180000);
    chain = await Chain.setupChain('WAX');
    eosRpc.endpoint = `http://127.0.0.1:${chain.port}`;

    ({
      orngContract,
      orngOracle,
      orngOracle2,
      orngV1Oracle,
      node1,
      node2,
      node3,
      node4,
      node5,
      dappContract,
      requestRandContract,
    } = await eosHelper.setupOrngContract(chain, eosRpc));
    console.log('Chain:', eosRpc.endpoint);
    storage1 = new Storage(2);
    await storage1.init('testdb1.json');
    storage2 = new Storage(2);
    await storage2.init('testdb2.json');
    jobService1 = new JobService(storage1, 1);
    jobService2 = new JobService(storage2, 2);

    const shareKeyService1 = new ShareKeyService(shareKey1);
    await shareKeyService1.initialize();

    const shareKeyService2 = new ShareKeyService(shareKey2);
    await shareKeyService2.initialize();

    rngPusher = new RngPusher();
    poller1 = new Poller(
      orngOracle.name,
      shareKeyService1,
      rngPusher,
      jobService1,
      1
    );
    poller2 = new Poller(
      orngOracle2.name,
      shareKeyService2,
      rngPusher,
      jobService2,
      2
    );
  });

  after(async () => {
    await chain.clear();
  }, 30000);

  beforeEach('After each', async function() {
    await storage1.clearAllFailedJobs();
    await storage2.clearAllFailedJobs();
  });

  afterEach('After each', async function() {
    sinon.restore();
  });

  describe('test pollJobsToSetPart', async function() {
    it('should poll and process job on poller 1', async function() {
      this.timeout(180000);
      sinon.spy(jobService1, 'getJobsToProcess');
      sinon.spy(rngPusher, 'submitPartialSignature');
      sinon.spy(jobService1, 'jobSeedFailed');

      await eosHelper.createJobs(orngContract, dappContract, 2);
      const jobs_tbl_before = await orngContract.contract.table['reqs'].get({
        scope: orngContract.name,
      });
      expect(jobs_tbl_before.rows.length).to.equal(2);

      await poller1.pollJobsToSetPart();

      const jobs_tbl_after = await orngContract.contract.table['reqs'].get({
        scope: orngContract.name,
      });
      expect(jobs_tbl_after.rows.length).to.equal(2);
      const completedJobs = jobs_tbl_after.rows.filter(
        j =>
          j.final_hash !==
          '0000000000000000000000000000000000000000000000000000000000000000'
      );
      expect(completedJobs.length).to.equal(2);

      expect(jobService1.getJobsToProcess.callCount).to.equal(1);
      expect(rngPusher.submitPartialSignature.callCount).to.equal(2);
    });

    it('should poll and do nothing if no available job to process', async function() {
      sinon.spy(jobService1, 'getJobsToProcess');
      sinon.spy(rngPusher, 'submitPartialSignature');
      sinon.spy(jobService1, 'jobSeedFailed');

      await poller1.pollJobsToSetPart();

      expect(jobService1.getJobsToProcess.callCount).to.equal(1);
      expect(rngPusher.submitPartialSignature.callCount).to.equal(0);
    });

    it('should poll and process job on poller 2', async function() {
      this.timeout(180000);
      sinon.spy(jobService2, 'getJobsToProcess');
      sinon.spy(rngPusher, 'submitPartialSignature');
      sinon.spy(jobService2, 'jobSeedFailed');

      const jobs_tbl_before = await orngContract.contract.table['reqs'].get({
        scope: orngContract.name,
      });
      expect(jobs_tbl_before.rows.length).to.equal(2);

      await poller2.pollJobsToSetPart();

      const jobs_tbl_after = await orngContract.contract.table['reqs'].get({
        scope: orngContract.name,
      });
      expect(jobs_tbl_after.rows.length).to.equal(2);
      const completedJobs = jobs_tbl_after.rows.filter(
        j =>
          j.final_hash !==
          '0000000000000000000000000000000000000000000000000000000000000000'
      );
      expect(completedJobs.length).to.equal(2);

      expect(jobService2.getJobsToProcess.callCount).to.equal(1);
      expect(rngPusher.submitPartialSignature.callCount).to.equal(2);
    });
  });

  describe('test pollJobsToExecute', async function() {
    it('should execute jobs if node is resolver', async function() {
      this.timeout(180000);

      sinon.spy(jobService1, 'getJobsToExecute');
      sinon.spy(rngPusher, 'setRandomNumber');

      await poller1.pollJobsToExecute();

      await chain.waitTillNextBlock(15);

      expect(jobService1.getJobsToExecute.callCount).to.equal(1);
      expect(rngPusher.setRandomNumber.callCount).to.equal(2);

      const jobs_tbl_after = await orngContract.contract.table['reqs'].get({
        scope: orngContract.name,
        limit: 1000,
      });
      console.log(jobs_tbl_after.rows);
      expect(jobs_tbl_after.rows.length).to.equal(0);
    });
  });

  describe('test request fail', async function() {
    it('should markfailed if request is failed', async function() {
      this.timeout(180000);

      sinon.spy(jobService1, 'getJobsToProcess');
      sinon.spy(rngPusher, 'submitPartialSignature');
      sinon.spy(jobService1, 'jobSeedFailed');

      // await eosHelper.createJobs(orngContract, dappContract, 2);
      await requestRandContract.contract.action.requestfail(
        {
          signing_value: 1001,
        },
        [
          {
            actor: requestRandContract.name,
            permission: 'active',
          },
        ]
      );
      const jobs_tbl_before = await orngContract.contract.table['reqs'].get({
        scope: orngContract.name,
      });
      expect(jobs_tbl_before.rows.length).to.equal(1);

      await poller1.pollJobsToSetPart();
      await poller2.pollJobsToSetPart();

      //process set rand on poller 1
      await poller1.pollJobsToExecute();

      const jobs_tbl_after = await orngContract.contract.table['reqs'].get({
        scope: orngContract.name,
      });

      expect(jobs_tbl_after.rows.length).to.equal(0);

      const undeliveredJobs = await orngContract.contract.table[
        'undelivered1'
      ].get({
        scope: orngContract.name,
      });

      expect(undeliveredJobs.rows.length).to.equal(1);
    });

    // Regression coverage for WBP-1953: the oracle must read the renamed
    // on-chain table ("undelivered1"). Before the fix it queried "undelivered"
    // (now the empty undelivered_old table), so retry delivery silently found
    // nothing. This drives the actual retry path end-to-end.
    it('should read undelivered1 and drive retry delivery (WBP-1953)', async function() {
      this.timeout(180000);

      // The failed request from the previous test is recorded on-chain.
      const onChain = await orngContract.contract.table['undelivered1'].get({
        scope: orngContract.name,
      });
      expect(onChain.rows.length).to.equal(1);
      const requestId = onChain.rows[0].request_id;

      // The oracle's query path must surface that row. With the wrong table
      // name this returns [] and the assertion below fails.
      const jobsToRetry = await jobService1.getJobsToRetryDeliver();
      expect(jobsToRetry.length).to.equal(1);
      expect(String(jobsToRetry[0].request_id)).to.equal(String(requestId));

      // Drive the full poller retry loop; stub the on-chain push so the test
      // asserts the oracle attempts redelivery for the job it read.
      const retryStub = sinon
        .stub(rngPusher, 'retryDeliver')
        .resolves({ transactionId: 'stub', tx: {} });

      await poller1.pollJobToRetryDeliver();

      expect(retryStub.calledOnce).to.equal(true);
      expect(String(retryStub.firstCall.args[1])).to.equal(String(requestId));
    });

    it('should call contract cleanup', async function() {
      this.timeout(180000);

      sinon.spy(rngPusher, 'cleanup');
      await poller1.cleanupDelivered();
      expect(rngPusher.cleanup.callCount).to.equal(1);
    });
  });
});
