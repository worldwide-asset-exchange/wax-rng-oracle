const winston = require('winston');
let config = require('./configLoader').loadConfig();

const upperCaseLogLevel = winston.format(log => {
  log.level = log.level.toUpperCase();
  return log;
});

const logger = winston.createLogger({
  level: config.get('logger.level'),
  format: winston.format.combine(
    upperCaseLogLevel(),
    winston.format.colorize(),
    winston.format.timestamp(),
    winston.format.printf(log => {
      return `${log.timestamp} (${process.pid}) [${log.level}] : ${JSON.stringify(log.message)}`;
    })
  ),
  transports: [
    new winston.transports.Console()
  ]
});

module.exports = logger;
