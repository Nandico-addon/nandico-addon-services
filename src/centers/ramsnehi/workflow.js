'use strict';

const { RAMSNEHI_TEMPLATES: templates } = require('./whatsapp-templates');

// Ramsnehi's choices; shared template preparation and MsgClub transport consume
// these mappings without knowing this center's clinical template names.
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

module.exports = { eventTemplates };
