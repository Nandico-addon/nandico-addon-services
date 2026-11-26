'use strict';

// KRJ activation and client policy live beside its workflow and HTTP adapter.
// KRJ's production PACS group and the agreed mark-uploaded FTP mapping.
// Explicit group 0 remains available only for isolated legacy local tests.
function krjConfig(env) {
  const configuredId = String(env.HIMS_KRJ_GROUP_ID ?? '27919');
  const groupId = Number(configuredId);
  if (!/^(0|[1-9]\d*)$/.test(configuredId) || !Number.isSafeInteger(groupId) || groupId === 48991) {
    throw new Error('HIMS_KRJ_GROUP_ID must be 0 (placeholder) or a distinct positive PACS group ID');
  }
  const zipField = env.HIMS_KRJ_ZIP_FIELD || 'ftpPath';
  if (!zipField || !zipField.split('.').every(key => /^[A-Za-z][A-Za-z0-9_]*$/.test(key) && key !== 'constructor' && key !== 'prototype')) {
    throw new Error('HIMS_KRJ_ZIP_FIELD must name the confirmed ZIP path field relative to payload');
  }
  return {
    centerId: 'krj',
    groupId, clientName: 'KRJ Diagnostics', provider: 'krj_hims',
    enabled: groupId > 0 || env.NODE_ENV !== 'production',
    jobMode: 'hims', events: ['STUDY_UPLOADED', 'SIGNOFF'],
    zipField,
    allowPatientlessSignoff: true,
  };
}

function validateEnvironment(env) {
  if (env.NODE_ENV === 'production' && env.HIMS_KRJ_SIMULATION_URL) throw new Error('Remove HIMS_KRJ_SIMULATION_URL before production startup');
  if (env.HIMS_KRJ_ALLOW_INVALID_TLS && !['true', 'false'].includes(env.HIMS_KRJ_ALLOW_INVALID_TLS)) throw new Error('Invalid HIMS_KRJ_ALLOW_INVALID_TLS');
  const maximum = env.HIMS_KRJ_MAX_PDF_BYTES === undefined ? 20 * 1024 * 1024 : Number(env.HIMS_KRJ_MAX_PDF_BYTES);
  if (!Number.isInteger(maximum) || maximum < 1024 || maximum > 50 * 1024 * 1024) throw new Error('Invalid HIMS_KRJ_MAX_PDF_BYTES');
  return { himsMaxPdfBytes: maximum };
}

module.exports = { krjConfig, validateEnvironment };
