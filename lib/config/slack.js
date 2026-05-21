const logger = require('./logger');
let config = require('./configLoader').loadConfig();
const { IncomingWebhook } = require('@slack/webhook');

let slack
if(config.slackWebhook) {
  slack = new IncomingWebhook(config.get('slackWebhook'));
}

async function postMessage(message) {
  try {
    if(slack) { // no slack for local dev
      await slack.send({
        text: message
      });
    }
  } catch (e) {
    logger.error('Failure posting to slack', e);
  }
}

module.exports = {postMessage};
