'use strict';

const { ProviderError } = require('../../utils/errors');
const { FIELDS } = require('../notification.service');

class AiSensyProviderService {
  constructor(config, fetchImpl = fetch) { this.config = config; this.fetch = fetchImpl; }

  isConfigured(group, eventType) {
    const template = group.templates?.[eventType];
    const keyRef = group.credentialRefs?.apiKey;
    return Boolean(keyRef && /^[A-Z][A-Z0-9_]*$/.test(keyRef) && this.config.providerEnv[keyRef] &&
      template?.name?.trim() && Array.isArray(template.fields) && template.fields.length <= 10 &&
      template.fields.every((field) => FIELDS.includes(field)));
  }

  async send(job) {
    if (!this.isConfigured(job.group, job.event.type)) throw new ProviderError('AISENSY_NOT_CONFIGURED');
    const { getTemplateValues } = require('../notification.service');
    const template = job.group.templates[job.event.type];
    const payload = {
      apiKey: this.config.providerEnv[job.group.credentialRefs.apiKey],
      campaignName: template.name,
      destination: '+91' + job.mobile,
      userName: job.event.payload.patientName || 'Patient',
      source: 'Nandico PACS',
      templateParams: getTemplateValues(job.event, template.fields),
    };
    let response;
    try {
      response = await this.fetch('https://backend.aisensy.com/campaign/t1/api/v2', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.providerTimeoutMs),
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
    } catch { throw new ProviderError('AISENSY_CONNECTION_UNKNOWN', { ambiguous: true }); }
    let body;
    try { body = await response.json(); } catch { body = {}; }
    if (!response.ok) throw new ProviderError(`AISENSY_HTTP_${response.status}`, {
      retryable: response.status === 429, ambiguous: response.status >= 500,
    });
    // Do not log provider response bodies: they can echo credentials/patient data.
    if (body?.success === false || body?.error || ['failed', 'failure', 'error'].includes(String(body?.status).toLowerCase())) throw new ProviderError('AISENSY_REJECTED');
    if (response.status !== 200) throw new ProviderError('AISENSY_ACK_UNKNOWN', { ambiguous: true });
    const id = body?.id || body?.messageId;
    return { status: 'accepted', providerMessageId: typeof id === 'string' ? id : null };
  }
}

module.exports = { AiSensyProviderService };
