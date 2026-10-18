'use strict';

const { MsgClubProvider } = require('./whatsapp/msgclub/provider');
const { HttpError } = require('../utils/errors');

class ProviderRegistry {
  constructor(config, overrides = {}) {
    this.providers = new Map([
      // Preserve the provider ID already stored in queued and historical jobs.
      ['icloudsms', new MsgClubProvider(config)],
      ...Object.entries(overrides),
    ]);
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
