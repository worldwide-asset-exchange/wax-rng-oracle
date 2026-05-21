const { expect } = require('chai');
const sinon = require('sinon');
const { Chain, Account } = require('qtest-js');
let { eosRpc, getOrngContract } = require('../lib/config/eos');
const eosHelper = require('./eosHelper');
const Storage = require('../lib/storage');
const JobService = require('../lib/jobService');
const { sha256 } = require('./eosHelper');

describe('JobService Collision Reduction Integration Tests', () => {
  let chain;
  let orngContract = 'orng.wax';
  let orngOracle = 'oracle.wax';
  let orngV1Oracle = 'oraclev1.wax';
  let node1 = 'node1';
  let dappContract = 'dapp.wax';
  let createdJobs;
  let govAccount = 'orng.gov';
  let pollerOrngContract;
  let orngOracle2 = 'oracle2.wax';
  let orngOracle3 = 'oracle3.wax';
  let orngOracle4 = 'oracle4.wax';
  let treasuryAccount = 'treasury.wax';

  // Simulate multiple oracle instances
  let storage1, storage2, storage3;
  let jobService1, jobService2, jobService3;

  before('Setup test environment', async function() {
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

    // Create separate storage instances for each oracle
    storage1 = new Storage(2);
    await storage1.init('testdb-collision-1.json');

    storage2 = new Storage(2);
    await storage2.init('testdb-collision-2.json');

    storage3 = new Storage(2);
    await storage3.init('testdb-collision-3.json');

    // Create job services with different keyIndex (simulating different oracles)
    jobService1 = new JobService(storage1, 1);
    jobService2 = new JobService(storage2, 2);
    jobService3 = new JobService(storage3, 3);

    pollerOrngContract = getOrngContract();
    pollerOrngContract.config.nodeOwner = node1.name;

    // Create test jobs
    createdJobs = await eosHelper.createJobs(orngContract, dappContract, 30);
  });

  after(async () => {
    await chain.clear();
  }, 180000);

  it('should demonstrate collision reduction with multiple oracles', async function() {
    const jobs1 = await jobService1.getJobsToProcess();
    const jobs2 = await jobService2.getJobsToProcess();
    const jobs3 = await jobService3.getJobsToProcess();

    // All oracles should see all jobs
    expect(jobs1.length).to.equal(30);
    expect(jobs2.length).to.equal(30);
    expect(jobs3.length).to.equal(30);

    // Get the job selection order for each oracle
    const order1 = jobs1.map(j => j.id);
    const order2 = jobs2.map(j => j.id);
    const order3 = jobs3.map(j => j.id);
    console.log('order1:', order1);
    console.log('order2:', order2);
    console.log('order3:', order3);

    // Orders should be different (collision reduction)
    expect(order1).to.not.deep.equal(order2);
    expect(order2).to.not.deep.equal(order3);
    expect(order1).to.not.deep.equal(order3);

    // First job selected by each oracle should likely be different
    expect(order1[0]).to.not.equal(order2[0]);
    expect(order2[0]).to.not.equal(order3[0]);
    expect(order1[0]).to.not.equal(order3[0]);
  });

  it('should verify top N jobs selected are different across oracles', async function() {
    const TOP_N = 5;

    const jobs1 = await jobService1.getJobsToProcess();
    const jobs2 = await jobService2.getJobsToProcess();
    const jobs3 = await jobService3.getJobsToProcess();

    const top1 = jobs1.slice(0, TOP_N).map(j => j.id);
    const top2 = jobs2.slice(0, TOP_N).map(j => j.id);
    const top3 = jobs3.slice(0, TOP_N).map(j => j.id);

    // Calculate overlap between top selections
    const overlap12 = top1.filter(id => top2.includes(id)).length;
    const overlap23 = top2.filter(id => top3.includes(id)).length;
    const overlap13 = top1.filter(id => top3.includes(id)).length;

    // With random selection, we expect less than 100% overlap
    // (Less overlap means better collision reduction)
    expect(overlap12).to.be.lessThan(TOP_N);
    expect(overlap23).to.be.lessThan(TOP_N);
    expect(overlap13).to.be.lessThan(TOP_N);
  });

  it('should maintain deterministic ordering within same oracle', async function() {
    // Same oracle should always get same order on same day
    const jobs1a = await jobService1.getJobsToProcess();
    const jobs1b = await jobService1.getJobsToProcess();

    const order1a = jobs1a.map(j => j.id);
    const order1b = jobs1b.map(j => j.id);

    expect(order1a).to.deep.equal(order1b);
  });

  it('should verify no jobs are skipped with randomization', async function() {
    const jobs1 = await jobService1.getJobsToProcess();
    const jobs2 = await jobService2.getJobsToProcess();
    const jobs3 = await jobService3.getJobsToProcess();

    // Extract job IDs and sort
    const ids1 = jobs1.map(j => j.id).sort();
    const ids2 = jobs2.map(j => j.id).sort();
    const ids3 = jobs3.map(j => j.id).sort();

    // All oracles should see the same set of jobs (just in different order)
    expect(ids1).to.deep.equal(ids2);
    expect(ids2).to.deep.equal(ids3);

    // Verify all 30 jobs are present
    expect(ids1).to.have.lengthOf(30);
  });

  it('should demonstrate collision reduction scales with more oracles', async function() {
    // Create additional oracle instances
    const storage4 = new Storage(2);
    await storage4.init('testdb-collision-4.json');
    const jobService4 = new JobService(storage4, 4);

    const storage5 = new Storage(2);
    await storage5.init('testdb-collision-5.json');
    const jobService5 = new JobService(storage5, 5);

    const jobs1 = await jobService1.getJobsToProcess();
    const jobs2 = await jobService2.getJobsToProcess();
    const jobs3 = await jobService3.getJobsToProcess();
    const jobs4 = await jobService4.getJobsToProcess();
    const jobs5 = await jobService5.getJobsToProcess();

    const firstJobs = [
      jobs1[0].id,
      jobs2[0].id,
      jobs3[0].id,
      jobs4[0].id,
      jobs5[0].id,
    ];

    // With 5 oracles and 30 jobs, most oracles should start with different jobs
    const uniqueFirstJobs = [...new Set(firstJobs)];
    expect(uniqueFirstJobs.length).to.be.at.least(3); // At least 3 different starting jobs
  });
});
