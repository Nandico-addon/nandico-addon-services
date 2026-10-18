'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { createApplication } = require('../src/app');
const { loadConfig } = require('../src/config/env');
const { createLogger } = require('../src/utils/logger');
const { sign, send } = require('../scripts/send-event');

const simulationUrl = process.env.ICLOUDSMS_SIMULATION_URL;
const credentials = { user: 'nandico', password: 'simulation-basic-password', secret: 'simulation-hmac-secret' };
function event(id, type = 'SIGNOFF', hasReport = true) {
  const value = JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/signoff.json')));
  Object.assign(value, { id, groupId: 2396, type, createdAt: '2026-10-18 00:15:00' });
  Object.assign(value.payload, { hasReport, studyCreatedAt: '2026-10-17 23:30:00', centerName: 'Ramsnehi Hospital' });
  delete value.payload.otpCode;
  if (!hasReport) delete value.payload.reportPdfLink;
  if (type !== 'SIGNOFF') value.payload.recipients = [value.payload.recipients[type === 'VIEW_IMAGES_DOCTOR' ? 1 : 0]];
  return value;
}

async function createTestApp(t, key = 'simulation-key') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nandico-msgclub-simulation-'));
  const config = loadConfig({ BASIC_USER: credentials.user, BASIC_PASSWORD: credentials.password,
    HMAC_SECRET: credentials.secret, DATA_DIR: path.join(directory, 'data'), LOG_DIR: path.join(directory, 'logs'),
    GROUP_2396_ICLOUDSMS_URL: 'https://msg.icloudsms.com/rest/services/sendSMS/v2/sendtemplate',
    GROUP_2396_ICLOUDSMS_AUTH_KEY: key, GROUP_2396_ICLOUDSMS_SENDER_ID: '919828298283',
    ICLOUDSMS_SIMULATION_URL: simulationUrl });
  const app = createApplication({ ...config, workerIntervalMs: 50 }, {
    logger: createLogger({ directory: config.logDir, output: null }),
  });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const address = await app.start(0);
  const post = value => {
    const raw = Buffer.from(JSON.stringify(value));
    return send(`http://127.0.0.1:${address.port}/outbox`, raw, sign(raw, credentials));
  };
  const settled = async () => {
    for (let i = 0; i < 100; i++) {
      await app.worker.wake();
      if (app.repository.listJobs().every(job => !['pending', 'processing'].includes(job.status))) return;
      await delay(10);
    }
    assert.fail('Worker jobs did not settle');
  };
  return { app, config, post, settled };
}

const getCalls = async () => {
  const url = new URL(simulationUrl);
  url.pathname = '/icloudsms/__requests'; url.search = '';
  return (await fetch(url)).json();
};

test('signed PACS events run through group 2396, SQLite, worker and real HTTP to the MsgClub simulation', {
  skip: !simulationUrl && 'Run npm run test:msgclub to start the local provider simulation',
}, async t => {
  const { app, config, post, settled } = await createTestApp(t);
  const before = (await getCalls()).length;
  for (const value of [event(1), event(2, 'VIEW_IMAGES_PATIENT', false), event(3, 'VIEW_IMAGES_PATIENT'),
    event(4, 'VIEW_IMAGES_DOCTOR', false), event(5, 'VIEW_IMAGES_DOCTOR')]) {
    const response = await post(value);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).status, 'accepted');
    await settled();
  }
  const calls = (await getCalls()).slice(before);
  assert.deepEqual(calls.map(call => call.body.component.template.name), [
    'report_ready_message', 'clinician_signoff_message', 'report_ready_message',
    'new_patient_message', 'patient_scan_done_report_created_info',
    'new_clinician_message', 'clinician_signoff_message',
  ]);
  assert.equal(calls[0].body.mobileNumbers, '919876500001');
  assert.equal(calls[1].body.mobileNumbers, '919876500002');
  assert.equal(calls[2].body.mobileNumbers, '919876500003');
  assert.deepEqual(calls[1].body.component.template.components[0].parameters.map(p => p.text), [
    'Ramsnehi Hospital', 'DEMO PATIENT', '17 October 2026',
    'https://pacs.example.com/share/?link=demo', 'https://pacs.example.com/report/demo',
  ]);
  assert.equal(JSON.parse((await post(event(1))).body).status, 'duplicate');
  await settled();
  assert.equal((await getCalls()).length, before + 7);
  const jobs = app.repository.db.prepare('SELECT status,provider_message_id FROM jobs ORDER BY id').all();
  assert.equal(jobs.length, 7);
  assert.ok(jobs.every(job => job.status === 'accepted' && job.provider_message_id.startsWith('simulated-')));
  const groupSnapshot = app.repository.db.prepare('SELECT group_config FROM events LIMIT 1').get().group_config;
  const logs = fs.readdirSync(config.logDir).map(file => fs.readFileSync(path.join(config.logDir, file), 'utf8')).join('');
  for (const secret of ['simulation-key', credentials.password, credentials.secret]) {
    assert.ok(!groupSnapshot.includes(secret));
    assert.ok(!logs.includes(secret));
  }
  for (const value of ['DEMO PATIENT', '9876500001', 'pacs.example.com']) assert.ok(!logs.includes(value));
});

test('real provider HTTP errors preserve retry and review decisions without resending uncertain jobs', {
  skip: !simulationUrl && 'Run npm run test:msgclub to start the local provider simulation',
}, async t => {
  for (const [key, status, errorCode] of [
    ['simulation-rate-limit', 'retry_wait', 'ICLOUDSMS_HTTP_429'],
    ['simulation-server-error', 'needs_review', 'ICLOUDSMS_HTTP_500'],
    ['simulation-rejected', 'failed', 'ICLOUDSMS_REJECTED'],
    ['simulation-unknown', 'needs_review', 'ICLOUDSMS_ACK_UNKNOWN'],
  ]) {
    await t.test(key, async child => {
      const { app, post, settled } = await createTestApp(child, key);
      const before = (await getCalls()).length;
      const value = event(1); value.payload.recipients = [value.payload.recipients[0]];
      assert.equal((await post(value)).status, 200);
      await settled();
      const job = app.repository.listJobs()[0];
      assert.equal(job.status, status); assert.equal(job.error_code, errorCode);
      await app.worker.wake();
      assert.equal((await getCalls()).length, before + 1);
    });
  }
});

test('an OTP-protected event cannot silently send a template that omits the OTP', {
  skip: !simulationUrl && 'Run npm run test:msgclub to start the local provider simulation',
}, async t => {
  const { app, post, settled } = await createTestApp(t);
  const value = event(1); value.payload.recipients = [value.payload.recipients[0]];
  value.payload.otpCode = '123456';
  const before = (await getCalls()).length;
  assert.equal((await post(value)).status, 200);
  await settled();
  assert.equal(app.repository.listJobs()[0].error_code, 'ICLOUDSMS_OTP_TEMPLATE_REQUIRED');
  assert.equal((await getCalls()).length, before);
});
