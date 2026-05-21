const chai = require('chai');
const request = require('supertest');
const { expect } = chai;
const AppHelper = require('./appHelper');
const { version } = require('../package.json');
chai.use(require('sinon-chai'));

describe('GET /version', () => {
  let app;

  before('Before all', async function() {
    appHelper = new AppHelper(null, 8083);
    app = await appHelper.getApp();
  });

  it('should return healthy equals true under normal condition', done => {
    request(app)
      .get('/version')
      .expect(200)
      .expect(res => {
        expect(res.body.version).to.equal(version);
      })
      .end(done);
  });
});
