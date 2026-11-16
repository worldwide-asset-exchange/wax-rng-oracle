const logger = require('../config/logger');

/**
 * Seconds between now and the node's head block, or null when get_info did not
 * return a parseable head_block_time (nodeos prints it without a zone: UTC).
 */
function headBlockLag(info, now = Date.now()) {
  if (!info || typeof info.head_block_time !== 'string') return null;
  const t = info.head_block_time;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + 'Z');
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((now - ms) / 1000));
}

class HealthCheckController {
  /**
   * @param {EosRpc} eosRpc
   * @param {() => {ran: boolean, ok: boolean}} [getBootCheckStatus]  booleans
   *   from lib/bootChecks; when given, the endpoint reports them and a member
   *   whose boot self-check did not pass is unhealthy.
   */
  constructor(eosRpc, getBootCheckStatus) {
    this.getStatus = this.getStatus.bind(this);
    this.eosRpc = eosRpc;
    this.getBootCheckStatus = getBootCheckStatus;
  }

  /**
   * @apiVersion 1.0.0
   * @api {get} /health-check GetHealthCheck
   * @apiDescription Get Health Status from App
   * @apiName HealthCheck
   * @apiGroup HealthCheck
   * @apiHeader Content-type application/json
   *
   * @apiSuccess {Boolean} healthy  Value describing readyness and live status of node
   * @apiSuccess {Boolean} eos      Value describing eos node specific status
   * @apiSuccess {Number}  headBlockLagSeconds  age of the API node's head block
   *   when get_info answered (null when it did not); informational
   * @apiSuccess {Object}  bootCheck  Boot self-check outcome (booleans only):
   *   ran, ok, rpcReachable, activeKeyFound, shareConsistent, activeVer
   *
   * @apiSuccessExample {JSON} Success-Response:
   * {
   *   "healthy": true,
   *   "eos": true,
   *   "headBlockLagSeconds": 1,
   *   "bootCheck": { "ran": true, "ok": true, "rpcReachable": true,
   *                  "activeKeyFound": true, "shareConsistent": true, "activeVer": 1 }
   * }
   * @apiError (500) Error Some of the dependencies are unhealthy
   **/

  async getStatus(req, res, next) {
    let eos;
    let headBlockLagSeconds = null;
    try {
      const info = await this.eosRpc.get_info();
      eos = true;
      headBlockLagSeconds = headBlockLag(info);
    } catch (err) {
      logger.error(err);
      eos = false;
    }

    let healthy = !!eos;
    // The lag is reported, not judged: a node a few seconds behind still
    // answers, but a member polling a node minutes behind head misses every
    // request (it only sees them once they are gone). Alert on it host-side.
    const body = { healthy, eos, headBlockLagSeconds };
    if (this.getBootCheckStatus) {
      const bootCheck = this.getBootCheckStatus();
      body.bootCheck = bootCheck;
      healthy = healthy && bootCheck.ok === true;
      body.healthy = healthy;
    }
    healthy ? res.status(200) : res.status(500);

    res.json(body);
  }
}

module.exports = HealthCheckController;
module.exports.headBlockLag = headBlockLag;
