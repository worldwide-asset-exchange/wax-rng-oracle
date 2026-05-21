const logger = require("../config/logger");
const { validationResult } = require("express-validator");
const { InvalidParameterError } = require('../exceptions/invalidParameterError')

class JobsController {
  /**
   * @param {JobService} jobService
   */
  constructor(jobService) {
    this.jobService = jobService;
    this.getJob = this.getJob.bind(this);
    this.getJobs = this.getJobs.bind(this);
  }

  /**
   * @api {get} /jobs/:id GetOrder
   * @apiDescription Get order for a given orderId
   * @apiVersion 1.0.0
   * @apiName GetOrder
   * @apiGroup Orders
   *
   * @apiHeader Content-type application/json
   *
   * @apiParam {Number} id     Job Id
   *
   * @apiSuccess {String} jobs       List of existing jobs
   * @apiSuccessExample {json} Success-Response:
   * {"jobs": []}
   *
   **/
  async getJob(req, res, next) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        let errorMessages = errors.array().map(err => err.msg);
        throw new InvalidParameterError(errorMessages);
      }
      let { id } = req.params;
      let job = await this.jobService.getJobById(id);
      res.json(job)
    } catch (err) {
      logger.error(err);
      next(err);
    }
  }

  /**
   * @api {get} /jobs GetJobs
   * @apiDescription Get all the existing jobs
   * @apiVersion 1.0.0
   * @apiName GetSeeds
   * @apiGroup Seeds
   *
   * @apiHeader Content-type application/json
   *
   * @apiParam {Number} from     Seeds starting for the given orderId
   * @apiParam {Number} limit    Amount of jobs to be returned
   *
   * @apiSuccess {String} jobs       List of existing jobs
   * @apiSuccessExample {json} Success-Response:
   * {"jobs": [{"orderId":18,"seed":"768d8b","transactionId":"6aee3cc19cf0dc76421eef4e3de9941389a7bdae198a4a0d565db518b12ebb4d","blockNumber":null,"status":1,"retries":1,"last_updated":"2018-11-06T20:00:06.000Z"}]}
   *
   **/
  async getJobs(req, res, next) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        let errorMessages = errors.array().map(err => err.msg);
        throw new InvalidParameterError(errorMessages);
      }

      let { from, limit } = req.query;
      let jobs = await this.jobService.getJobsPaged(parseInt(from), parseInt(limit));

      res.json({ jobs })
    } catch (err) {
      logger.error(err);
      next(err);
    }
  }
}

module.exports = JobsController;
