'use strict';

const { ProviderError } = require('../../shared/utils/errors');

function fieldAt(object, path) {
  return String(path || '').split('.').reduce((value, key) =>
    value && typeof value === 'object' && Object.hasOwn(value, key) ? value[key] : undefined, object);
}

function himsOrderId(event) {
  // Put a debugger breakpoint here to inspect the PACS accession reference.
  const value = event.payload.originReferenceId;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\r\n\0]/.test(value)) {
    throw new ProviderError('HIMS_ORDER_ID_REQUIRED', { requiresReview: true });
  }
  return value;
}

function himsZipFilePath(event, group) {
  const value = fieldAt(event.payload, group.zipField);
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\r\n\0]/.test(value)) {
    throw new ProviderError('HIMS_ZIP_PATH_REQUIRED', { requiresReview: true });
  }
  return value;
}

function buildMarkUploadedPayload(orderId, zipFilePath) {
  // PascalCase follows KRJ's supplied mark-uploaded JSON contract.
  return { OrderId: orderId, ZipFilePath: zipFilePath };
}

function buildReportForm(orderId, pdfBytes) {
  // Multipart names follow HIMS_Integration_APIs.pdf. Send bytes, not the URL.
  const form = new FormData();
  form.set('orderId', orderId);
  form.set('multipartFile', new Blob([pdfBytes], { type: 'application/pdf' }), 'report.pdf');
  return form;
}

module.exports = { himsZipFilePath, himsOrderId, buildMarkUploadedPayload, buildReportForm };
