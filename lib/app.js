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

  startApp(port) {
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
    app.listen(listenPort, () => {
      logger.info(`Server is up on port ${listenPort}`);
    });

    return app;
  }
}

module.exports = App;
