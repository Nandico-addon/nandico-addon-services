'use strict';

const path = require('node:path');

function integer(value, fallback, min, max, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid ${name}`);
  return number;
}

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  if (production && env.ICLOUDSMS_SIMULATION_URL) throw new Error('Remove ICLOUDSMS_SIMULATION_URL before production startup');
  for (const name of ['BASIC_PASSWORD', 'HMAC_SECRET']) if (!env[name]) throw new Error(`Missing ${name}; configure the supplied PACS credentials`);
  const user = env.BASIC_USER || 'nandico';
  if (user.includes(':') || /[\r\n]/.test(user + env.BASIC_PASSWORD)) throw new Error('Invalid Basic Auth credentials');
  if (production && (env.BASIC_PASSWORD === 'example-password' || env.HMAC_SECRET === 'example-secret')) throw new Error('Production requires real PACS credentials');
  if (!['debug', 'info', 'warn', 'error'].includes(env.LOG_LEVEL || 'info')) throw new Error('Invalid LOG_LEVEL');
  if (env.ALLOW_DEMO_GROUP !== undefined && !['true', 'false'].includes(env.ALLOW_DEMO_GROUP)) throw new Error('ALLOW_DEMO_GROUP must be true or false');
  const allowDemoGroup = env.ALLOW_DEMO_GROUP === undefined ? !production : env.ALLOW_DEMO_GROUP === 'true';
  if (production && allowDemoGroup) throw new Error('Disable ALLOW_DEMO_GROUP before production startup');
  return {
    production, host: env.HOST || '127.0.0.1',
    port: integer(env.PORT, 3999, 0, 65535, 'PORT'),
    auth: { user, password: env.BASIC_PASSWORD, secret: env.HMAC_SECRET },
    dataDir: path.resolve(env.DATA_DIR || './data/backend'),
    logDir: path.resolve(env.LOG_DIR || './logs'), logLevel: env.LOG_LEVEL || 'info',
    allowDemoGroup, providerEnv: { ...env },
    maxBodyBytes: 1024 * 1024, requestTimeoutMs: 30_000,
    providerTimeoutMs: 15_000, workerIntervalMs: 1000, maxDeliveryAttempts: 6,
  };
}

module.exports = { loadConfig };
