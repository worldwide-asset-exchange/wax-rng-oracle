let config = require('./config/configLoader').loadConfig();
const logger = require('./config/logger');
const metrics = require('./config/metrics');
const { getOrngContract, RpcError } = require('./config/eos');
const slack = require('./config/slack');

class Poller {
  /**
   * @param {string} owner
   * @param {ShareKeyService} shareKeyService
   * @param {RngPusher} rngPusher
   * @param {JobService} jobService
   */
  constructor(owner, shareKeyService, rngPusher, jobService, shareIndex) {
    this.owner = owner;
    this.shareKeyService = shareKeyService;
    this.rngPusher = rngPusher;
    this.jobService = jobService;
    this.shareIndex = shareIndex;
    this.pollJobsToSetPart = this.pollJobsToSetPart.bind(this);
    this.pollJobsToExecute = this.pollJobsToExecute.bind(this);
    this.clearResolvedFailures = this.clearResolvedFailures.bind(this);
    this.clearResolvedDeliveryFailures = this.clearResolvedDeliveryFailures.bind(
      this
    );
    this.monitorPendingJob = this.monitorPendingJob.bind(this);
    this.pollJobToRetryDeliver = this.pollJobToRetryDeliver.bind(this);
    this.cleanupDelivered = this.cleanupDelivered.bind(this);
  }

