// /health-check reports how old the API node's head block is. A member polling
// a node minutes behind head misses requests while reporting healthy
// (2026-11-13: one member signed nothing for ten minutes for exactly that
// reason); the number lets the host alert on it.
const chai = require('chai');
const sinon = require('sinon');
const { mockRequest, mockResponse } = require('mock-req-res');
const HealthCheckController = require('../lib/controller/health-check');
const { headBlockLag } = HealthCheckController;
const { expect } = chai;
const { match } = sinon;
chai.use(require('sinon-chai'));

describe('/health-check headBlockLagSeconds', () => {
  it('headBlockLag reads nodeos head_block_time (no zone) as UTC', () => {
    const now = Date.parse('2026-11-16T20:00:10.000Z');
    expect(
      headBlockLag({ head_block_time: '2026-11-16T20:00:00.500' }, now)
    ).to.equal(10);
    expect(
      headBlockLag({ head_block_time: '2026-11-16T20:00:09.500Z' }, now)
    ).to.equal(1);
  });

  it('headBlockLag is null without a parseable time and never negative', () => {
    expect(headBlockLag(undefined)).to.equal(null);
    expect(headBlockLag(true)).to.equal(null);
    expect(headBlockLag({ head_block_time: 'soon' })).to.equal(null);
    const now = Date.parse('2026-11-16T20:00:00.000Z');
    expect(
      headBlockLag({ head_block_time: '2026-11-16T20:00:03.000' }, now)
    ).to.equal(0);
  });

  it('the endpoint carries the lag and stays 200 for a lagging node (informational)', async () => {
    const stale = new Date(Date.now() - 125000).toISOString().replace('Z', '');
    const controller = new HealthCheckController({
      get_info: async () => ({ head_block_time: stale }),
    });
    const res = mockResponse();
    await controller.getStatus(mockRequest(), res);
    expect(res.status).to.have.been.calledWith(200);
    const body = res.json.firstCall.args[0];
    expect(body.healthy).to.equal(true);
    expect(body.headBlockLagSeconds).to.be.within(124, 127);
  });

  it('the endpoint reports null lag when the node is unreachable', async () => {
    const controller = new HealthCheckController({
      get_info: async () => {
        throw new Error('down');
      },
    });
    const res = mockResponse();
    await controller.getStatus(mockRequest(), res);
    expect(res.status).to.have.been.calledWith(500);
    expect(res.json).to.have.been.calledWith(
      match({ eos: false, healthy: false, headBlockLagSeconds: null })
    );
  });
});
