let config = require('./configLoader').loadConfig();
const StatsD = require('hot-shots');

const metricConfig = { ...config.get('metrics') };

const metrics = new StatsD(metricConfig);

module.exports = metrics;
