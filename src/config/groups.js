'use strict';

// THIS IS THE CLIENT ROUTING FILE. Add an explicit condition for each PACS
// group. All clients POST to the SAME /outbox endpoint and use PACS auth.
// Store provider secrets in .env; reference their variable names here.
const EVENTS = ['SIGNOFF', 'VIEW_IMAGES_PATIENT', 'VIEW_IMAGES_DOCTOR'];
const { MSGCLUB_2396_TEMPLATES } = require('./msgclub-templates');

// Change this client's parameter order once for all its event templates.
function campaignTemplates(env, prefix, fields) {
  return Object.fromEntries([
    ['SIGNOFF', 'SIGNOFF'],
    ['VIEW_IMAGES_PATIENT', 'PATIENT'],
    ['VIEW_IMAGES_DOCTOR', 'DOCTOR'],
  ].map(([event, suffix]) => [event, {
    name: env[`${prefix}_${suffix}_CAMPAIGN`] || '',
    fields: [...fields],
  }]));
}

function getGroupConfig(groupId, config) {
  if (groupId === 2396) {
    return {
      groupId: 2396,
      clientName: 'Ramsnehi Hospital',
      provider: 'icloudsms',
      enabled: true,
      messageMode: 'template',
      events: [...EVENTS],
      endpointRef: 'GROUP_2396_ICLOUDSMS_URL',
      credentialRefs: {
        authKey: 'GROUP_2396_ICLOUDSMS_AUTH_KEY',
        senderId: 'GROUP_2396_ICLOUDSMS_SENDER_ID',
      },
      templates: {
        SIGNOFF: {
          PATIENT: MSGCLUB_2396_TEMPLATES.reportReady,
          REFERRING_DOCTOR: MSGCLUB_2396_TEMPLATES.clinicianSignoff,
          SHARED: MSGCLUB_2396_TEMPLATES.reportReady,
        },
        VIEW_IMAGES_PATIENT: {
          withReport: MSGCLUB_2396_TEMPLATES.patientScanDoneReportCreated,
          withoutReport: MSGCLUB_2396_TEMPLATES.newPatient,
        },
        VIEW_IMAGES_DOCTOR: {
          withReport: MSGCLUB_2396_TEMPLATES.clinicianSignoff,
          withoutReport: MSGCLUB_2396_TEMPLATES.newClinician,
        },
      },
    };
  }

  if (groupId === 42 && config.allowDemoGroup) {
    return {
      groupId: 42,
      clientName: 'LOCAL DEMO ONLY',
      provider: 'demo',
      enabled: true,
      events: [...EVENTS],
      credentialRefs: {},
    };
  }

  // Add another condition here, for example:
  // if (groupId === 81) return { groupId: 81, provider: 'pinnacle', ... };
  // Implement and register that provider in services/providers/index.js first.
  return null; // Never fall back to another client's provider.
}

module.exports = { getGroupConfig };
