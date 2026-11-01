'use strict';

const { eventTemplates } = require('./workflow');

// Client-specific choices only. API calls, queueing and retries are shared.
module.exports = {
  centerId: 'ramsnehi',
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
