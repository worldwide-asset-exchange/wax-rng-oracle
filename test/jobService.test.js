const { expect } = require('chai');
const sinon = require('sinon');
const { Chain, Account } = require('qtest-js');
let { eosRpc, getOrngContract } = require('../lib/config/eos');
const eosHelper = require('./eosHelper');
const Storage = require('../lib/storage');
const JobService = require('../lib/jobService');
const { sha256 } = require('./eosHelper');

describe('test job service service', () => {
  let chain;
  let orngContract = 'orng.wax';
  let orngOracle = 'oracle.wax';
  let orngV1Oracle = 'oraclev1.wax';
  let node1 = 'node1';
  let dappContract = 'dapp.wax';
  let createdJobs;
  let govAccount = 'orng.gov';
  let jobService;
  let pollerOrngContract;
  let storage;
  let orngOracle2 = 'oracle2.wax';
  let orngOracle3 = 'oracle3.wax';
  let orngOracle4 = 'oracle4.wax';
  let treasuryAccount = 'treasury.wax';

  before('Before all', async function() {
    this.timeout(180000);
    chain = await Chain.setupChain('WAX');
    eosRpc.endpoint = `http://127.0.0.1:${chain.port}`;

    ({
      orngContract,
      orngOracle,
      orngV1Oracle,
      node1,
      dappContract,
      govAccount,
      treasuryAccount,
      orngOracle2,
      orngOracle3,
      orngOracle4,
    } = await eosHelper.setupOrngContract(chain, eosRpc));

    storage = new Storage(2);
    await storage.init('testdb0.json');

    jobService = new JobService(storage, 1);

    pollerOrngContract = getOrngContract();
    pollerOrngContract.config.nodeOwner = node1.name;
  });

  after(async () => {
    await chain.clear();
    console.log('after chain clear');
  }, 180000);

  beforeEach('Before each', async function() {
    await storage.clearAllFailedJobs();
  });

  afterEach('After each', async function() {
    sinon.restore();
  });

  it('getJobsHelper', async function() {
    createdJobs = await eosHelper.createJobs(orngContract, dappContract, 11);
    const jobsTable = await jobService.getJobsHelper();
    expect(jobsTable.rows.length).to.equal(11);
    expect(jobsTable.rows[0].seed).to.equal(
      sha256(createdJobs[0].signing_value.toString())
    );
    expect(jobsTable.rows[0].assoc_id).to.equal(createdJobs[0].assoc_id);
    expect(jobsTable.rows[10].seed).to.equal(
      sha256(createdJobs[10].signing_value.toString())
    );
    expect(jobsTable.rows[10].assoc_id).to.equal(createdJobs[10].assoc_id);
    // expect(jobsTable.rows[10].final_hash).to.equal(sha256(createdJobs[10].signing_value.toString()));
  });

  it('getPendingJobNumber', async function() {
    const newCreatedJobs = await eosHelper.createJobs(
      orngContract,
      dappContract,
      11
    );
    createdJobs = createdJobs.concat(newCreatedJobs);
    const pendingJobNumber = await jobService.getPendingJobNumber();

    expect(pendingJobNumber).to.equal(22);
  });

  it('getJobsToProcess', async function() {
    const allJobToProcess = await jobService.getJobsToProcess();
    expect(allJobToProcess.length).to.equal(22);

    // Check that all jobs are present (regardless of order due to shuffling)
    const allJobIds = allJobToProcess.map(j => j.id).sort();
    expect(allJobIds).to.have.lengthOf(22);

    const stubStorageShouldTryJob = sinon.stub(jobService, 'shouldTryJob');
    stubStorageShouldTryJob.callsFake(job => {
      if (
        job.id === allJobToProcess[3].id ||
        job.id === allJobToProcess[5].id
      ) {
        return false;
      }
      return true;
    });

    const jobToProcess = await jobService.getJobsToProcess();
    expect(jobToProcess.length).to.equal(20);
    expect(jobToProcess.find(j => j.id === allJobToProcess[3].id)).to.equal(
      undefined
    );
    expect(jobToProcess.find(j => j.id === allJobToProcess[5].id)).to.equal(
      undefined
    );

    expect(stubStorageShouldTryJob.callCount).to.equal(22);
  });

  it('getJobById', async function() {
    const job = await jobService.getJobById(11);

    expect(job).to.be.exist;
    expect(job.id).to.equal(11);
    expect(job.seed).to.equal(sha256(createdJobs[11].signing_value.toString()));
  });

  it('should clear resolved failures job if job is no longer exist in blockchain', async function() {
    const stubStorageGetAllFailedJobs = sinon.stub(storage, 'getAllFailedJobs');
    stubStorageGetAllFailedJobs.callsFake(() => {
      return [
        {
          id: 9999,
          signing_value: 8877777777777,
        },
      ];
    });

    const stubStorageClearFailedJobs = sinon.stub(storage, 'clearFailedJobs');
    stubStorageClearFailedJobs.callsFake(jobs => {
      return;
    });

    await jobService.clearResolvedFailures();

    expect(stubStorageGetAllFailedJobs.callCount).to.equal(1);
    expect(stubStorageClearFailedJobs.callCount).to.equal(1);
    expect(stubStorageClearFailedJobs.firstCall.args[0][0]).to.equal(9999);
  });

  it('should clear resolved failures job if job signing value is mismatch with blockchain', async function() {
    const stubStorageGetAllFailedJobs = sinon.stub(storage, 'getAllFailedJobs');
    stubStorageGetAllFailedJobs.callsFake(() => {
      return [
        {
          id: 1,
          signing_value: createdJobs[1].signing_value + 111,
        },
      ];
    });

    const stubStorageClearFailedJobs = sinon.stub(storage, 'clearFailedJobs');
    stubStorageClearFailedJobs.callsFake(jobs => {
      return;
    });

    await jobService.clearResolvedFailures();

    expect(stubStorageGetAllFailedJobs.callCount).to.equal(1);
    expect(stubStorageClearFailedJobs.callCount).to.equal(1);
    expect(stubStorageClearFailedJobs.firstCall.args[0][0]).to.equal(1);
  });

  it('getJobsToProcess should return jobs in randomized order', async function() {
    // Call twice with same jobService (same keyIndex) - should get same order
    const jobs1 = await jobService.getJobsToProcess();
    const jobs2 = await jobService.getJobsToProcess();

    const order1 = jobs1.map(j => j.id);
    const order2 = jobs2.map(j => j.id);

    // Same keyIndex and same day should produce same order
    expect(order1).to.deep.equal(order2);
  });

  it('getJobsToProcess should produce different order for different oracles', async function() {
    const jobService2 = new JobService(storage, 2);
    const jobService3 = new JobService(storage, 3);

    const jobs1 = await jobService.getJobsToProcess();
    const jobs2 = await jobService2.getJobsToProcess();
    const jobs3 = await jobService3.getJobsToProcess();

    const order1 = jobs1.map(j => j.id);
    const order2 = jobs2.map(j => j.id);
    const order3 = jobs3.map(j => j.id);

    // Different keyIndex should produce different orders
    expect(order1).to.not.deep.equal(order2);
    expect(order2).to.not.deep.equal(order3);
    expect(order1).to.not.deep.equal(order3);

    // But all should contain the same jobs
    expect(order1.sort()).to.deep.equal(order2.sort());
    expect(order2.sort()).to.deep.equal(order3.sort());
  });

  it('getJobsToProcess should contain all jobs after shuffling', async function() {
    const jobs = await jobService.getJobsToProcess();
    const jobIds = jobs.map(j => j.id).sort();

    // Verify no jobs were lost during shuffling
    expect(jobIds).to.have.lengthOf(22);

    // Verify all job IDs are unique
    const uniqueIds = [...new Set(jobIds)];
    expect(uniqueIds).to.have.lengthOf(22);
  });
});
