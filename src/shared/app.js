'use strict';

const http = require('node:http');
const { OutboxRepository } = require('./repositories/outbox.repository');
const { GroupRouterService } = require('./services/group-router.service');
const { ProviderRegistry } = require('./integrations');
const { OutboxService } = require('./services/outbox.service');
const { NotificationService } = require('./services/notification.service');
const { WorkerService } = require('./services/worker.service');
const { OutboxController } = require('./controllers/outbox.controller');
const { createRouter } = require('./routes/router');
const { attachRequestContext } = require('./middleware/request.middleware');
const { HttpError } = require('./utils/errors');
const { createLogger } = require('./utils/logger');
const { sendJson } = require('./utils/http');

function createApplication(config, options = {}) {
  const logger = options.logger || createLogger({ directory: config.logDir, level: config.logLevel });
  const repository = new OutboxRepository(config.dataDir);
  const providers = new ProviderRegistry(config, options.providers);
  const groups = new GroupRouterService(config, options.groupLookup);
  const service = new OutboxService(repository, groups, providers, logger);
  const notifications = new NotificationService(providers);
  const worker = new WorkerService(repository, notifications, config, logger);
  const controller = new OutboxController(service, worker, config);
  const router = createRouter(controller, repository);
  const server = http.createServer(async (req, res) => {
    attachRequestContext(req, res, logger);
    try { await router(req, res); }
    catch (error) {
      const known = error instanceof HttpError;
      const status = known ? error.status : 500;
      logger[status >= 500 ? 'error' : 'warn']('http.request_failed', {
        ...req.context, httpStatus: status, errorCode: known ? error.code : 'INTERNAL_ERROR',
      });
      req.resume();
      if (!res.headersSent) sendJson(res, status, {
        error: known ? error.message : 'Internal server error',
        code: known ? error.code : 'INTERNAL_ERROR', requestId: req.context.requestId,
      }, {
        ...(status === 401 ? { 'WWW-Authenticate': 'Basic realm="outbox"' } : {}),
        ...(status === 405 ? { Allow: 'POST' } : {}),
        ...(status === 503 ? { 'Retry-After': '60' } : {}),
      });
      else res.end();
    }
  });
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(15_000, config.requestTimeoutMs);
  server.on('clientError', (error, socket) => {
    logger.warn('http.client_error', { errorCode: 'MALFORMED_HTTP' });
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  async function start(port = config.port, host = config.host) {
    await new Promise((resolve, reject) => {
      const failed = (error) => reject(error);
      server.once('error', failed);
      server.listen(port, host, () => { server.off('error', failed); resolve(); });
    });
    // Recover jobs only after successfully binding; a duplicate server startup
    // on the same port must not change an active process's in-flight jobs.
    worker.start();
    logger.info('server.started', { host, port: server.address().port });
    return server.address();
  }

  async function close() {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await worker.stop(); repository.close();
    logger.info('server.stopped');
  }

  return { server, repository, worker, start, close };
}

module.exports = { createApplication };
