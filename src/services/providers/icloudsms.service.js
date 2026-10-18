'use strict';

const { ProviderError } = require('../../utils/errors');
const TEMPLATE_FIELDS = ['patientName', 'centerName', 'studyDate', 'reportDate', 'shareLink', 'reportLink', 'otpCode'];
const RECIPIENT_KINDS = ['PATIENT', 'REFERRING_DOCTOR', 'SHARED'];

function templateChoices(group, eventType) {
  const routes = group.templates?.[eventType];
  return (eventType === 'SIGNOFF' ? RECIPIENT_KINDS : ['withReport', 'withoutReport'])
    .map(key => routes?.[key]);
}

function validTemplate(template) {
  return Boolean(template && /^[a-z0-9_]{1,512}$/.test(template.name) &&
    /^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(template.language) &&
    Array.isArray(template.fields) && template.fields.length <= 10 &&
    template.fields.every(field => TEMPLATE_FIELDS.includes(field)) &&
    (template.documentField === undefined || template.documentField === 'reportPdfLink'));
}

function displayDate(value) {
  // PACS dates are IST wall-clock strings. Never shift them using the server timezone.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    throw new ProviderError('ICLOUDSMS_MISSING_TEMPLATE_DATE');
  }
  const date = new Date(value.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new ProviderError('ICLOUDSMS_INVALID_TEMPLATE_DATE');
  }
  return date.toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'long', year: 'numeric' });
}

class ICloudSmsProviderService {
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
    return Boolean(group.messageMode === 'template' && group.events?.includes(eventType) &&
      templateChoices(group, eventType).every(validTemplate) &&
      this.endpoint(group) && this.credential(group, 'authKey') &&
      /^\+?[1-9][0-9]{9,14}$/.test(this.credential(group, 'senderId')));
  }

  buildPayload(job) {
    const { event, group } = job;
    const payload = event.payload;
    const routes = group.templates[event.type];
    const template = event.type === 'SIGNOFF' ? routes[job.kind]
      : routes[payload.hasReport ? 'withReport' : 'withoutReport'];
    if (!validTemplate(template)) throw new ProviderError('ICLOUDSMS_TEMPLATE_NOT_CONFIGURED');
    if (!/^[6-9][0-9]{9}$/.test(job.mobile)) throw new ProviderError('ICLOUDSMS_INVALID_RECIPIENT');
    // Do not silently send an OTP-protected link without its code. None of the
    // current approved clinical templates has an OTP slot; use an approved one if needed.
    if (payload.otpCode && !template.fields.includes('otpCode')) {
      throw new ProviderError('ICLOUDSMS_OTP_TEMPLATE_REQUIRED');
    }
    const values = {
      patientName: payload.patientName || 'Patient',
      centerName: payload.centerName || group.clientName,
      shareLink: payload.shareLink,
      reportLink: payload.hasReport ? payload.reportPdfLink || payload.shareLink : undefined,
      otpCode: payload.otpCode,
    };
    const parameters = template.fields.map(field => {
      const value = field === 'studyDate' ? displayDate(payload.studyCreatedAt || event.createdAt)
        : field === 'reportDate' ? displayDate(event.createdAt || payload.studyCreatedAt) : values[field];
      if (typeof value !== 'string' || !value.trim()) throw new ProviderError('ICLOUDSMS_MISSING_TEMPLATE_VALUE');
      return { type: 'text', text: value };
    });
    const components = [];
    if (template.documentField) {
      if (!payload.hasReport || !payload.reportPdfLink) throw new ProviderError('ICLOUDSMS_MISSING_REPORT_PDF');
      const document = { link: payload.reportPdfLink };
      if (payload.reportFileName) document.filename = payload.reportFileName;
      components.push({ type: 'header', index: 0, parameters: [{ type: 'document', document }] });
    }
    if (parameters.length) components.push({ type: 'body', index: 0, parameters });
    const mobile = '91' + job.mobile;
    return {
      mobileNumbers: mobile,
      senderId: this.credential(group, 'senderId').replace(/^\+/, ''),
      component: {
        messaging_product: 'whatsapp', recipient_type: 'individual',
        to: mobile, type: 'template',
        template: { name: template.name, language: { code: template.language },
          ...(components.length ? { components } : {}) },
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

module.exports = { ICloudSmsProviderService };
