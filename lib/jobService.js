let config = require('./config/configLoader').loadConfig();
const logger = require('./config/logger');
const metrics = require('./config/metrics');
const { eosRpc } = require('./config/eos');
const { EosError } = require('./exceptions/eosError');
const { shuffleArray, generateDailySeed } = require('./utils/shuffle');

class JobService {
  constructor(storage, keyIndex) {
    if (!keyIndex || !storage) {
      throw new Error('keyIndex is required');
    }
    this.storage = storage;
    this.keyIndex = keyIndex;
  }

  /**
   * Get the process modulus from storage (used for cluster mode)
   * @returns {number|undefined} - Process modulus or undefined if not set
   */
  getProcessModulus() {
    const process = this.storage.db.get('process').value();
    return process && Number.isInteger(process.modulus)
      ? process.modulus
      : undefined;
  }

  /**
   * Returns information about all existing jobs
   * @param {number} from    Seeds starting for the given jobId
   * @param {number} limit   Amount of jobs to be returned
   * @returns {Promise<Job[]>}
   */
  async getJobsPaged(from, limit) {
    const { rows } = await this.getJobsHelper({ lower_bound: from, limit });
    return rows;
  }

  async getJobsHelper(params = { limit: 100 }) {
    try {
      return await eosRpc.get_table_rows({
        json: true,
        code: config.get('eos.orng.contractName'),
        scope: config.get('eos.orng.contractName'),
        table: 'reqs',
        ...params,
      });
    } catch (e) {
      throw new EosError(e);
    }
  }

  /**
   * Returns a number of pending jobIds.
   * @returns {Promise<Job[]>}
   */
  async getPendingJobNumber() {
    try {
      let pendingJobsNumber = 0;
      let more = true;
      let rows = [];
      let next_key = 0;
      const limit = 1000;
      do {
        ({ rows, more, next_key } = await this.getJobsHelper({
          lower_bound: next_key,
          limit,
        }));
        pendingJobsNumber += rows.length;
      } while (more);
      return pendingJobsNumber;
    } catch (e) {
      logger.error(`Error while trying to count pending job. ${e.message}`);
      throw e;
    }
  }

  /**
   * Returns a list of jobs ready to be processed.
   * @returns {Promise<Job[]>}
   */
  async getJobsToProcess() {
    try {
      const startTime = new Date();
      let results = [];
      let more = true;
      let rows = [];
      const limit = 100;
      let next_key = 0;
      do {
        ({ rows, more, next_key } = await this.getJobsHelper({
          lower_bound: next_key,
          limit,
        }));
        results = results.concat(rows.filter(job => this.shouldTryJob(job)));
      } while (results.length < limit && more);
      metrics.timing('eos.response_time.get_seeds_to_be_send', startTime);

      // Apply Fisher-Yates shuffle with oracle-specific seed to reduce collisions
      // Include process modulus for cluster mode to ensure each worker has different order
      const seed = generateDailySeed(this.keyIndex, this.getProcessModulus());
      return shuffleArray(results, seed);
    } catch (e) {
      logger.error(
        `Error while trying to get seeds ready to be send. ${e.message}`
      );
      throw e;
    }
  }

  /**
   * Returns a list of jobs ready to execute.
   * @returns {Promise<Job[]>}
   */
  async getJobsToExecute() {
    try {
      const startTime = new Date();
      let results = [];
      let more = true;
      let rows = [];
      const limit = 100;
      let next_key = 0;
      do {
        ({ rows, more, next_key } = await this.getJobsHelper({
          lower_bound: next_key,
          limit,
        }));
        results = results.concat(
          rows.filter(job => this.shouldExecuteJob(job))
        );
      } while (results.length < limit && more);
      metrics.timing('eos.response_time.get_job_to_execute', startTime);

      // Apply Fisher-Yates shuffle with oracle-specific seed to reduce collisions
      // Include process modulus for cluster mode to ensure each worker has different order
      const seed = generateDailySeed(this.keyIndex, this.getProcessModulus());
      return shuffleArray(results, seed);
    } catch (e) {
      logger.error(
        `Error while trying to get job ready to execute. ${e.message}`
      );
      throw e;
    }
  }

