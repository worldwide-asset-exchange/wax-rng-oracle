const express = require("express");
const { check } = require("express-validator");
const {version} = require('../../package.json');

class Routes {
  /**
   *
   * @param jobsController
   * @param healthCheckController
   */
  constructor(jobsController, healthCheckController) {
    this.jobsController = jobsController;
    this.healthCheckController = healthCheckController;
  }

  getRoutes() {
    let router = express.Router();

    router.get('/jobs', [
      check('from', 'from must be numeric value').isInt({ min: 0}),
      check('limit', 'limit must be numeric value').isInt({ min: 0})
    ], this.jobsController.getJobs);

    router.get('/jobs/:id', [
      check('id', 'id must be numeric value').isInt({ min: 0}),
    ], this.jobsController.getJob);

    router.get('/health-check', this.healthCheckController.getStatus);
    router.get('/version', function (req, res, next) {
      res.json({'version': version})
    });

    return router
  }

}

module.exports = Routes;
