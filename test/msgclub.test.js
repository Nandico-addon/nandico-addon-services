'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MsgClubProvider } = require('../src/integrations/whatsapp/msgclub/provider');
const { getGroupConfig } = require('../src/clients');
const { RAMSNEHI_TEMPLATES } = require('../src/clients/ramsnehi/whatsapp-templates');
const { loadConfig } = require('../src/config/env');

function setup() {
  const config = { production: false, providerTimeoutMs: 1000, providerEnv: {
    GROUP_48991_ICLOUDSMS_URL: 'https://msg.icloudsms.com/rest/services/sendSMS/v2/sendtemplate',
    GROUP_48991_ICLOUDSMS_AUTH_KEY: 'private-test-key',
    GROUP_48991_ICLOUDSMS_SENDER_ID: '919828298283',
  } };
  const group = getGroupConfig(48991, config);
  const event = { id: 1, groupId: 48991, type: 'SIGNOFF', createdAt: '2026-10-18 00:15:00', payload: {
    patientName: 'TEST PATIENT', centerName: 'Ramsnehi Hospital', studyCreatedAt: '2026-10-17 23:30:00',
    hasReport: true, shareLink: 'https://pacs.example.com/share/?link=test',
    reportPdfLink: 'https://pacs.example.com/report/test.pdf', reportFileName: 'TEST.pdf',
  } };
  return { config, group, job: { event, group, mobile: '9876500001', kind: 'PATIENT' } };
}

test('group 48991 selects all five approved clinical templates in the provider parameter order', () => {
  const { config, job } = setup();
  const provider = new MsgClubProvider(config);
  const expected = [
    ['SIGNOFF', 'PATIENT', true, 'report_ready_message', ['TEST PATIENT', 'Ramsnehi Hospital', '18 October 2026', job.event.payload.reportPdfLink]],
    ['SIGNOFF', 'REFERRING_DOCTOR', true, 'clinician_signoff_message', ['Ramsnehi Hospital', 'TEST PATIENT', '17 October 2026', job.event.payload.shareLink, job.event.payload.reportPdfLink]],
    ['SIGNOFF', 'SHARED', true, 'report_ready_message', ['TEST PATIENT', 'Ramsnehi Hospital', '18 October 2026', job.event.payload.reportPdfLink]],
    ['VIEW_IMAGES_PATIENT', 'PATIENT', false, 'new_patient_message', ['TEST PATIENT', 'Ramsnehi Hospital', '17 October 2026', job.event.payload.shareLink]],
    ['VIEW_IMAGES_PATIENT', 'PATIENT', true, 'patient_scan_done_report_created_info', ['TEST PATIENT', 'Ramsnehi Hospital', '17 October 2026', job.event.payload.shareLink, job.event.payload.reportPdfLink]],
    ['VIEW_IMAGES_DOCTOR', 'REFERRING_DOCTOR', false, 'new_clinician_message', ['TEST PATIENT', 'Ramsnehi Hospital', '17 October 2026', job.event.payload.shareLink]],
    ['VIEW_IMAGES_DOCTOR', 'REFERRING_DOCTOR', true, 'clinician_signoff_message', ['Ramsnehi Hospital', 'TEST PATIENT', '17 October 2026', job.event.payload.shareLink, job.event.payload.reportPdfLink]],
  ];
  for (const [type, kind, hasReport, name, texts] of expected) {
    const event = { ...job.event, type, payload: { ...job.event.payload, hasReport } };
    const result = provider.buildPayload({ ...job, event, kind });
    assert.deepEqual(result, {
      mobileNumbers: '919876500001', senderId: '919828298283', component: {
        messaging_product: 'whatsapp', recipient_type: 'individual', to: '919876500001', type: 'template',
        template: { name, language: { code: 'en' },
          components: [{ type: 'body', index: 0, parameters: texts.map(text => ({ type: 'text', text })) }] },
      },
    });
  }
});

