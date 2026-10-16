'use strict';

const { loadConfig } = require('./config/env');
const { createApplication } = require('./app');

async function main() {
  let config;
  try { config = loadConfig(); }
  catch (error) {
    require('./utils/logger').createLogger().error('config.invalid', { reason: error.message });
    throw error;
  }
  const app = createApplication(config);
  try { await app.start(); }
  catch (error) { await app.close(); throw error; }
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (closing) return;
      closing = true;
      await app.close(); process.exit(0);
    });
  }
}

main().catch((error) => {
  // Startup errors contain configuration names/codes, never credential values.
  const { createLogger } = require('./utils/logger');
  createLogger().error('server.start_failed', { errorCode: error.code || 'STARTUP_ERROR' });
  process.stderr.write('Backend startup failed. Check environment configuration, data permissions and port availability.\n');
  process.exitCode = 1;
});
