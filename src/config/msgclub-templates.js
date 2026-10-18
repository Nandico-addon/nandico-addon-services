'use strict';

// Matched against this account's approved templates and Ready JSON on 2026-10-18.
// Fields are in WhatsApp's numbered parameter order, not their order in the prose.
const MSGCLUB_2396_TEMPLATES = {
  reportReady: {
    name: 'report_ready_message', language: 'en',
    fields: ['patientName', 'centerName', 'reportDate', 'reportLink'],
  },
  clinicianSignoff: {
    name: 'clinician_signoff_message', language: 'en',
    fields: ['centerName', 'patientName', 'studyDate', 'shareLink', 'reportLink'],
  },
  patientScanDoneReportCreated: {
    name: 'patient_scan_done_report_created_info', language: 'en',
    fields: ['patientName', 'centerName', 'studyDate', 'shareLink', 'reportLink'],
  },
  newClinician: {
    name: 'new_clinician_message', language: 'en',
    fields: ['patientName', 'centerName', 'studyDate', 'shareLink'],
  },
  newPatient: {
    name: 'new_patient_message', language: 'en',
    fields: ['patientName', 'centerName', 'studyDate', 'shareLink'],
  },
  // These exist in the same account but do not correspond to a PACS event.
  // They can be selected explicitly in a client's routing configuration.
  chatbot: { name: 'ramsnehi_chatbot', language: 'en', fields: [] },
  feedback: { name: 'chating', language: 'en', fields: [] },
  pathologyReport: {
    name: 'pathology_report', language: 'en', fields: [], documentField: 'reportPdfLink',
  },
  office: {
    name: 'office', language: 'en', fields: [], documentField: 'reportPdfLink',
  },
  testing: {
    name: 'testing_template', language: 'en', fields: ['patientName'], documentField: 'reportPdfLink',
  },
};

module.exports = { MSGCLUB_2396_TEMPLATES };
