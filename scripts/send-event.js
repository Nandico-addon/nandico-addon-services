'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

function sign(raw, credentials, timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Basic ' + Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64'),
    'X-Timestamp': timestamp,
    'X-Signature': 'sha256=' + crypto.createHmac('sha256', credentials.secret).update(timestamp + '.').update(raw).digest('hex'),
  };
}

function send(url, raw, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (!['https:', 'http:'].includes(target.protocol)) return reject(new Error('Use HTTP or HTTPS'));
    if (target.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) return reject(new Error('Remote endpoints require HTTPS'));
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, { method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { ...headers, 'Content-Length': raw.length } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject); req.end(raw);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  for (const name of ['BASIC_PASSWORD', 'HMAC_SECRET']) if (!process.env[name]) throw new Error(`Missing ${name}`);
  const event = JSON.parse(fs.readFileSync(option('--file', path.join(__dirname, '../examples/signoff.json')), 'utf8'));
  event.id = Number(option('--id', Date.now()));
  event.groupId = Number(option('--group', event.groupId));
  if (![event.id, event.groupId].every((id) => Number.isSafeInteger(id) && id > 0)) throw new Error('Event and group IDs must be positive integers');
  const mobile = option('--to', '');
  if (mobile) {
    if (!/^[6-9][0-9]{9}$/.test(mobile)) throw new Error('--to must be a ten-digit Indian mobile number');
    event.payload.recipients = [{ mobile, kind: event.type === 'VIEW_IMAGES_DOCTOR' ? 'REFERRING_DOCTOR' : 'PATIENT' }];
  }
  const url = option('--url', 'http://127.0.0.1:3999/outbox');
  const target = new URL(url);
  const { loadConfig } = require('../src/config/env');
  const { getGroupConfig } = require('../src/config/groups');
  const localDemo = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) &&
    getGroupConfig(event.groupId, loadConfig())?.provider === 'demo';
  // Check the actual local routing code, not an assumption that ID 42 will
  // always remain a demo. Remote targets may have a different configuration.
  if (!localDemo && (!mobile || !args.includes('--allow-send'))) throw new Error('For a live or remote test, supply your test --to number and --allow-send');
  const scenario = option('--scenario', 'valid');
  if (!['valid', 'wrong-basic', 'wrong-hmac', 'tampered-body', 'expired', 'invalid-json'].includes(scenario)) throw new Error('Unknown scenario');
  let raw = Buffer.from(scenario === 'invalid-json' ? '{invalid' : JSON.stringify(event));
  const credentials = { user: process.env.BASIC_USER || 'nandico',
    password: process.env.BASIC_PASSWORD + (scenario === 'wrong-basic' ? '-wrong' : ''),
    secret: process.env.HMAC_SECRET + (scenario === 'wrong-hmac' ? '-wrong' : '') };
  const timestamp = String(Math.floor(Date.now() / 1000) - (scenario === 'expired' ? 600 : 0));
  const headers = sign(raw, credentials, timestamp);
  if (scenario === 'tampered-body') raw = Buffer.concat([raw, Buffer.from('\n')]);
  const result = await send(url, raw, headers);
  console.log(`HTTP ${result.status} ${result.body}`);
  const expected = scenario === 'valid' ? 200 : scenario === 'invalid-json' ? 400 : 401;
  if (result.status !== expected) process.exitCode = 1;
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { sign, send };
