'use strict';

const { DemoProviderService } = require('./demo.service');
const { AiSensyProviderService } = require('./aisensy.service');
const { HttpError } = require('../../utils/errors');

class ProviderRegistry {
  constructor(config, overrides = {}) {
    this.providers = new Map([
      ['demo', new DemoProviderService(config)],
      ['aisensy', new AiSensyProviderService(config)],
      ...Object.entries(overrides),
    ]);
    // Add new adapters here, e.g. ['pinnacle', new PinnacleProviderService(config)].
  }

  get(name) {
    const provider = this.providers.get(name);
    if (!provider) throw new HttpError(503, 'PROVIDER_NOT_IMPLEMENTED', 'The configured provider adapter is not implemented');
    return provider;
  }

  validate(group, eventType) {
    if (!this.get(group.provider).isConfigured(group, eventType)) throw new HttpError(503, 'PROVIDER_NOT_CONFIGURED', 'Provider credentials or event configuration are missing');
  }
}

module.exports = { ProviderRegistry };