  /**
   * @returns {Promise<void>}
   */
  async pollJobsToSetPart() {
    metrics.gauge('set_rand_heart_beat', 1);
    const jobsToProcess = await this.jobService.getJobsToProcess();
    metrics.gauge('seeds_to_be_send_loaded', jobsToProcess.length);
    let successedJob = 0;
    let failedJob = 0;

    // Get share index from config
    const shareIndex = this.shareIndex;

    for (let job of jobsToProcess) {
      try {
        // Construct signing message from seed + dapp + nonce
        if (
          !job.seed ||
          job.nonce === undefined ||
          job.nonce === null ||
          !job.dapp
        ) {
          throw new Error('Unable to sign without seed or nonce or dapp.');
        }
        const messageBuffer = this.shareKeyService.make_msg(
          job.seed,
          job.dapp,
          job.nonce
        );
        const msgBuffer = Buffer.from(messageBuffer, 'hex');
        const signResult = await this.shareKeyService.sign(msgBuffer);
        const sig_i = signResult.signatureShare.toString(16);

        await this.rngPusher.submitPartialSignature(
          job,
          this.owner,
          job.ver,
          sig_i
        );
        metrics.increment('seeds_sent', { contract: job.dapp });
        logger.debug(`JobId: ${job.id} was sent successfully.`);
        successedJob++;
      } catch (err) {
        logger.error(`JobId: ${job.id} failed while trying to be send`);
        logger.error(err.stack);
        if (err instanceof RpcError) {
          let { error } = err.json;

          if (error.details[0].message.includes('no request found')) {
            logger.info(`Job ${job.id} is not valid`);
            break;
          }
          if (error.details[0].message.includes('duplicate part')) {
            logger.info(`Job ${job.id} is already processed`);
            metrics.increment('job_collision', { contract: job.dapp });
            break;
          }
        }
        metrics.increment('set_part_failed', { contract: job.dapp });
        await slack.postMessage(
          `*RNG poller ERROR*\nJob ID: ${job.id}\nDApp: ${
            job.dapp
          }\nAssociation ID: ${job.assoc_id}\n*Message*:\n${JSON.stringify(
            err
          )}\n`
        );
        failedJob++;
      }
    }
    if (jobsToProcess.length) {
      logger.info(`Process job. Success: ${successedJob}, Fail: ${failedJob}`);
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async pollJobsToExecute() {
    metrics.gauge('execute_heart_beat', 1);
    const jobsToExecute = await this.jobService.getJobsToExecute();
    metrics.gauge('seeds_to_execute_loaded', jobsToExecute.length);
    let successedJob = 0;
    let failedJob = 0;
    for (let job of jobsToExecute) {
      let finalSignature = null;
      let finalSignatureHex = null;

      try {
        // Combine partial signatures from job.parts to create final signature
        const messageBuffer = this.shareKeyService.make_msg(
          job.seed,
          job.dapp,
          job.nonce
        );
        const msgBuffer = Buffer.from(messageBuffer, 'hex');

        if (job.parts.length < config.get('shareKey.threshold')) {
          // not enough partial signatures to execute job
          continue;
        }

        finalSignature = this.shareKeyService.combinePartialSignatures(
          job.parts || [],
          msgBuffer
        );

        if (!finalSignature || finalSignature == 0) {
          logger.info('finalSignature is 0');
          continue;
        }

        logger.debug(`Final signature for job ${job.id} is ${finalSignature}`);

        finalSignatureHex = finalSignature.toString(16);

        await this.rngPusher.setRandomNumber(
          job,
          this.owner,
          job.ver,
          finalSignatureHex
        );

        metrics.increment('executed_job', { contract: job.dapp });
        logger.debug(`JobId: ${job.id} was executed successfully.`);
        successedJob++;
      } catch (err) {
        job = await this.jobService.jobSeedFailed(job);
        logger.error(`JobId: ${job.id} failed while trying to execute`);
        logger.error(err.stack);

        // Handle RPC errors and mark failed for V2 contract
        if (err instanceof RpcError) {
          let { error } = err.json;

          if (
            error.details &&
            error.details[0] &&
            error.details[0].message.includes('no request found')
          ) {
            // job is not valid or already executed (potential collision)
            logger.info(`Job ${job.id} is not valid or already executed`);
            metrics.increment('job_collision', { contract: job.dapp });
            continue;
          }

          // For delivery failures, try to mark as failed with pre-calculated signature
          if (finalSignature && finalSignature != 0 && finalSignatureHex) {
            try {
              let errorMessage = error.details[0].message;
              // should try to mark as failed if error come from contract call
              if (errorMessage) {
                await this.rngPusher.markFailed(
                  job,
                  this.owner,
                  job.ver,
                  finalSignatureHex,
                  errorMessage
                );
                logger.info(
                  `Job ${job.id} marked as failed due to delivery error: ${errorMessage}`
                );
              }
            } catch (markFailedErr) {
              logger.error(
                `Failed to mark job ${job.id} as failed: ${markFailedErr}`
              );
              metrics.increment('markfail_failed', { contract: job.dapp });
              await slack.postMessage(
                `*RNG poller markfailed ERROR*\nJob ID: ${job.id}\nDApp: ${
                  job.dapp
                }\nAssociation ID: ${
                  job.assoc_id
                }\n*Message*:\n${JSON.stringify(markFailedErr)}\n`
              );
            }
          }
        }

        metrics.increment('execute_failed', { contract: job.dapp });
        await slack.postMessage(
          `*RNG poller execute ERROR*\nJob ID: ${job.id}\nDApp: ${
            job.dapp
          }\nAssociation ID: ${job.assoc_id}\n*Message*:\n${JSON.stringify(
            err
          )}\n`
        );
        failedJob++;
      }
    }
    if (jobsToExecute.length) {
      logger.info(`Execute job. Success: ${successedJob}, Fail: ${failedJob}`);
    }
  }

  async monitorPendingJob() {
    const pendingJobs = await this.jobService.getPendingJobNumber();
    metrics.gauge('seeds_pending', pendingJobs);
    if (pendingJobs >= config.get('jobPendingAlert.maxJobPending')) {
      await slack.postMessage(
        `*RNG poller ALERT*\n Pending Job Number: ${pendingJobs}\n`
      );
    }
  }

  async clearResolvedFailures() {
    await this.jobService.clearResolvedFailures();
  }

  async clearResolvedDeliveryFailures() {
    await this.jobService.clearResolvedDeliveryFailures();
  }

  /**
   * @returns {Promise<void>}
   */
  async pollJobToRetryDeliver() {
    metrics.gauge('retry_deliver_heart_beat', 1);
    const undeliveredJobs = await this.jobService.getJobsToRetryDeliver();
    metrics.gauge('undelivered_jobs_loaded', undeliveredJobs.length);
    let successedJob = 0;
    let failedJob = 0;

    for (let undeliveredJob of undeliveredJobs) {
      try {
        await this.rngPusher.retryDeliver(
          this.owner,
          undeliveredJob.request_id
        );

        metrics.increment('retry_deliver_success', {
          dapp: undeliveredJob.dapp,
        });
        logger.debug(
          `Request ID: ${undeliveredJob.request_id} retry delivery successful.`
        );
        successedJob++;
      } catch (err) {
        logger.error(
          `Request ID: ${undeliveredJob.request_id} failed during retry delivery`
        );
        logger.error(err.stack);

        if (err instanceof RpcError) {
          let { error } = err.json;

          if (
            error.details &&
            error.details[0] &&
            error.details[0].message.includes('No undelivered result found')
          ) {
            logger.info(
              `Request ID ${undeliveredJob.request_id} no longer needs delivery`
            );
            continue;
          }
        }

        // Mark as delivery failure with retry logic
        await this.jobService.jobDeliverFail(undeliveredJob);

        metrics.increment('retry_deliver_failed', {
          dapp: undeliveredJob.dapp,
        });
        await slack.postMessage(
          `*RNG retry deliver ERROR*\\nRequest ID: ${
            undeliveredJob.request_id
          }\\nDApp: ${undeliveredJob.dapp}\\nAssoc ID: ${
            undeliveredJob.assoc_id
          }\\nError: ${
            undeliveredJob.error_message
          }\\n*Retry Message*:\\n${JSON.stringify(err)}\\n`
        );
        failedJob++;
      }
    }

    if (undeliveredJobs.length) {
      logger.info(
        `Retry deliver jobs. Success: ${successedJob}, Fail: ${failedJob}`
      );
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async cleanupDelivered() {
    metrics.gauge('cleanup_heart_beat', 1);

    try {
      await this.rngPusher.cleanup(this.owner, 10);
      logger.debug('Contract cleanup completed successfully');
      metrics.increment('cleanup_success');
    } catch (err) {
      logger.error('Failed to run contract cleanup');
      logger.error(err.stack);

      if (err instanceof RpcError) {
        let { error } = err.json;

        if (
          error.details &&
          error.details[0] &&
          error.details[0].message.includes('paused')
        ) {
          logger.info('Contract cleanup skipped - contract is paused');
          return;
        }
      }

      metrics.increment('cleanup_failed');
      await slack.postMessage(
        `*RNG cleanup ERROR*\\n*Message*:\\n${JSON.stringify(err)}\\n`
      );
    }
  }
}

module.exports = Poller;
