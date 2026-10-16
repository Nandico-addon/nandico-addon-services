'use strict';

const { HttpError } = require('../utils/errors');
const { sendJson } = require('../utils/http');

function createRouter(controller, repository) {
  return async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    req.context.method = req.method;
    req.context.route = ['/outbox', '/health'].includes(pathname) ? pathname : 'unknown';
    if (pathname === '/health' && req.method === 'GET') {
      try { repository.ping(); }
      catch { throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'Database unavailable'); }
      return sendJson(res, 200, { status: 'ok', service: 'nandico-addon-backend' });
    }
    if (pathname !== '/outbox') throw new HttpError(404, 'NOT_FOUND', 'Not found');
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST /outbox with Basic Auth and HMAC');
    return controller.receive(req, res);
  };
}

module.exports = { createRouter };
