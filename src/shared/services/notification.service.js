'use strict';

const { ProviderError } = require('../utils/errors');
const { EVENT_TYPES } = require('../utils/validation');

class NotificationService {
  constructor(providers) { this.providers = providers; }

  async send(job) {
    if (!EVENT_TYPES.includes(job.event.type)) throw new ProviderError('UNSUPPORTED_EVENT_TYPE');
    const result = await this.providers.get(job.group.provider).send(job);
    if (!result || result.status !== 'accepted' ||
        (result.providerMessageId !== undefined && result.providerMessageId !== null && typeof result.providerMessageId !== 'string')) {
      throw new ProviderError('PROVIDER_ACK_INVALID', { ambiguous: true });
    }
    return result;
  }
}

module.exports = { NotificationService };
