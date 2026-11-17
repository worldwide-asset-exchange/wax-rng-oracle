const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const Routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const logger = require('./config/logger');

class App {
  constructor(jobsController, healthCheckController) {
    this.routes = new Routes(jobsController, healthCheckController);
  }

  /**
   * @param {number} port
   * @param {(err: Error) => void} [onListenError]  what to do when the port
   *   cannot be bound; defaults to exiting 1 so systemd restarts the unit and
   *   the journal shows the cause.
   */
  startApp(port, onListenError = () => process.exit(1)) {
    // Routes definition
    let app = express();
    app.use(bodyParser.json());

    app.get('/ui/*', (req, res) => {
      res.sendFile(path.join(__dirname, '../public/index.html'));
    });
    app.use('/', this.routes.getRoutes());
    app.use('/public', express.static(path.join(__dirname, '../public')));

    // Setup error handler middleware
    app.use(notFoundHandler);
    app.use(errorHandler);

    let listenPort = port || 3000;
    const server = app.listen(listenPort, () => {
      logger.info(`Server is up on port ${listenPort}`);
    });
    // Without this handler a port already in use is an unhandled 'error' event
    // on the server: the process stays up, signs normally, and nothing says why
    // /health-check never answers. Say so and let the supervisor restart us.
    server.on('error', err => {
      logger.error(
        `HTTP API cannot listen on port ${listenPort} (${err.code ||
          err.message}); another process holds it, or EXPRESS_APP_PORT is wrong. Exiting.`
      );
      onListenError(err);
    });

    return app;
  }
}

module.exports = App;