  /**
   * Returns the job for a given jobId
   * @param {number} jobId
   * @returns {Promise<JobCreated>}
   */
  async getJobById(jobId) {
    const { rows } = await this.getJobsHelper({
      lower_bound: jobId,
      upper_bound: jobId,
    });
    return rows[0];
  }

  async clearJobs(ids) {
    await this.storage.clearFailedJobs(ids);
  }

  async getJobIdsToDelete() {
    return this.storage.getTimedOutJobIds();
  }

  async jobSeedFailed(job) {
    return await this.storage.jobFailed(job);
  }

  isTimedOut(job) {
    return this.storage._isTimedOut(job);
  }

  async clearResolvedFailures() {
    let resolvedJobIds = [];
    for (let failedJob of this.storage.getAllFailedJobs()) {
      const job = await this.getJobById(failedJob.id);
      if (!job || job.seed !== failedJob.seed) {
        resolvedJobIds.push(failedJob.id);
      }
    }
    await this.storage.clearFailedJobs(resolvedJobIds);
  }

  async clearResolvedDeliveryFailures() {
    let resolvedRequestIds = [];
    for (let failedDelivery of this.storage.getAllFailedDeliveries()) {
      const undeliveredJob = await this.getUndeliveredJobByRequestId(
        failedDelivery.request_id
      );
      if (!undeliveredJob) {
        resolvedRequestIds.push(failedDelivery.request_id);
      }
    }
    await this.storage.clearDeliveryFailures(resolvedRequestIds);
  }

  shouldTryJob(job) {
    if (!this.storage.isJobOfThisProcess(job)) {
      return false;
    }
    // check if parts contain this shareIndex
    const shareIndex = this.keyIndex;
    if (job.parts.some(part => part.idx === shareIndex)) {
      return false;
    }
    return true;
  }

  shouldExecuteJob(job) {
    // should execute if parts contain enough share signature (larger than threshold)
    const threshold = config.get('shareKey.threshold');

    if (!job.parts || job.parts.length < threshold) {
      return false;
    }

    return this.storage.shouldExecuteJob(job);
  }

  /**
   * Returns a list of undelivered jobs ready for retry delivery.
   * @returns {Promise<UndeliveredJob[]>}
   */
  async getJobsToRetryDeliver() {
    try {
      const startTime = new Date();
      let results = [];
      let more = true;
      let rows = [];
      const limit = 100;
      let next_key = 0;
      do {
        ({ rows, more, next_key } = await this.getUndeliveredHelper({
          lower_bound: next_key,
          limit,
        }));
        results = results.concat(
          rows.filter(undeliveredJob =>
            this.shouldRetryDelivery(undeliveredJob)
          )
        );
      } while (results.length < limit && more);
      metrics.timing('eos.response_time.get_undelivered_to_retry', startTime);
      return results;
    } catch (e) {
      logger.error(
        `Error while trying to get undelivered jobs ready for retry. ${e.message}`
      );
      throw e;
    }
  }

  async getUndeliveredHelper(params = { limit: 100 }) {
    try {
      return await eosRpc.get_table_rows({
        json: true,
        code: config.get('eos.orng.contractName'),
        scope: config.get('eos.orng.contractName'),
        table: 'undelivered',
        ...params,
      });
    } catch (e) {
      throw new EosError(e);
    }
  }

  shouldRetryDelivery(undeliveredJob) {
    return this.storage.shouldRetryDelivery(undeliveredJob);
  }

  async jobDeliverFail(undeliveredJob) {
    return await this.storage.jobDeliverFail(undeliveredJob);
  }

  async getUndeliveredJobByRequestId(requestId) {
    const { rows } = await this.getUndeliveredHelper({
      lower_bound: requestId,
      upper_bound: requestId,
    });
    return rows[0];
  }
}

module.exports = JobService;
