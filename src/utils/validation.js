'use strict';

const { HttpError } = require('./errors');
const EVENT_TYPES = ['SIGNOFF', 'VIEW_IMAGES_PATIENT', 'VIEW_IMAGES_DOCTOR'];
const KINDS = ['PATIENT', 'REFERRING_DOCTOR', 'SHARED'];
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;

function parseJson(raw) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
  catch { throw new HttpError(400, 'INVALID_JSON', 'Body must be valid UTF-8 JSON'); }
}

function validateEnvelope(event) {
  const fail = () => { throw new HttpError(400, 'INVALID_EVENT', 'Invalid PACS envelope or payload'); };
  if (!event || typeof event !== 'object' || Array.isArray(event) || !positiveId(event.id) ||
      !positiveId(event.groupId) || !positiveId(event.reportStatusId) || !EVENT_TYPES.includes(event.type)) fail();
  const p = event.payload;
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.reportStatusId !== event.reportStatusId ||
      !positiveId(p.customerReportId) || typeof p.hasReport !== 'boolean') fail();
  if (event.type === 'SIGNOFF' && !p.hasReport) fail();
  for (const field of ['patientName', 'centerName', 'modality', 'studyCreatedAt', 'shareId', 'shareLink', 'otpCode', 'reportPdfLink', 'reportFileName']) {
    if (p[field] !== undefined && typeof p[field] !== 'string') fail();
  }
  const date = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  if (event.createdAt !== undefined && (typeof event.createdAt !== 'string' || !date.test(event.createdAt))) fail();
  if (p.studyCreatedAt !== undefined && !date.test(p.studyCreatedAt)) fail();
  if (!p.hasReport && p.reportPdfLink !== undefined) fail();
  for (const field of ['shareLink', 'reportPdfLink']) {
    if (p[field] !== undefined) {
      try { if (!['https:', 'http:'].includes(new URL(p[field]).protocol)) fail(); }
      catch { fail(); }
    }
  }
  // Optional fields may be omitted. A valid event with no recipients creates no jobs.
  if (p.recipients !== undefined) {
    if (!Array.isArray(p.recipients) || p.recipients.some((r) => !r || typeof r.mobile !== 'string' ||
        !/^[6-9][0-9]{9}$/.test(r.mobile) || !KINDS.includes(r.kind))) fail();
    if (event.type !== 'SIGNOFF' && (p.recipients.length !== 1 ||
        p.recipients[0].kind !== (event.type === 'VIEW_IMAGES_PATIENT' ? 'PATIENT' : 'REFERRING_DOCTOR'))) fail();
  }
  return event;
}

module.exports = { parseJson, validateEnvelope, EVENT_TYPES };
