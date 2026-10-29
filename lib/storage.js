const crypto = require('crypto');
const low = require('lowdb');
const FileAsync = require('lowdb/adapters/FileAsync');

/**
 * Stable fingerprint of a job's on-chain parts[] (order-independent). A combine
 * that failed on a given set of partials is not retried until that set changes
 * (another member submits, or the request is re-created) — retrying the
 * identical rejected parts can only fail the same way.
 */
function partsFingerprint(parts) {
  const rows = (Array.isArray(parts) ? parts : [])
    .map(p => `${p && p.idx}:${p && p.sig_i}`)
    .sort();
  return crypto
    .createHash('sha256')
    .update(rows.join('|'))
    .digest('hex');
}

class Storage {
  constructor(maxRetries) {
    this.maxRetryDuration = Math.pow(2, maxRetries) * 500;
  }

  /**
   * Must be called before using an instance of this class
   */

  async init(dbFile, modulus, total) {
    const adapter = new FileAsync(dbFile, {
      defaultValue: { failures: {}, delivery_failures: {} },
    });
    this.db = await low(adapter);
    let deliveryFailures = this.db.get('delivery_failures').value();
    if (!deliveryFailures) {
      await this.db.set('delivery_failures', {}).write();
    }
    if (Number.isInteger(modulus) && Number.isInteger(total)) {
      await this.db.set('process', { modulus, total }).write();
    }
  }

  isJobOfThisProcess(job) {
    let process = this.db.get('process').value();
    if (process && process.modulus && process.total) {
      if (+job.id % process.total !== +process.modulus) {
        return false;
      }
    }
    return true;
  }

  shouldExecuteJob(job) {
    let failures = this.db.get('failures').value();
    let failedJob = failures[job.id];
    if (!failedJob) {
      return true;
    }
    // A combine failure is pinned to the parts it failed on: same parts, no retry.
    if (
      failedJob.partsFingerprint &&
      failedJob.partsFingerprint === partsFingerprint(job.parts)
    ) {
      return false;
    }
    return this._shouldRetry(failedJob);
  }

  /**
   * Record a failed execution attempt (exponential backoff on repeats).
   * @param {Object} job
   * @param {{partsFingerprint?: string}} [meta]  set by the poller when the
   *   combine itself rejected the parts — pins the failure to that parts set
   */
  async jobFailed(job, meta = {}) {
    let failures = this.db.get('failures').value();
    let failedJob = await failures[job.id];
    if (failedJob) {
      failedJob.nextRetry *= 2;
    } else {
      failedJob = failures[job.id] = this._newFailure(job);
    }
    if (meta.partsFingerprint) {
      failedJob.partsFingerprint = meta.partsFingerprint;
    } else {
      delete failedJob.partsFingerprint;
    }
    await this.db.write();
    return failures[job.id];
  }

  async clearFailedJobs(ids) {
    const failures = this.db.get('failures').value();
    for (let id of ids) {
      delete failures[id];
    }
    await this.db.write();
  }

  /**
   * Get jobs that have exceeded the max retry limit
   */
  getTimedOutJobIds() {
    return this.db
      .get('failures')
      .filter(failedJob => this._isTimedOut(failedJob))
      .map('id')
      .value();
  }

  getAllFailedJobs() {
    return this.db
      .get('failures')
      .map()
      .value();
  }

  /**
   * For testing
   */
  getFailedJobById(id) {
    const failures = this.db.get('failures').value();
    return failures[id];
  }

  /**
   * For testing
   */
  async setFailedJob(job) {
    const failures = this.db.get('failures').value();
    failures[job.id] = job;
    await this.db.write();
  }

  /**
   * For testing
   */
  async clearAllFailedJobs() {
    let failures = this.db.get('failures').value();
    for (let id in failures) delete failures[id];
    await this.db.write();
  }

  /////// Private members/helpers ////////

  _newFailure(job) {
    return {
      id: job.id,
      nonce: job.nonce,
      ver: job.ver,
      seed: job.seed,
      dapp: job.dapp,
      createdAt: Date.now(),
      nextRetry: 500,
    };
  }

  _isTimedOut(failedJob) {
    return failedJob.nextRetry >= this.maxRetryDuration;
  }

  _shouldRetry(failedJob) {
    return (
      Date.now() >= failedJob.createdAt + failedJob.nextRetry &&
      failedJob.nextRetry < this.maxRetryDuration
    );
  }

  // Delivery failure methods
  shouldRetryDelivery(undeliveredJob) {
    let deliveryFailures = this.db.get('delivery_failures').value();
    if (!deliveryFailures) {
      return true; // First attempt
    }
    let failedDelivery = deliveryFailures[undeliveredJob.request_id];
    if (!failedDelivery) {
      return true; // First attempt
    }
    return this._shouldRetryDelivery(failedDelivery);
  }

  async jobDeliverFail(undeliveredJob) {
    let deliveryFailures = this.db.get('delivery_failures').value();
    if (!deliveryFailures) {
      deliveryFailures = {};
    }
    let failedDelivery = deliveryFailures[undeliveredJob.request_id];
    if (failedDelivery) {
      failedDelivery.nextRetry *= 2;
    } else {
      deliveryFailures[undeliveredJob.request_id] = this._newDeliveryFailure(
        undeliveredJob
      );
    }
    await this.db.set('delivery_failures', deliveryFailures).write();
    return deliveryFailures[undeliveredJob.request_id];
  }

  async clearDeliveryFailures(requestIds) {
    const deliveryFailures = this.db.get('delivery_failures').value();
    for (let requestId of requestIds) {
      delete deliveryFailures[requestId];
    }
    await this.db.write();
  }

  getTimedOutDeliveryJobIds() {
    return this.db
      .get('delivery_failures')
      .filter(failedDelivery => this._isDeliveryTimedOut(failedDelivery))
      .map('request_id')
      .value();
  }

  getAllFailedDeliveries() {
    return this.db
      .get('delivery_failures')
      .map()
      .value();
  }

  _newDeliveryFailure(undeliveredJob) {
    return {
      request_id: undeliveredJob.request_id,
      dapp: undeliveredJob.dapp,
      assoc_id: undeliveredJob.assoc_id,
      error_message: undeliveredJob.error_message,
      createdAt: Date.now(),
      nextRetry: 500,
    };
  }

  _isDeliveryTimedOut(failedDelivery) {
    return failedDelivery.nextRetry >= this.maxRetryDuration;
  }

  _shouldRetryDelivery(failedDelivery) {
    return (
      Date.now() >= failedDelivery.createdAt + failedDelivery.nextRetry &&
      failedDelivery.nextRetry < this.maxRetryDuration
    );
  }
}

Storage.partsFingerprint = partsFingerprint;

module.exports = Storage;
