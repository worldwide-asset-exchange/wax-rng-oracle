const chai = require('chai');
const request = require('supertest');
const sinon = require('sinon');
const { mockRequest, mockResponse } = require('mock-req-res');
const AppHelper = require('./appHelper');
const { eosRpc } = require('../lib/config/eos');
const HealthCheckController = require('../lib/controller/health-check');
const { expect } = chai;
const { match } = sinon;
chai.use(require('sinon-chai'));

describe('GET /health-check', () => {
  let app;
  let appHelper;
  let healthCheckController;
  let healthCheckControllerThrows;
  let mockEosRPC;
  let mockReq;
  let mockRes;

  before('Before all', async function() {
    mockEosRPC = { get_info: x => x };
    mockEosRPCThrows = {
      get_info: () => {
        throw new Error('Mock Error');
      },
    };
    mockReq = mockRequest();
    mockRes = mockResponse();
    throwingMockRes = () => {
      throw new Error('Throwed Error');
    };

    appHelper = new AppHelper(eosRpc, 8002);
    app = await appHelper.getApp();
  });

  it('should return healthy equals true under normal condition', async () => {
    const stubEosGetInfo = sinon.stub(eosRpc, 'get_info');
    stubEosGetInfo.callsFake(() => {
      return true;
    });
    const healthCheckResult = await request(app).get('/health-check');

    expect(healthCheckResult.statusCode).to.equal(200);
    expect(healthCheckResult.body.healthy).to.equal(true);
    expect(healthCheckResult.body.eos).to.equal(true);

    expect(stubEosGetInfo.callCount).to.equal(1);
    sinon.restore();
  });

  it('should res-pond object with keys: healthy, and eos. All with TRUE values.', async () => {
    healthCheckController = new HealthCheckController(mockEosRPC);
    await healthCheckController.getStatus(mockReq, mockRes);
    expect(mockRes.json.called).to.equal(true);
    expect(mockRes.json).to.have.been.calledWith(
      match({ eos: true, healthy: true })
    );
    expect(mockRes.status).to.have.been.calledWith(200);
  });

  it('should res-pond object { healthy:false, eos: false }', async () => {
    healthCheckControllerThrows = new HealthCheckController(mockEosRPCThrows);
    await healthCheckControllerThrows.getStatus(mockReq, mockRes);
    expect(mockRes.json).to.have.been.calledWith(
      match({ eos: false, healthy: false })
    );
    expect(mockRes.status).to.have.been.calledWith(500);
  });
});
