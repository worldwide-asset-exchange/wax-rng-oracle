let config = require('./config/configLoader').loadConfig();
const logger = require('./config/logger');
const metrics = require('./config/metrics');
const { getOrngContract, RpcError } = require('./config/eos');
const slack = require('./config/slack');
const ShareKeyService = require('./shareKeyService');
const Storage = require('./storage');

const { isCombineError } = ShareKeyService;
const { partsFingerprint } = Storage;

class Poller {
  /**
   * @param {string} owner
   * @param {ShareKeyService} shareKeyService
   * @param {RngPusher} rngPusher
   * @param {JobService} jobService
   */
  /**
   * @param {{activeKeyVersion?: number, combineAlertIntervalMs?: number}} [options]
   *   activeKeyVersion: the pubkeys version the boot self-check verified this
   *   member's share against. Requests carrying any other `ver` are skipped
   *   (never signed, never combined) — after a key rotation, or with a lagging
   *   RPC at boot, the member must restart and re-check rather than submit
   *   partials from the wrong share. index.js always passes it; a harness that
   *   omits it gets no guard and a warning.
   */
  constructor(
    owner,
    shareKeyService,
    rngPusher,
    jobService,
    shareIndex,
    options = {}
  ) {
    this.owner = owner;
    this.shareKeyService = shareKeyService;
    this.rngPusher = rngPusher;
    this.jobService = jobService;
    this.shareIndex = shareIndex;
    this.activeKeyVersion = Number.isInteger(options.activeKeyVersion)
      ? options.activeKeyVersion
      : null;
    if (this.activeKeyVersion === null) {
      logger.warn(
        'Poller started without activeKeyVersion — key-version guard disabled (test harness only)'
      );
    }
    this.skippedVersions = new Set();
    // one Slack post per interval for combine failures, with a suppressed count
    this.combineAlertIntervalMs = Number.isFinite(
      options.combineAlertIntervalMs
    )
      ? options.combineAlertIntervalMs
      : 60 * 1000;
    this.combineAlert = { lastPostAt: 0, suppressed: 0 };
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
   * True when this member may act on the request's key version. Logged once
   * per unknown version (plus a metric) so a rotation is visible, not noisy.
   */
  isKnownKeyVersion(job) {
    if (this.activeKeyVersion === null || job.ver === this.activeKeyVersion) {
      return true;
    }
    if (!this.skippedVersions.has(job.ver)) {
      this.skippedVersions.add(job.ver);
      logger.error(
        `Request ${job.id} carries key version ${job.ver} but this member verified its share against version ${this.activeKeyVersion} — skipping every request of that version until restarted and re-checked`
      );
    }
    metrics.increment('key_version_skipped', { ver: String(job.ver) });
    return false;
  }

  /**
   * Slack post for a combine failure, throttled to one per interval; the
   * suppressed count rides along so volume is still visible.
   */
  async postCombineAlert(text) {
    const now = Date.now();
    if (now - this.combineAlert.lastPostAt < this.combineAlertIntervalMs) {
      this.combineAlert.suppressed++;
      return false;
    }
    const suppressed = this.combineAlert.suppressed;
    this.combineAlert = { lastPostAt: now, suppressed: 0 };
    await slack.postMessage(
      text +
        (suppressed
          ? `(+${suppressed} similar alert(s) suppressed in the last ${Math.round(
              this.combineAlertIntervalMs / 1000
            )}s)\n`
          : '')
    );
    return true;
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
      if (!this.isKnownKeyVersion(job)) {
        continue;
      }
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
      if (!this.isKnownKeyVersion(job)) {
        continue;
      }
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

        const combine = this.shareKeyService.combinePartialSignatures(
          job.parts || [],
          msgBuffer
        );
        this.logCombineDiagnostics(job, combine);
        // the library's canonical string: lower-case hex, bits/4 wide, < n —
        // handed to setrand unchanged
        finalSignature = combine.signature;

        if (!finalSignature) {
          logger.info('finalSignature is empty');
          continue;
        }

        logger.debug(`Final signature for job ${job.id} is ${finalSignature}`);

        finalSignatureHex = finalSignature;

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
        if (isCombineError(err)) {
          // The parts on chain do not combine (malformed / out-of-range partial,
          // fewer than k well-formed parts, or no k-subset verifies). Not a
          // crash and not an RPC error: record it pinned to this parts set so
          // the job is retried only once the parts change, log who was rejected.
          await this.jobService.jobSeedFailed(job, {
            partsFingerprint: partsFingerprint(job.parts),
          });
          const rejected = (err.rejectedShares || []).map(
            r => `${r.shareIndex}@${r.position}:${r.reason}`
          );
          const subsets = (err.attemptedSubsets || []).map(
            s => `[${s.join(',')}]`
          );
          logger.error(
            `JobId: ${job.id} combine failed (${err.code}) on oracle index ${
              this.shareIndex
            }: rejected parts [${rejected.join(
              ', '
            )}], failed subsets ${subsets.join(' ') ||
              'none'} — parked until parts change`
          );
          metrics.increment('combine_failed', {
            contract: job.dapp,
            code: err.code,
          });
          metrics.increment('execute_failed', { contract: job.dapp });
          await this.postCombineAlert(
            `*RNG poller combine ERROR*\nJob ID: ${job.id}\nDApp: ${
              job.dapp
            }\nAssociation ID: ${job.assoc_id}\nOracle index: ${
              this.shareIndex
            }\nCode: ${err.code}\nRejected parts: ${rejected.join(', ') ||
              'none'}\n`
          );
          failedJob++;
          continue;
        }

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

  /**
   * Surface what the combine had to work around: partials rejected before the
   * combine (by share index + position + reason — never the value), k-subsets
   * that did not verify, and the share index(es) implicated by every failed
   * subset. Silent on a clean combine.
   */
  logCombineDiagnostics(job, combine) {
    const rejected = combine.rejectedShares || [];
    const failedSubsets = combine.failedSubsets || [];
    const suspects = combine.suspectShareIndices || [];
    if (!rejected.length && !failedSubsets.length) {
      return;
    }
    logger.warn(
      'Combine diagnostics ' +
        JSON.stringify({
          jobId: job.id,
          dapp: job.dapp,
          oracleIndex: this.shareIndex,
          usedShareIndices: combine.usedShareIndices,
          rejectedShares: rejected.map(r => ({
            shareIndex: r.shareIndex,
            position: r.position,
            reason: r.reason,
          })),
          failedSubsets,
          suspectShareIndices: suspects,
          attempts: combine.attempts,
        })
    );
    for (const r of rejected) {
      metrics.increment('combine_rejected_part', {
        contract: job.dapp,
        idx: String(r.shareIndex),
      });
    }
    for (const idx of suspects) {
      metrics.increment('combine_suspect_share', {
        contract: job.dapp,
        idx: String(idx),
      });
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
