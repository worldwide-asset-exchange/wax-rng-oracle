const logger = require("../config/logger");

class HealthCheckController {
  /**
   * @param {EosRpc} eosRpc
   */
  constructor(eosRpc) {
    this.getStatus = this.getStatus.bind(this);
    this.eosRpc = eosRpc;
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
* @apiSuccess {Boolean} db       Value describing db specific status
* @apiSuccess {Boolean} eos      Value describing eos node specific status
*
* @apiSuccessExample {JSON} Success-Response:
* {
*   "healthy": true,
*   "db": true,
*   "eos": true
* }
* @apiError (500) Error Some of the dependencies are unhealthy
**/

  async getStatus (req, res, next) {
    let eos;
    try {
      let result = await this.eosRpc.get_info();
      eos = true;
    } catch (err) {
      logger.error(err)
      eos = false;
    }
    
    let healthy = !!eos;
    healthy ? res.status(200) : res.status(500);
    
    res.json({healthy, eos});
  }
}

module.exports = HealthCheckController;
