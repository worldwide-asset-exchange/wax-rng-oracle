const logger = require("../config/logger");

/// catch 404 and forward to error handler
const notFoundHandler = function(req, res, next) {
  logger.debug(`Page not found, Path:${req.originalUrl}, Method: ${req.method}`);
  let err = new Error("Not Found");
  err.name = "NotFoundError";
  err.status = 404;
  next(err);
};

const errorParser = function(req, err) {
  logger.debug(`Error handling request ${err.name}, URL:${req.originalUrl}, Method: ${req.method}`);
  logger.debug(`Error: ${err.message}`);
  switch (err.name) {
    case "InvalidParameterError":
      err.status = 400;
      break;
    default:
      logger.error(`${err.name} : ${err.message} : ${err.stack}`);
  }
};

/// error handlers
const errorHandler = function(err, req, res, next) {
  if (err.status !== 404) {
    errorParser(req, err);
  }
  res.status(err.status || 500);
  res.json({
    "errors": {
      message: err.message,
      error: err
    }
  });
};

module.exports = { notFoundHandler, errorHandler };
