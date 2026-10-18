'use strict';

const { RAMSNEHI_TEMPLATES: templates } = require('./whatsapp-templates');

const eventTemplates = {
  SIGNOFF: {
    PATIENT: templates.reportReady,
    REFERRING_DOCTOR: templates.clinicianSignoff,
    SHARED: templates.reportReady,
  },
  VIEW_IMAGES_PATIENT: {
    withReport: templates.patientScanDoneReportCreated,
    withoutReport: templates.newPatient,
  },
  VIEW_IMAGES_DOCTOR: {
    withReport: templates.clinicianSignoff,
    withoutReport: templates.newClinician,
  },
};

// Client-specific choices only. API calls, queueing and retries are shared.
module.exports = {
  groupId: 48991,
  clientName: 'Ramsnehi Hospital',
  provider: 'icloudsms',
  enabled: true,
  messageMode: 'template',
  endpointRef: 'GROUP_48991_ICLOUDSMS_URL',
  credentialRefs: {
    authKey: 'GROUP_48991_ICLOUDSMS_AUTH_KEY',
    senderId: 'GROUP_48991_ICLOUDSMS_SENDER_ID',
  },
  // Derive enabled events from the mappings so the lists cannot drift apart.
  events: Object.keys(eventTemplates),
  templates: eventTemplates,
};
