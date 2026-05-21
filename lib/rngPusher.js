const logger = require('./config/logger');
const { getOrngContract, RpcError } = require('./config/eos');

class RngPusher {
  constructor() {}

  /**
   * Submit partial signature for a request
   * @param {Object} job - The job object containing request details
   * @param {string} oracle - Oracle name submitting the partial signature
   * @param {number} ver - Key version
   * @param {string} sig_i - Partial signature
   * @returns {Promise<*>}
   */
  async submitPartialSignature(job, oracle, ver, sig_i) {
    try {
      const orngContract = getOrngContract();
      logger.info(
        'Submitting partial signature for request ' +
          job.id +
          ' with signature ' +
          sig_i
      );
      let res = await orngContract.submitpart(oracle, job.id, ver, sig_i);
      return { transactionId: res.processed.id, tx: res.processed };
    } catch (err) {
      if (err instanceof RpcError) {
        let { error } = err.json;
        if (error.details[0].message.includes('no request found')) {
          logger.warn(`Request ${job.id} does not exist`);
          return false;
        }

        if (error.details[0].message.includes('unknown oracle')) {
          logger.warn(`Oracle ${oracle} is unknown`);
          return false;
        }

        if (error.details[0].message.includes('oracle suspended')) {
          logger.warn(`Oracle ${oracle} is suspended`);
          return false;
        }

        if (error.details[0].message.includes('version mismatch')) {
          logger.warn(`Version mismatch for request ${job.id}`);
          return false;
        }

        if (error.details[0].message.includes('duplicate part')) {
          logger.warn(
            `Duplicate partial signature for request ${job.id}, sig_i ${sig_i}`
          );
          return false;
        }

        if (
          error.details[0].message.includes('duplicate') ||
          error.details[0].message.includes('Duplicate') ||
          error.details[0].message.includes('Conflict')
        ) {
          logger.warn(`Request ${job.id} already has partial signature`);
          return false;
        }

        if (error.details[0].message.includes('deadline exceeded')) {
          return false;
        }

        if (error.details[0].message.includes('paused')) {
          logger.warn('Contract is paused');
          return false;
        }
      }
      logger.error(
        `Error while trying to submit partial signature for request ${job.id}. ${err}`
      );
      logger.error(err);
      throw err;
    }
  }

  /**
   * Complete request with final signature
   * @param {Object} job - The job object containing request details
   * @param {string} oracle - Oracle name submitting the final signature
   * @param {number} ver - Key version
   * @param {string} sig - Final signature
   * @returns {Promise<*>}
   */
  async setRandomNumber(job, oracle, ver, sig) {
    try {
      const orngContract = getOrngContract();

      let res = await orngContract.setrand(oracle, job.id, ver, sig);
      return { transactionId: res.processed.id, tx: res.processed };
    } catch (err) {
      if (err instanceof RpcError) {
        let { error } = err.json;
        if (error.details[0].message.includes('no request found')) {
          logger.warn(`Request ${job.id} does not exist`);
          return false;
        }

        if (error.details[0].message.includes('unknown oracle')) {
          logger.warn(`Oracle ${oracle} is unknown`);
          return false;
        }

        if (error.details[0].message.includes('version mismatch')) {
          logger.warn(`Version mismatch for request ${job.id}`);
          return false;
        }

        if (error.details[0].message.includes('key not found')) {
          logger.warn(`Key version ${ver} not found`);
          return false;
        }

        if (
          error.details[0].message.includes('duplicate') ||
          error.details[0].message.includes('Duplicate') ||
          error.details[0].message.includes('Conflict')
        ) {
          logger.warn(`Request ${job.id} already completed`);
          return false;
        }

        if (error.details[0].message.includes('deadline exceeded')) {
          return false;
        }

        if (error.details[0].message.includes('paused')) {
          logger.warn('Contract is paused');
          return false;
        }
      }
      logger.error(
        `Error while trying to set random number for request ${job.id}. ${err}`
      );
      throw err;
    }
  }

