'use strict';

const { readRawBody } = require('../middleware/request.middleware');
const { verifyAuthentication } = require('../middleware/auth.middleware');
const { HttpError } = require('../utils/errors');
const { sendJson } = require('../utils/http');

class OutboxController {
  constructor(service, worker, config) { this.service = service; this.worker = worker; this.config = config; }

  async receive(req, res) {
    const rawBody = await readRawBody(req, this.config.maxBodyBytes);
    verifyAuthentication(req.headers, rawBody, this.config.auth);
    if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      throw new HttpError(415, 'UNSUPPORTED_CONTENT_TYPE', 'Use application/json');
    }
    const result = this.service.receive(rawBody, req.context);
    sendJson(res, 200, { ...result, requestId: req.context.requestId });
    // Provider calls never run in the HTTP request handler.
    setImmediate(() => this.worker.wake());
  }
}

module.exports = { OutboxController };
