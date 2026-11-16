const winston = require('winston');
let config = require('./configLoader').loadConfig();

const upperCaseLogLevel = winston.format(log => {
  log.level = log.level.toUpperCase();
  return log;
});

// ANSI colours only when a human is watching: under systemd / a file sink the
// escape codes end up in the journal and the log file. LOGGER_COLOR=true/false
// overrides the TTY detection.
function useColor() {
  const forced = process.env.LOGGER_COLOR;
  if (forced !== undefined && forced !== '') {
    return !['false', '0', 'no', 'off'].includes(forced.toLowerCase());
  }
  return Boolean(process.stdout && process.stdout.isTTY);
}

const logger = winston.createLogger({
  level: config.get('logger.level'),
  format: winston.format.combine(
    upperCaseLogLevel(),
    ...(useColor() ? [winston.format.colorize()] : []),
    winston.format.timestamp(),
    winston.format.printf(log => {
      return `${log.timestamp} (${process.pid}) [${
        log.level
      }] : ${JSON.stringify(log.message)}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

module.exports = logger;
