'use strict';

const { ProviderError } = require('../utils/errors');

class NotificationService {
  constructor(providers) { this.providers = providers; }

  async send(job) {
    // All supported event types use the supplied recipients and shareLink.
    // Add event-specific behavior here when a client's provider needs it.
    switch (job.event.type) {
      case 'SIGNOFF':
      case 'VIEW_IMAGES_PATIENT':
      case 'VIEW_IMAGES_DOCTOR': {
        const result = await this.providers.get(job.group.provider).send(job);
        if (!result || result.status !== 'accepted' ||
            (result.providerMessageId !== undefined && result.providerMessageId !== null && typeof result.providerMessageId !== 'string')) {
          throw new ProviderError('PROVIDER_ACK_INVALID', { ambiguous: true });
        }
        return result;
      }
      default: throw new ProviderError('UNSUPPORTED_EVENT_TYPE');
    }
  }
}

module.exports = { NotificationService };