  /**
   * Mark request as failed with error message
   * @param {Object} job - The job object containing request details
   * @param {string} oracle - Oracle name marking the request as failed
   * @param {number} ver - Key version
   * @param {string} sig - Final signature that was computed
   * @param {string} error_message - Error message encountered during delivery
   * @returns {Promise<*>}
   */
  async markFailed(job, oracle, ver, sig, error_message) {
    try {
      const orngContract = getOrngContract();
      logger.info(
        `Marking request ${job.id} as failed with error: ${error_message}`
      );
      let res = await orngContract.markfailed(
        oracle,
        job.id,
        ver,
        sig,
        error_message
      );
      return { transactionId: res.processed.id, tx: res.processed };
    } catch (err) {
      if (err instanceof RpcError) {
        let { error } = err.json;
        if (error.details[0].message.includes('no request found')) {
          logger.warn(`Request ${job.id} does not exist`);
          return false;
        }

        if (error.details[0].message.includes('unknown oracle')) {
          logger.warn(`Oracle ${oracle} is unknown`);
          return false;
        }

        if (error.details[0].message.includes('oracle suspended')) {
          logger.warn(`Oracle ${oracle} is suspended`);
          return false;
        }

        if (error.details[0].message.includes('version mismatch')) {
          logger.warn(`Version mismatch for request ${job.id}`);
          return false;
        }

        if (error.details[0].message.includes('paused')) {
          logger.warn('Contract is paused');
          return false;
        }
      }
      logger.error(
        `Error while trying to mark request ${job.id} as failed. ${err}`
      );
      throw err;
    }
  }

  /**
   * Retry delivery of undelivered result
   * @param {string} oracle - Oracle name retrying delivery
   * @param {number} request_id - Internal request ID from undelivered table
   * @returns {Promise<*>}
   */
  async retryDeliver(oracle, request_id) {
    try {
      const orngContract = getOrngContract();
      logger.info(
        `Oracle ${oracle} retrying delivery for request ID ${request_id}`
      );
      let res = await orngContract.retrydeliver(oracle, request_id);
      return { transactionId: res.processed.id, tx: res.processed };
    } catch (err) {
      if (err instanceof RpcError) {
        let { error } = err.json;
        if (error.details[0].message.includes('No undelivered result found')) {
          logger.warn(
            `No undelivered result found for request ID ${request_id}`
          );
          return false;
        }

        if (error.details[0].message.includes('unknown oracle')) {
          logger.warn(`Oracle ${oracle} is unknown`);
          return false;
        }

        if (error.details[0].message.includes('oracle suspended')) {
          logger.warn(`Oracle ${oracle} is suspended`);
          return false;
        }

        if (error.details[0].message.includes('paused')) {
          logger.warn('Contract is paused');
          return false;
        }
      }
      logger.error(
        `Error while trying to retry delivery for request ID ${request_id}. ${err}`
      );
      throw err;
    }
  }

  async verifySig2(sig_val, signature, exponent, modulus) {
    const orngContract = getOrngContract();

    let res = await orngContract.verifysig2(
      sig_val,
      signature,
      exponent,
      modulus
    );
    return { transactionId: res.processed.id, tx: res.processed };
  }

  /**
   * Clean up expired undelivered results
   * @returns {Promise<*>}
   */
  async cleanup(oracle, batch_size = 10) {
    try {
      const orngContract = getOrngContract();
      logger.info(
        'Running cleanup of expired undelivered results' +
          oracle +
          ':' +
          batch_size
      );
      let res = await orngContract.cleanup(oracle, batch_size);
      return { transactionId: res.processed.id, tx: res.processed };
    } catch (err) {
      if (err instanceof RpcError) {
        let { error } = err.json;
        if (error.details[0].message.includes('paused')) {
          logger.warn('Contract is paused');
          return false;
        }
      }
      logger.error(`Error while trying to cleanup expired results. ${err}`);
      throw err;
    }
  }

  /**
   * Log error for a request
   * @param {Object} job - The job object containing request details
   * @param {string} message - Error message to log
   * @returns {Promise<*>}
   */
  async logError(job, message) {
    try {
      const orngContract = getOrngContract();

      // Updated parameter order: dapp, job_id, message
      let res = await orngContract.dapperror(
        job.dapp || job.caller,
        job.id,
        message
      );
      return { transactionId: res.processed.id, tx: res.processed };
    } catch (err) {
      if (err instanceof RpcError) {
        let { error } = err.json;
        if (error.details[0].message.includes('Could not find job id')) {
          logger.warn(`Job ${job.id} does not exist`);
          return false;
        }

        if (error.details[0].message.includes('dapp caller mismatch')) {
          logger.warn(`DApp caller mismatch for job ${job.id}`);
          return false;
        }

        if (
          error.details[0].message.includes('duplicate') ||
          error.details[0].message.includes('Duplicate') ||
          error.details[0].message.includes('Conflict')
        ) {
          logger.warn(`Error already logged for job ${job.id}`);
          return false;
        }

        if (
          error.details[0].message.includes('transaction declares authority') ||
          error.details[0].message.includes(
            'action declares irrelevant authority'
          )
        ) {
          logger.warn(
            'Log error for job ' +
              job.id +
              ' missing permission: ' +
              error.details[0].message
          );
          return false;
        }
      }
      logger.error(`Error while trying to log error for job ${job.id}. ${err}`);
      // Don't throw error for logging failures
    }
  }
}

module.exports = RngPusher;
