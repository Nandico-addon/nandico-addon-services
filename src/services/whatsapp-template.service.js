'use strict';

const { ProviderError } = require('../utils/errors');

// Keep existing error codes stable for saved jobs and log consumers.
const TEMPLATE_FIELDS = ['patientName', 'centerName', 'studyDate', 'reportDate', 'shareLink', 'reportLink', 'otpCode'];
const { EVENT_TYPES, KINDS } = require('../utils/validation');
const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: '2-digit', month: 'long', year: 'numeric',
});

function templateChoices(group, eventType) {
  if (!EVENT_TYPES.includes(eventType)) return [];
  const routes = group.templates?.[eventType];
  return (eventType === 'SIGNOFF' ? KINDS : ['withReport', 'withoutReport'])
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
  return dateFormatter.format(date);
}

function buildTemplateMessage(job) {
  const { event, group } = job;
  const payload = event.payload;
  const routes = group.templates?.[event.type];
  const template = event.type === 'SIGNOFF' ? routes?.[job.kind]
    : routes?.[payload.hasReport ? 'withReport' : 'withoutReport'];
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
  return {
    to: '91' + job.mobile,
    template: { name: template.name, language: { code: template.language },
      ...(components.length ? { components } : {}) },
  };
}

module.exports = { templateChoices, validTemplate, buildTemplateMessage };