test('all ten account templates match the body and document parameter counts from Ready JSON', () => {
  const { config, job } = setup();
  const provider = new MsgClubProvider(config);
  // Counts captured independently from the vendor's Ready JSON, including PDFs.
  const shapes = {
    report_ready_message: [4, false], clinician_signoff_message: [5, false],
    patient_scan_done_report_created_info: [5, false], new_clinician_message: [4, false],
    new_patient_message: [4, false], ramsnehi_chatbot: [0, false], chating: [0, false],
    pathology_report: [0, true], office: [0, true], testing_template: [1, true],
  };
  assert.equal(Object.keys(RAMSNEHI_TEMPLATES).length, Object.keys(shapes).length);
  for (const template of Object.values(RAMSNEHI_TEMPLATES)) {
    const group = structuredClone(job.group);
    group.templates.SIGNOFF.PATIENT = template;
    const result = provider.buildPayload({ ...job, group }).component.template;
    const [count, document] = shapes[template.name];
    assert.equal(result.language.code, 'en');
    assert.equal(result.components?.find(c => c.type === 'body')?.parameters.length || 0, count);
    const header = result.components?.find(c => c.type === 'header');
    assert.equal(Boolean(header), document);
    if (document) assert.deepEqual(header.parameters, [{ type: 'document', document: {
      link: job.event.payload.reportPdfLink, filename: 'TEST.pdf',
    } }]);
  }
});

test('template values use stable IST dates, the report viewer fallback and explicit missing-data failures', () => {
  const { config, job } = setup();
  const provider = new MsgClubProvider(config);
  delete job.event.payload.reportPdfLink;
  delete job.event.payload.patientName;
  delete job.event.payload.centerName;
  delete job.event.createdAt;
  let texts = provider.buildPayload(job).component.template.components[0].parameters.map(p => p.text);
  assert.deepEqual(texts, ['Patient', 'Ramsnehi Hospital', '17 October 2026', job.event.payload.shareLink]);
  delete job.event.payload.studyCreatedAt;
  assert.throws(() => provider.buildPayload(job), { code: 'ICLOUDSMS_MISSING_TEMPLATE_DATE' });
  job.event.createdAt = '2026-02-30 00:15:00';
  assert.throws(() => provider.buildPayload(job), { code: 'ICLOUDSMS_INVALID_TEMPLATE_DATE' });
  job.event.createdAt = '2026-10-18 00:15:00';
  delete job.event.payload.shareLink;
  assert.throws(() => provider.buildPayload(job), { code: 'ICLOUDSMS_MISSING_TEMPLATE_VALUE' });
  job.event.payload.shareLink = 'https://pacs.example.com/share/test';
  job.event.payload.otpCode = '123456';
  assert.throws(() => provider.buildPayload(job), { code: 'ICLOUDSMS_OTP_TEMPLATE_REQUIRED' });
  delete job.event.payload.otpCode;
  assert.throws(() => provider.buildPayload({ ...job, mobile: '91XXXXXXXXXX' }), { code: 'ICLOUDSMS_INVALID_RECIPIENT' });
  assert.throws(() => provider.buildPayload({ ...job, kind: 'UNKNOWN' }), { code: 'ICLOUDSMS_TEMPLATE_NOT_CONFIGURED' });
  const group = structuredClone(job.group);
  group.templates.SIGNOFF.PATIENT = RAMSNEHI_TEMPLATES.pathologyReport;
  assert.throws(() => provider.buildPayload({ ...job, group }), { code: 'ICLOUDSMS_MISSING_REPORT_PDF' });
});

