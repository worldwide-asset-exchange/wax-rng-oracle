const { expect } = require('chai');
const request = require('supertest');
const { Chain, Account } = require('qtest-js');
const { eosRpc } = require('../lib/config/eos');
const AppHelper = require('./appHelper');
const eosHelper = require('./eosHelper');
const { sha256 } = require('./eosHelper');

describe('Jobs /jobs integration tests', () => {
  let appHelper;
  let app;
  let chain;
  let orngContract = 'orng.wax';
  let orngOracle = 'oracle.wax';
  let orngV1Oracle = 'oraclev1.wax';
  let node1 = 'node1';
  let epochDuration = 60;
  let dappContract = 'dapp.wax';
  let createdJobs;

  before('Before all', async function() {
    appHelper = new AppHelper(eosRpc, 8001);
    app = await appHelper.getApp();
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
    createdJobs = await eosHelper.createJobs(orngContract, dappContract, 3);
    createdJobs = createdJobs.map((c, i) => ({ id: i, ...c }));
  });

  after(async () => {
    await chain.clear();
  }, 10000);

  it('Should get the existing jobs', done => {
    request(app)
      .get('/jobs')
      .query({ from: createdJobs[0].id, limit: 10 })
      .expect(200)
      .expect(res => {
        expect(res.body.jobs).to.exist;
        expect(res.body.jobs.length).to.be.at.least(3);
      })
      .end(done);
  });

  it('Should get the existing jobs using from', done => {
    request(app)
      .get('/jobs')
      .query({ from: createdJobs[0].id + 2, limit: 10 })
      .expect(200)
      .expect(res => {
        expect(res.body.jobs).to.exist;
        expect(res.body.jobs.length).to.equal(1);
        expect(res.body.jobs[0].seed).to.equal(
          sha256(createdJobs[2].signing_value.toString())
        );
      })
      .end(done);
  });

  it('Should get the existing jobs using limit', done => {
    request(app)
      .get('/jobs')
      .query({ from: createdJobs[0].id, limit: 2 })
      .expect(200)
      .expect(res => {
        expect(res.body.jobs).to.exist;
        expect(res.body.jobs.length).to.equal(2);
        expect(res.body.jobs[0].seed).to.equal(
          sha256(createdJobs[0].signing_value.toString())
        );
        expect(res.body.jobs[1].seed).to.equal(
          sha256(createdJobs[1].signing_value.toString())
        );
      })
      .end(done);
  });

  it('Should return 400 when limit is not selected', done => {
    request(app)
      .get('/jobs')
      .query({ from: 1000 })
      .expect(400)
      .end(done);
  });

  it('Should return 400 when from is not selected', done => {
    request(app)
      .get('/jobs')
      .query({ limit: 1000 })
      .expect(400)
      .end(done);
  });

  it('Should return 400 when limit is not valid', done => {
    request(app)
      .get('/jobs')
      .query({ from: 1000, limit: 'invalid' })
      .expect(400)
      .end(done);
  });

  it('Should return 400 when from is not valid', done => {
    request(app)
      .get('/jobs')
      .query({ from: 'invalid', limit: 1000 })
      .expect(400)
      .end(done);
  });

  it('Should get the seed for a given job id', done => {
    request(app)
      .get(`/jobs/${createdJobs[0].id}`)
      .send({})
      .expect(200)
      .expect(res => {
        expect(res.body.id).to.equal(createdJobs[0].id);
        expect(res.body.seed).to.equal(
          sha256(createdJobs[0].signing_value.toString())
        );
        expect(res.body.dapp).to.exist;
      })
      .end(done);
  });

  it('should get 400 when job id is invalid', done => {
    request(app)
      .get(`/jobs/invalid`)
      .send({})
      .expect(400)
      .end(done);
  });
});
