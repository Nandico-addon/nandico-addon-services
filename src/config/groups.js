'use strict';

// THIS IS THE CLIENT ROUTING FILE. Add an explicit condition for each PACS
// group. All clients POST to the SAME /outbox endpoint and use PACS auth.
// Store provider secrets in .env; reference their variable names here.
const EVENTS = ['SIGNOFF', 'VIEW_IMAGES_PATIENT', 'VIEW_IMAGES_DOCTOR'];
const { RAMSNEHI_TEMPLATES } = require('./msgclub-templates');

function getGroupConfig(groupId) {
  if (groupId === 48991) {
    return {
      groupId: 48991,
      clientName: 'Ramsnehi Hospital',
      provider: 'icloudsms',
      enabled: true,
      messageMode: 'template',
      events: [...EVENTS],
      endpointRef: 'GROUP_48991_ICLOUDSMS_URL',
      credentialRefs: {
        authKey: 'GROUP_48991_ICLOUDSMS_AUTH_KEY',
        senderId: 'GROUP_48991_ICLOUDSMS_SENDER_ID',
      },
      templates: {
        SIGNOFF: {
          PATIENT: RAMSNEHI_TEMPLATES.reportReady,
          REFERRING_DOCTOR: RAMSNEHI_TEMPLATES.clinicianSignoff,
          SHARED: RAMSNEHI_TEMPLATES.reportReady,
        },
        VIEW_IMAGES_PATIENT: {
          withReport: RAMSNEHI_TEMPLATES.patientScanDoneReportCreated,
          withoutReport: RAMSNEHI_TEMPLATES.newPatient,
        },
        VIEW_IMAGES_DOCTOR: {
          withReport: RAMSNEHI_TEMPLATES.clinicianSignoff,
          withoutReport: RAMSNEHI_TEMPLATES.newClinician,
        },
      },
    };
  }

  return null; // Never fall back to another client's provider.
}

module.exports = { getGroupConfig };
