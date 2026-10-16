'use strict';

// THIS IS THE CLIENT ROUTING FILE. Add an explicit condition for each PACS
// group. All clients POST to the SAME /outbox endpoint and use PACS auth.
// Store provider secrets in .env; reference their variable names here.
const EVENTS = ['SIGNOFF', 'VIEW_IMAGES_PATIENT', 'VIEW_IMAGES_DOCTOR'];

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
      // Enable only after confirming template parameters and the API contract,
      // implementing its adapter, and registering it in providers/index.js.
      enabled: false,
      events: [...EVENTS],
      endpointRef: 'GROUP_2396_ICLOUDSMS_URL',
      credentialRefs: {
        authKey: 'GROUP_2396_ICLOUDSMS_AUTH_KEY',
        username: 'GROUP_2396_ICLOUDSMS_USERNAME',
        password: 'GROUP_2396_ICLOUDSMS_PASSWORD',
      },
      // Approved English WhatsApp names from Downloads/whatsapp.png.
      // Inventory only: event/recipient mappings and complete parameters still
      // need confirmation before the provider adapter can send messages.
      templateNames: {
        reportReady: 'report_ready_message',
        clinicianSignoff: 'clinician_signoff_message',
        patientScanDoneReportCreated: 'patient_scan_done_report_created_info',
        newClinician: 'new_clinician_message',
        newPatient: 'new_patient_message',
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

  // Example: replace 57 with the ACTUAL PACS group ID for this client.
  // Missing API key or campaign configuration returns 503, never a fake success.
  if (groupId === 57) {
    return {
      groupId: 57,
      clientName: 'Example AiSensy client - replace this name',
      provider: 'aisensy',
      enabled: true,
      events: [...EVENTS],
      credentialRefs: { apiKey: 'GROUP_57_AISENSY_API_KEY' },
      templates: campaignTemplates(config.providerEnv, 'GROUP_57', ['patientName', 'shareLink', 'otpCode']),
    };
  }

  // Add another condition here, for example:
  // if (groupId === 81) return { groupId: 81, provider: 'pinnacle', ... };
  // Implement and register that provider in services/providers/index.js first.
  return null; // Never fall back to another client's provider.
}

module.exports = { getGroupConfig };