test('provider configuration rejects incomplete routes, other hosts, embedded credentials and production simulation', () => {
  const { config, group } = setup();
  const provider = new MsgClubProvider(config);
  assert.equal(provider.isConfigured(group, 'SIGNOFF'), true);
  assert.equal(provider.isConfigured(group, 'UNKNOWN'), false);
  assert.equal(provider.isConfigured({ ...group, messageMode: 'text' }, 'SIGNOFF'), false);
  const incomplete = structuredClone(group);
  delete incomplete.templates.SIGNOFF.SHARED;
  assert.equal(provider.isConfigured(incomplete, 'SIGNOFF'), false);
  for (const sender of ['', 'RAMSNI']) {
    config.providerEnv.GROUP_48991_ICLOUDSMS_SENDER_ID = sender;
    assert.equal(provider.isConfigured(group, 'SIGNOFF'), false);
  }
  config.providerEnv.GROUP_48991_ICLOUDSMS_SENDER_ID = '919828298283';
  for (const url of [
    'http://msg.icloudsms.com/rest/services/sendSMS/v2/sendtemplate',
    'https://example.com/rest/services/sendSMS/v2/sendtemplate',
    'https://msg.icloudsms.com/rest/services/sendSMS/v2/sendtemplate?AUTH_KEY=unsafe',
    'https://msg.icloudsms.com/rest/services/sendSMS/v3/sendChat',
    'https://user:password@msg.icloudsms.com/rest/services/sendSMS/v2/sendtemplate',
  ]) {
    config.providerEnv.GROUP_48991_ICLOUDSMS_URL = url;
    assert.equal(provider.isConfigured(group, 'SIGNOFF'), false);
  }
  config.providerEnv.GROUP_48991_ICLOUDSMS_URL = 'https://msg.icloudsms.com/rest/services/sendSMS/v2/sendtemplate';
  config.providerEnv.ICLOUDSMS_SIMULATION_URL = 'http://127.0.0.1:4900/icloudsms/rest/services/sendSMS/v2/sendtemplate';
  assert.equal(provider.isConfigured(group, 'SIGNOFF'), true);
  config.production = true;
  assert.equal(provider.isConfigured(group, 'SIGNOFF'), false);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', ICLOUDSMS_SIMULATION_URL: 'http://127.0.0.1:4900' }), /SIMULATION/);
  config.production = false;
  config.providerEnv.ICLOUDSMS_SIMULATION_URL = 'http://example.com/icloudsms/rest/services/sendSMS/v2/sendtemplate';
  assert.equal(provider.isConfigured(group, 'SIGNOFF'), false);
});

test('adapter acknowledges acceptance without declaring delivery and classifies uncertain sends without leaking secrets', async () => {
  const { config, job } = setup();
  let captured;
  const provider = new MsgClubProvider(config, async (url, init) => {
    captured = { url: new URL(url), init };
    return { ok: true, status: 200, json: async () => ({ responseCode: '3001', response: 'provider-request-id' }) };
  });
  assert.deepEqual(await provider.send(job), { status: 'accepted', providerMessageId: 'provider-request-id' });
  assert.equal(captured.url.searchParams.get('AUTH_KEY'), 'private-test-key');
  assert.deepEqual(captured.init.headers, { 'Content-Type': 'application/json' });
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.body, JSON.stringify(provider.buildPayload(job)));
  assert.equal(captured.init.body.includes('private-test-key'), false);
  for (const [status, retryable, ambiguous] of [[429, true, false], [401, false, false], [500, false, true], [408, false, true]]) {
    provider.fetch = async () => ({ ok: false, status });
    await assert.rejects(provider.send(job), error => error.retryable === retryable && error.ambiguous === ambiguous);
  }
  provider.fetch = async () => { throw new Error('private-test-key'); };
  await assert.rejects(provider.send(job), error => error.ambiguous && !error.message.includes('private-test-key'));
  provider.fetch = async () => ({ ok: true, json: async () => ({ responseCode: 'SIMULATED_REJECTION', response: 'private-test-key' }) });
  await assert.rejects(provider.send(job), { code: 'ICLOUDSMS_REJECTED' });
  provider.fetch = async () => ({ ok: true, json: async () => ({ responseCode: '3001' }) });
  await assert.rejects(provider.send(job), error => error.code === 'ICLOUDSMS_ACK_UNKNOWN' && error.ambiguous);
  provider.fetch = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.test' }] }) });
  assert.equal((await provider.send(job)).providerMessageId, 'wamid.test');
});
