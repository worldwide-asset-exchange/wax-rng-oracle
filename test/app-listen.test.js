// A port already in use used to be an unhandled 'error' event on the HTTP
// server: the process kept signing with no /health-check and no log line
// saying why (an operator hit this on 2026-11-13). The server must report it
// and hand over to the exit hook.
const { expect } = require('chai');
const net = require('net');
const sinon = require('sinon');
const App = require('../lib/app');
const JobsController = require('../lib/controller/jobs');
const HealthCheckController = require('../lib/controller/health-check');
const JobService = require('../lib/jobService');
const Storage = require('../lib/storage');

describe('App.startApp — port already in use', () => {
  let blocker;
  let port;

  before(done => {
    blocker = net.createServer();
    blocker.listen(0, '0.0.0.0', () => {
      port = blocker.address().port;
      done();
    });
  });

  after(done => blocker.close(done));

  it('calls the listen-error hook with EADDRINUSE instead of swallowing it', async () => {
    const onListenError = sinon.stub();
    const app = new App(
      new JobsController(new JobService(new Storage(2), 1)),
      new HealthCheckController({ get_info: async () => ({}) })
    );
    app.startApp(port, onListenError);

    await new Promise(resolve => {
      const t = setInterval(() => {
        if (onListenError.called) {
          clearInterval(t);
          resolve();
        }
      }, 20);
    });

    expect(onListenError.callCount).to.equal(1);
    expect(onListenError.firstCall.args[0].code).to.equal('EADDRINUSE');
  });
});
