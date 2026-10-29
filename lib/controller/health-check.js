const logger = require('../config/logger');

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
   * @apiSuccess {Object}  bootCheck  Boot self-check outcome (booleans only):
   *   ran, ok, rpcReachable, activeKeyFound, shareConsistent, activeVer
   *
   * @apiSuccessExample {JSON} Success-Response:
   * {
   *   "healthy": true,
   *   "eos": true,
   *   "bootCheck": { "ran": true, "ok": true, "rpcReachable": true,
   *                  "activeKeyFound": true, "shareConsistent": true, "activeVer": 1 }
   * }
   * @apiError (500) Error Some of the dependencies are unhealthy
   **/

  async getStatus(req, res, next) {
    let eos;
    try {
      await this.eosRpc.get_info();
      eos = true;
    } catch (err) {
      logger.error(err);
      eos = false;
    }

    let healthy = !!eos;
    const body = { healthy, eos };
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
