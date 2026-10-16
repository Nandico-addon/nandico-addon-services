'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
// Logs deliberately exclude payloads, headers, phone numbers, links, OTPs,
// patient names and credentials. Add metadata only when it is safe to log.
const FIELDS = new Set(['requestId', 'eventId', 'groupId', 'eventType', 'provider', 'jobId', 'attempt',
  'status', 'httpStatus', 'durationMs', 'reason', 'errorCode', 'port', 'host', 'recipientCount', 'count', 'method', 'route']);

function createLogger({ directory, level = 'info', output = process.stdout } = {}) {
  if (directory) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  function log(severity, event, metadata = {}) {
    if (LEVELS[severity] < LEVELS[level]) return;
    const time = new Date().toISOString();
    const record = { time, level: severity, event };
    for (const [key, value] of Object.entries(metadata)) {
      if (FIELDS.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) record[key] = typeof value === 'string' ? value.slice(0, 200) : value;
    }
    const line = JSON.stringify(record) + '\n';
    try { output?.write(line); } catch { /* File logging may still be available. */ }
    if (directory) {
      try { fs.appendFileSync(path.join(directory, `app-${time.slice(0, 10)}.log`), line, { mode: 0o600 }); }
      catch { process.stderr.write(JSON.stringify({ time, level: 'error', event: 'logger.file_failed' }) + '\n'); }
    }
  }
  return Object.fromEntries(Object.keys(LEVELS).map((severity) => [severity, (event, metadata) => log(severity, event, metadata)]));
}

module.exports = { createLogger };
