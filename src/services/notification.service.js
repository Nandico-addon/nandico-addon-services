'use strict';

const { ProviderError } = require('../utils/errors');
const FIELDS = ['patientName', 'centerName', 'modality', 'shareLink', 'otpCode', 'reportPdfLink', 'reportFileName', 'reportStatusId', 'customerReportId'];

function getTemplateValues(event, fields) {
  if (!Array.isArray(fields) || fields.length > 10 || !fields.every((field) => FIELDS.includes(field))) throw new ProviderError('INVALID_TEMPLATE_FIELDS');
  return fields.map((field) => {
    let value = event.payload[field];
    if (!value && field === 'patientName') value = 'Patient';
    if (!value && field === 'otpCode') value = 'Not required';
    if (value === undefined || value === null || value === '') throw new ProviderError('MISSING_TEMPLATE_VALUE');
    return String(value);
  });
}

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
        if (!result || !['accepted', 'simulated'].includes(result.status) ||
            (result.providerMessageId !== undefined && result.providerMessageId !== null && typeof result.providerMessageId !== 'string')) {
          throw new ProviderError('PROVIDER_ACK_INVALID', { ambiguous: true });
        }
        return result;
      }
      default: throw new ProviderError('UNSUPPORTED_EVENT_TYPE');
    }
  }
}

module.exports = { NotificationService, getTemplateValues, FIELDS };
