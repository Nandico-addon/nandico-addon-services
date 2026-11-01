'use strict';

// Public entry point used by the shared client registry and provider registry.
const { krjConfig, validateEnvironment } = require('./config');
const { planJobs } = require('./workflow');
const { KrjHimsProvider } = require('./provider');

module.exports = {
  id: 'krj', createConfig: krjConfig, validateEnvironment, planJobs,
  providers: { krj_hims: KrjHimsProvider },
  krjConfig, KrjHimsProvider,
};
