'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../utils/errors');

function attachRequestContext(req, res, logger) {
  req.context = { requestId: crypto.randomUUID() };
  res.setHeader('X-Request-Id', req.context.requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const started = performance.now();
  res.on('finish', () => logger.info('http.request_completed', {
    ...req.context, httpStatus: res.statusCode, durationMs: Math.round(performance.now() - started),
  }));
  res.on('close', () => { if (!res.writableFinished) logger.warn('http.request_aborted', req.context); });
}

async function readRawBody(req, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= maxBytes) chunks.push(chunk);
  }
  if (size > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 1 MiB');
  return Buffer.concat(chunks);
}

module.exports = { attachRequestContext, readRawBody };
