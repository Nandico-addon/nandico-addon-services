'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../utils/errors');

function safeEqual(a, b) {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyAuthentication(headers, rawBody, credentials, now = Date.now()) {
  const expected = 'Basic ' + Buffer.from(`${credentials.user}:${credentials.password}`, 'utf8').toString('base64');
  const timestamp = headers['x-timestamp'] || '';
  const validBasic = safeEqual(headers.authorization || '', expected);
  if (!validBasic || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Authentication failed');
  }
  const signature = 'sha256=' + crypto.createHmac('sha256', credentials.secret)
    .update(timestamp + '.', 'utf8').update(rawBody).digest('hex');
  if (!safeEqual(headers['x-signature'] || '', signature)) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication failed');
}

module.exports = { verifyAuthentication };
