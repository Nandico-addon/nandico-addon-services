'use strict';

const { ProviderError } = require('../../../utils/errors');
const { templateChoices, validTemplate, buildTemplateMessage } = require('../../../services/whatsapp-template.service');

class MsgClubProvider {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; }

  credential(group, name) {
    const reference = group.credentialRefs?.[name];
    return typeof reference === 'string' && /^[A-Z][A-Z0-9_]*$/.test(reference)
      ? this.config.providerEnv[reference] || '' : '';
  }

  endpoint(group) {
    try {
      const url = new URL(this.config.providerEnv[group.endpointRef]);
      if (url.protocol !== 'https:' || !['msg.icloudsms.com', 'msg.msgclub.net'].includes(url.hostname) ||
          url.port || url.username || url.password || url.search || url.hash ||
          url.pathname !== '/rest/services/sendSMS/v2/sendtemplate') return null;
      const simulationUrl = this.config.providerEnv.ICLOUDSMS_SIMULATION_URL;
      if (simulationUrl) {
        const simulation = new URL(simulationUrl);
        if (this.config.production || simulation.protocol !== 'http:' || simulation.hostname !== '127.0.0.1' ||
            simulation.username || simulation.password || simulation.search || simulation.hash ||
            simulation.pathname !== '/icloudsms/rest/services/sendSMS/v2/sendtemplate') return null;
        return simulation;
      }
      return url;
    } catch { return null; }
  }

  isConfigured(group, eventType) {
    const choices = templateChoices(group, eventType);
    return Boolean(group.messageMode === 'template' && group.events?.includes(eventType) &&
      choices.length && choices.every(validTemplate) &&
      this.endpoint(group) && this.credential(group, 'authKey') &&
      /^\+?[1-9][0-9]{9,14}$/.test(this.credential(group, 'senderId')));
  }

  buildPayload(job) {
    const { to, template } = buildTemplateMessage(job);
    return {
      mobileNumbers: to,
      senderId: this.credential(job.group, 'senderId').replace(/^\+/, ''),
      component: {
        messaging_product: 'whatsapp', recipient_type: 'individual',
        to, type: 'template', template,
      },
    };
  }

  async send(job) {
    if (!this.isConfigured(job.group, job.event.type)) throw new ProviderError('ICLOUDSMS_NOT_CONFIGURED');
    const body = this.buildPayload(job);
    const url = this.endpoint(job.group);
    url.searchParams.set('AUTH_KEY', this.credential(job.group, 'authKey'));
    let response;
    try {
      response = await this.fetch(url.toString(), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.providerTimeoutMs),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch { throw new ProviderError('ICLOUDSMS_CONNECTION_UNKNOWN', { ambiguous: true }); }
    if (!response.ok) throw new ProviderError(`ICLOUDSMS_HTTP_${response.status}`, {
      retryable: response.status === 429, ambiguous: response.status === 408 || response.status >= 500,
    });
    let acknowledgement;
    try { acknowledgement = await response.json(); }
    catch { throw new ProviderError('ICLOUDSMS_ACK_UNKNOWN', { ambiguous: true }); }
    if (acknowledgement?.error || acknowledgement?.success === false) throw new ProviderError('ICLOUDSMS_REJECTED');
    // 3001 is provider acceptance, not a WhatsApp delivery receipt.
    let id;
    if (acknowledgement?.responseCode !== undefined) {
      if (String(acknowledgement.responseCode) !== '3001') throw new ProviderError('ICLOUDSMS_REJECTED');
      id = acknowledgement.response;
    } else if (Array.isArray(acknowledgement?.messages)) {
      id = acknowledgement.messages[0]?.id;
    }
    if (typeof id !== 'string' || !id.trim()) throw new ProviderError('ICLOUDSMS_ACK_UNKNOWN', { ambiguous: true });
    return { status: 'accepted', providerMessageId: id };
  }
}

module.exports = { MsgClubProvider };
