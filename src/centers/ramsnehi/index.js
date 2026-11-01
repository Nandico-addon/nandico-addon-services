'use strict';

const configuration = require('./config');

function validateEnvironment(env) {
  if (env.NODE_ENV === 'production' && env.ICLOUDSMS_SIMULATION_URL) {
    throw new Error('Remove ICLOUDSMS_SIMULATION_URL before production startup');
  }
  return {};
}

module.exports = {
  id: 'ramsnehi',
  createConfig: () => structuredClone(configuration),
  validateEnvironment,
};
