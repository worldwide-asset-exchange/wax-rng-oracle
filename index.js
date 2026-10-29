require('dotenv').config();
const cluster = require('cluster');
const config = require('./lib/config/configLoader').loadConfig();
const logger = require('./lib/config/logger');
const Poller = require('./lib/poller');
const RngPusher = require('./lib/rngPusher');
const JobService = require('./lib/jobService');
const ShareKeyService = require('./lib/shareKeyService');
const Storage = require('./lib/storage');
const { eosRpc } = require('./lib/config/eos');
const JobsController = require('./lib/controller/jobs');
const HealthCheckController = require('./lib/controller/health-check');
const App = require('./lib/app');
const { isTrue } = require('./lib/config/utils');
const {
  runBootChecks,
  getBootCheckStatus,
  assertRuntimeEnv,
} = require('./lib/bootChecks');

const expressAppEnable = isTrue(config.get('expressApp.enable'));

function poll(asyncFunction, time) {
  return async function() {
    let duration = 0;
    try {
      const startTime = new Date().getTime();

      await asyncFunction();

      duration = new Date().getTime() - startTime;
    } catch (e) {
      logger.error(e);
    }

    setTimeout(poll(asyncFunction, time), Math.max(time - duration, 0));
  };
}

function fatal(message) {
  logger.error(message);
  process.exit(1);
}

async function run() {
  // NODE_ENV=test selects config/test.json (fixture share + dev chain key):
  // the test runner's file, never a running oracle's.
  try {
    assertRuntimeEnv();
  } catch (e) {
    return fatal(e.message);
  }

  const keyConfig = config.get('shareKey');
  const shareKeyService = new ShareKeyService(keyConfig);
  await shareKeyService.initialize();
  let shareIndex = parseInt(config.get('shareKey.shareIndex') || '0');

  // Boot self-check (ORC-3): this member's share must belong to the public key
  // the contract currently verifies against. Any failed check is fatal — exit
  // non-zero so the supervisor restarts into a visible crash loop instead of a
  // member that signs confidently and fails every combine. Runs in every
  // process (cluster workers included) so each signer checks what it holds.
  const bootStatus = await runBootChecks({
    shareKeyService,
    rpc: eosRpc,
    contractName: config.get('eos.orng.contractName'),
    retry: {
      attempts: parseInt(config.get('bootCheck.rpcRetries'), 10),
      baseDelayMs: parseInt(config.get('bootCheck.rpcRetryBaseMs'), 10),
    },
  });
  if (!bootStatus.ok) {
    return fatal(
      `Refusing to start: boot self-check failed (${bootStatus.failedChecks.join(
        ', '
      )})`
    );
  }

  const rngPusher = new RngPusher();
  const storage = new Storage(config.get('jobRetry.maxRetries'));
  await storage.init(
    process.env.DB || config.get('db.file'),
    +process.env.PROCESS_MODULUS,
    +process.env.TOTAL_PROCESS
  );
  const jobService = new JobService(storage, shareIndex);

  const jobsController = new JobsController(
    jobService,
    config.get('shareKey.shareIndex')
  );
  const healthCheckController = new HealthCheckController(
    eosRpc,
    getBootCheckStatus
  );
  let expressApp;
  if (expressAppEnable) {
    expressApp = new App(jobsController, healthCheckController);
  }
  const poller = new Poller(
    config.get('eos.orng.nodeOwner'),
    shareKeyService,
    rngPusher,
    jobService,
    config.get('shareKey.shareIndex')
  );

  if (isTrue(config.get('clusterMode')) && cluster.isPrimary) {
    logger.info(`Application: Master ${process.pid} is running`);
    const dbMap = {};

    // Fork workers.
    const numCPUs = require('os').cpus().length;
    const TOTAL_PROCESS = numCPUs;
    for (let i = 0; i < numCPUs; i++) {
      const DB = `db-${i}.json`;
      const PROCESS_MODULUS = i;
      let mergedEnv = { DB, TOTAL_PROCESS, PROCESS_MODULUS };
      const worker = cluster.fork(mergedEnv);
      dbMap[worker.id] = DB;
    }

    cluster.on('exit', (worker, code, signal) => {
      logger.error(`Application: worker ${worker.process.pid} died`);
      const DB = dbMap[worker.id];
      delete dbMap[worker.id];
      // dbMap[replacementWorker.id] = DB;
    });
    process.on('exit', () =>
      logger.warn('Stopping wax-rng-oracle main process.')
    );
  } else {
    if (expressAppEnable) {
      const port = config.get('expressApp.port');
      expressApp.startApp(port);
    }

    if (!isTrue(config.get('readOnlyMode'))) {
      poll(poller.clearResolvedFailures, 20000)();
      poll(poller.clearResolvedDeliveryFailures, 20000)();
      poll(poller.pollJobsToSetPart, 300)();
      poll(poller.pollJobsToExecute, 1000)();
      poll(poller.pollJobToRetryDeliver, 5000)();
      poll(poller.monitorPendingJob, 10000)();
      poll(poller.cleanupDelivered, 1 * 24 * 60 * 60 * 1000)(); // once a day
    } else {
      logger.warn(
        'READONLY_MODE active — poller disabled; serving API only, no jobs will be signed.'
      );
    }
    logger.info(`Application: Worker ${process.pid} started`);

    process.on('exit', () =>
      logger.warn(`Stopping wax-rng-oracle worker ${process.pid}.`)
    );
  }

  // Throw exception to crash the application or worker
  process.on('uncaughtException', reason => {
    logger.error(`Unhandled Exception: ${reason}.`);
    process.exit(1);
  });

  process.on('unhandledRejection', reason => {
    logger.error(`Unhandled Promise Rejection: ${reason}.`);
    process.exit(1);
  });
}

run().catch(err =>
  fatal(`Startup failed: ${err && err.stack ? err.stack : err}`)
);
