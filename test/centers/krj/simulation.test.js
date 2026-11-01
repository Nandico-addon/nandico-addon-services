'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createApplication } = require('../../../src/shared/app');
const { loadConfig } = require('../../../src/shared/config/env');
const { createLogger } = require('../../../src/shared/utils/logger');
const { sign, send } = require('../../../scripts/send-event');

const simulation = process.env.HIMS_KRJ_SIMULATION_URL;
const credentials = { user: 'nandico', password: 'synthetic-password', secret: 'synthetic-secret' };

test('signed PACS pushes run through SQLite and the worker to real HIMS and file HTTP simulations', {
  skip: !simulation && 'Run npm run test:hims to start local HIMS and PACS-file simulations',
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'krj-hims-simulation-'));
  const config = loadConfig({ BASIC_USER: credentials.user, BASIC_PASSWORD: credentials.password, HMAC_SECRET: credentials.secret,
    DATA_DIR: path.join(directory, 'data'), LOG_DIR: path.join(directory, 'logs'),
    HIMS_KRJ_GROUP_ID: '27919',
    HIMS_KRJ_REPORT_HOSTS: 'pacs.example.com', HIMS_KRJ_SIMULATION_URL: simulation });
  const app = createApplication({ ...config, workerIntervalMs: 20 }, { logger: createLogger({ directory: config.logDir, output: null }) });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const address = await app.start(0);
  const origin = new URL(simulation).origin;
  const calls = async () => (await fetch(origin + '/krj_hims/__requests')).json();
  const makeEvent = (id, type = 'STUDY_UPLOADED', order = 'SYNTHETIC-0001134') => ({
    id, type, groupId: 27919, reportStatusId: 987654, createdAt: '2026-10-31 10:00:00', payload: {
      reportStatusId: 987654, originReferenceId: order,
      customerReportId: type === 'STUDY_UPLOADED' ? undefined : 556677,
      uploadCount: type === 'STUDY_UPLOADED' ? 1 : undefined,
      imageCount: type === 'STUDY_UPLOADED' ? 120 : undefined,
      seriesCount: type === 'STUDY_UPLOADED' ? 3 : undefined,
      firstUploadCompletedAt: type === 'STUDY_UPLOADED' ? '2026-10-31 09:59:00' : undefined,
      lastUploadCompletedAt: type === 'STUDY_UPLOADED' ? '2026-10-31 09:59:00' : undefined,
      hasReport: type === 'SIGNOFF',
      reportPdfLink: type === 'SIGNOFF' ? origin + '/pacs/report.pdf' : undefined,
      shareLink: 'https://pacs.example.com/share/?link=synthetic-study-token',
      reportStatusDetails: { lastUploadCompletedAt: '2026-10-27 09:59:00', shareLink: 'token-not-a-url' },
    },
  });
  const post = value => {
    const raw = Buffer.from(JSON.stringify(value));
    return send(`http://127.0.0.1:${address.port}/outbox`, raw, sign(raw, credentials));
  };
  const settled = async () => {
    for (let i = 0; i < 150; i++) {
      await app.worker.wake();
      if (app.repository.listJobs().every(job => !['pending', 'processing'].includes(job.status))) return;
      await delay(10);
    }
    assert.fail('HIMS worker did not settle');
  };

  await t.test('STUDY_UPLOADED without a patient sends one JSON action per envelope, including re-uploads', async () => {
    const before = (await calls()).length;
    const value = makeEvent(7001);
    assert.equal((await post(value)).status, 200); await settled();
    assert.equal((await post(value)).status, 200);
    // Rollback retry can carry the same uploadCount with a new envelope ID.
    assert.equal((await post(makeEvent(7002))).status, 200); await settled();
    const outgoing = (await calls()).slice(before);
    assert.equal(outgoing.length, 2);
    assert.ok(outgoing.every(call => call.path.endsWith('/mark-uploaded')));
    assert.deepEqual(outgoing[0].body, { OrderId: 'SYNTHETIC-0001134', ZipFilePath: value.payload.shareLink });
    assert.equal(app.repository.listJobs()[0].status, 'accepted');
  });
  await t.test('viewing-link notifications do not call HIMS even with nested upload timestamps', async () => {
    const before = (await calls()).length;
    assert.equal((await post(makeEvent(7003, 'VIEW_IMAGES_PATIENT'))).status, 200);
    assert.equal((await post(makeEvent(7004, 'VIEW_IMAGES_DOCTOR'))).status, 200);
    await settled(); assert.equal((await calls()).length, before);
    assert.equal(app.repository.findEvent(7003).disposition, 'filtered');
  });
  await t.test('upload supports multiple recipients, absent snapshots and uploadCount capped at 100', async () => {
    const before = (await calls()).length;
    const value = makeEvent(7005);
    value.payload.customerReportId = 556677;
    value.payload.recipients = [{ mobile: '9876500001', kind: 'PATIENT' }, { mobile: '9876500002', kind: 'REFERRING_DOCTOR' }];
    value.payload.uploadCount = 100;
    // A signed-off study can upload again; this must not trigger send-report.
    value.payload.hasReport = true; value.payload.reportPdfLink = origin + '/pacs/report.pdf';
    delete value.payload.reportStatusDetails;
    assert.equal((await post(value)).status, 200); await settled();
    assert.equal((await post({ ...value, id: 7006 })).status, 200); await settled();
    const outgoing = (await calls()).slice(before);
    assert.equal(outgoing.length, 2);
    assert.ok(outgoing.every(call => call.path.endsWith('/mark-uploaded')));
  });
  await t.test('report PDF bytes are uploaded once per event, irrespective of recipient count; re-sign-off sends again', async () => {
    const before = (await calls()).length;
    const value = makeEvent(7010, 'SIGNOFF');
    value.payload.recipients = [{ mobile: '9876500001', kind: 'PATIENT' }, { mobile: '9876500002', kind: 'REFERRING_DOCTOR' }];
    assert.equal((await post(value)).status, 200); await settled();
    assert.equal((await post(value)).status, 200);
    assert.equal((await post({ ...value, id: 7011 })).status, 200); await settled();
    const outgoing = (await calls()).slice(before);
    assert.equal(outgoing.length, 2);
    assert.ok(outgoing.every(call => call.path.endsWith('/send-report') && call.orderId === value.payload.originReferenceId &&
      call.fieldNames.join(',') === 'orderId,multipartFile' && call.fileType === 'application/pdf' && call.pdfHeader === '%PDF-'));
    assert.ok(app.repository.listJobs().filter(job => [7010, 7011].includes(job.event_id)).every(job => job.status === 'accepted'));
  });
  await t.test('omitted accession, ZIP path or report link is durably retained for review without calling HIMS', async () => {
    const before = (await calls()).length;
    for (const [id, type, field, code] of [
      [7020, 'STUDY_UPLOADED', 'originReferenceId', 'HIMS_ORDER_ID_REQUIRED'],
      [7021, 'STUDY_UPLOADED', 'shareLink', 'HIMS_ZIP_PATH_REQUIRED'],
      [7022, 'SIGNOFF', 'reportPdfLink', 'HIMS_REPORT_REQUIRED'],
    ]) {
      const value = makeEvent(id, type); delete value.payload[field];
      assert.equal((await post(value)).status, 200); await settled();
      assert.ok(app.repository.findEvent(id));
      const job = app.repository.listJobs().find(job => job.event_id === id);
      assert.equal(job.status, 'needs_review'); assert.equal(job.error_code, code);
    }
    assert.equal((await calls()).length, before);
  });
  await t.test('malformed upload counters and recipient data are rejected before acknowledgement', async () => {
    for (const [index, field, invalid] of [[0, 'uploadCount', 101], [1, 'imageCount', -1], [2, 'seriesCount', '3']]) {
      const value = makeEvent(7023 + index); value.payload[field] = invalid;
      assert.equal((await post(value)).status, 400); assert.equal(app.repository.findEvent(value.id), undefined);
    }
  });
  await t.test('rate limits retry, ambiguous server/login responses require review, permanent errors fail', async () => {
    for (const [index, order, status] of [[0, 'SIM-429', 'retry_wait'], [1, 'SIM-500', 'needs_review'], [2, 'SIM-400', 'failed'], [3, 'SIM-HTML', 'needs_review']]) {
      const id = 7030 + index;
      assert.equal((await post(makeEvent(id, 'STUDY_UPLOADED', order))).status, 200); await settled();
      assert.equal(app.repository.listJobs().find(job => job.event_id === id).status, status);
    }
  });
  await t.test('PDF errors and untrusted URLs never call the HIMS report endpoint', async () => {
    const before = (await calls()).length;
    for (const [index, suffix, status] of [[0, 'not-ready.pdf', 'retry_wait'], [1, 'not-pdf', 'failed'], [2, 'too-large.pdf', 'failed'], [3, 'redirect.pdf', 'retry_wait']]) {
      const value = makeEvent(7040 + index, 'SIGNOFF'); value.payload.reportPdfLink = origin + '/pacs/' + suffix;
      assert.equal((await post(value)).status, 200); await settled();
      assert.equal(app.repository.listJobs().find(job => job.event_id === value.id).status, status);
    }
    const value = makeEvent(7045, 'SIGNOFF'); value.payload.reportPdfLink = 'http://127.0.0.1:1/private';
    assert.equal((await post(value)).status, 200); await settled();
    assert.equal(app.repository.listJobs().find(job => job.event_id === value.id).error_code, 'HIMS_REPORT_HOST_NOT_ALLOWED');
    assert.equal((await calls()).length, before);
  });
  await t.test('the signed-event CLI tests group 27919 with a manual order ID and no notification recipient', async () => {
    const before = (await calls()).length;
    const value = makeEvent(7050);
    const filename = path.join(directory, 'cli-upload.json');
    fs.writeFileSync(filename, JSON.stringify(value));
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/send-event.js', '--file', filename,
      '--url', `http://127.0.0.1:${address.port}/outbox`, '--id', '7050', '--group', '27919',
      '--hims', '--order-id', 'SYNTHETIC-CLI-0001134', '--allow-send'], {
      cwd: path.join(__dirname, '../../..'), env: { ...process.env, NODE_ENV: 'test', HIMS_KRJ_GROUP_ID: '27919',
        BASIC_USER: credentials.user, BASIC_PASSWORD: credentials.password, HMAC_SECRET: credentials.secret },
    });
    assert.match(stdout, /HTTP 200/); await settled();
    const outgoing = (await calls()).slice(before);
    assert.equal(outgoing.length, 1);
    assert.equal(outgoing[0].body.OrderId, 'SYNTHETIC-CLI-0001134');
    assert.equal(app.repository.listJobs().find(job => job.event_id === 7050).status, 'accepted');
    await assert.rejects(promisify(execFile)(process.execPath, ['scripts/send-event.js', '--file', filename,
      '--url', `http://127.0.0.1:${address.port}/outbox`, '--group', '48991', '--hims', '--allow-send'], {
      cwd: path.join(__dirname, '../../..'), env: { ...process.env, NODE_ENV: 'test', HIMS_KRJ_GROUP_ID: '27919',
        BASIC_PASSWORD: credentials.password, HMAC_SECRET: credentials.secret },
    }), error => /configured KRJ group/.test(error.stderr));
    assert.equal((await calls()).length, before + 1);
  });
  await t.test('the Postman outbox collection signs both events and delivers JSON plus multipart through the worker', async () => {
    const before = (await calls()).length;
    await promisify(execFile)('postman', ['collection', 'run', 'examples/centers/krj/outbox.postman_collection.json',
      '--env-var', `baseUrl=http://127.0.0.1:${address.port}`,
      '--env-var', `basicPassword=${credentials.password}`, '--env-var', `hmacSecret=${credentials.secret}`,
      '--env-var', 'allowHimsSend=true', '--env-var', 'orderId=SYNTHETIC-POSTMAN-0001134',
      '--env-var', 'shareLink=https://pacs.example.com/share/?link=postman-test', '--env-var', `reportPdfLink=${origin}/pacs/report.pdf`,
      '--timeout-request', '10000', '--ignore-redirects', '--no-report-events'], {
      cwd: path.join(__dirname, '../../..'), timeout: 30000,
    });
    await settled();
    const outgoing = (await calls()).slice(before);
    assert.equal(outgoing.length, 2);
    assert.ok(outgoing.every(call => call.orderId === 'SYNTHETIC-POSTMAN-0001134'));
    assert.ok(outgoing.some(call => call.path.endsWith('/mark-uploaded')));
    assert.ok(outgoing.some(call => call.path.endsWith('/send-report') && call.pdfHeader === '%PDF-'));
  });
  await t.test('HIMS logs exclude order references, links, recipients and credentials', () => {
    const logs = fs.readdirSync(config.logDir).map(file => fs.readFileSync(path.join(config.logDir, file), 'utf8')).join('');
    for (const secret of ['SYNTHETIC-0001134', 'synthetic-study-token', '9876500001', credentials.password, credentials.secret, 'token-not-a-url']) {
      assert.ok(!logs.includes(secret));
    }
    assert.ok(logs.includes('mark_uploaded')); assert.ok(logs.includes('send_report'));
  });
});
