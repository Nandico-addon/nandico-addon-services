'use strict';

class DemoProviderService {
  constructor(config) { this.config = config; }
  isConfigured() { return this.config.allowDemoGroup; }
  async send() {
    if (!this.config.allowDemoGroup) {
      const { ProviderError } = require('../../utils/errors');
      throw new ProviderError('DEMO_DISABLED');
    }
    return { status: 'simulated', providerMessageId: null };
  }
}

module.exports = { DemoProviderService };
