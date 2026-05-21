const App = require('./../lib/app');
const JobsController = require('../lib/controller/jobs');
const HealthCheckController = require('./../lib/controller/health-check');
const JobService = require('../lib/jobService');
const Storage = require('../lib/storage');

class AppHelper {
  constructor(eosRpc, port) {
    this.storage = new Storage(2);
    this.jobService = new JobService(this.storage, 1);
    this.jobController = new JobsController(this.jobService);
    this.healthCheckController = new HealthCheckController(eosRpc);
    this.app = new App(this.jobController, this.healthCheckController).startApp(
      port
    );
  }

  async getApp() {
    await this.storage.init('testdb.json');
    await this.storage.clearAllFailedJobs();
    return this.app;
  }
}

module.exports = AppHelper;
