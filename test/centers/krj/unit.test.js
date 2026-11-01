'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { planJobs } = require('../../../src/shared/services/delivery-plan.service');
const { krjConfig, KrjHimsProvider } = require('../../../src/centers/krj');
const { getGroupConfig } = require('../../../src/centers');
const { loadConfig } = require('../../../src/shared/config/env');
const { OutboxRepository } = require('../../../src/shared/repositories/outbox.repository');
const { validateEnvelope } = require('../../../src/shared/utils/validation');
const { himsOrderId, himsZipFilePath } = require('../../../src/centers/krj/payload');

const group = krjConfig({});
function event(id, type = 'STUDY_UPLOADED') {
  return { id, groupId: group.groupId, type, reportStatusId: 987654, payload: {
    reportStatusId: 987654, customerReportId: type === 'SIGNOFF' ? 556677 : undefined, hasReport: type === 'SIGNOFF', originReferenceId: '0001134',
    shareLink: 'https://pacs.example.com/share/?link=synthetic-0001134',
    reportPdfLink: type === 'SIGNOFF' ? 'https://pacs.example.com/report.pdf' : undefined,
    reportStatusDetails: { lastUploadCompletedAt: '2026-10-27 10:00:00' },
  } };
}

test('KRJ defaults to active group 27919 and the agreed shareLink mapping', () => {
  assert.equal(krjConfig({}).groupId, 27919);
  assert.equal(krjConfig({}).enabled, true);
  assert.equal(krjConfig({ NODE_ENV: 'production' }).enabled, true);
  assert.equal(krjConfig({ NODE_ENV: 'production', HIMS_KRJ_GROUP_ID: '0' }).enabled, false);
  assert.equal(getGroupConfig(27919).provider, 'krj_hims');
  assert.equal(getGroupConfig(24564), null);
  assert.equal(getGroupConfig(48991).provider, 'icloudsms');
  assert.equal(getGroupConfig(0), null);
  assert.equal(getGroupConfig(900003), null);
  for (const id of ['48991', '-1', 'wrong', '9007199254740992']) {
    assert.throws(() => krjConfig({ HIMS_KRJ_GROUP_ID: id }));
  }
  assert.equal(krjConfig({ HIMS_KRJ_GROUP_ID: '900003' }).zipField, 'shareLink');
  assert.equal(krjConfig({ HIMS_KRJ_ZIP_FIELD: 'files.zipPath' }).zipField, 'files.zipPath');
  const config = loadConfig({ BASIC_PASSWORD: 'test-password', HMAC_SECRET: 'test-secret',
    HIMS_KRJ_GROUP_ID: '900003' });
  assert.equal(getGroupConfig(900003, config).provider, 'krj_hims');
  assert.equal(getGroupConfig(48991, config).provider, 'icloudsms');
  assert.throws(() => loadConfig({ NODE_ENV: 'production', BASIC_PASSWORD: 'test-password', HMAC_SECRET: 'test-secret',
    HIMS_KRJ_SIMULATION_URL: 'http://127.0.0.1:4900/krj_hims/hmserp/api/Patient' }), /Remove HIMS_KRJ_SIMULATION_URL/);
});

test('KRJ selects STUDY_UPLOADED and SIGNOFF and durably plans work with omitted optional fields', () => {
  assert.equal(planJobs(event(1), group)[0].action, 'mark_uploaded');
  assert.equal(planJobs(event(2, 'SIGNOFF'), group)[0].action, 'send_report');
  assert.deepEqual(planJobs(event(3, 'VIEW_IMAGES_PATIENT'), group), []);
  const missing = event(4); delete missing.payload.originReferenceId; delete missing.payload.shareLink;
  assert.equal(planJobs(missing, group)[0].action, 'mark_uploaded');
});

test('placeholder group 0 requires explicit local acceptance and supports patient-less upload events', () => {
  const upload = event(6); upload.groupId = 0;
  delete upload.payload.reportStatusDetails;
  assert.throws(() => validateEnvelope(upload));
  assert.equal(validateEnvelope(upload, { allowPlaceholderGroup: true }), upload);
  upload.groupId = -1;
  assert.throws(() => validateEnvelope(upload, { allowPlaceholderGroup: true }));
});

test('saved local group-0 jobs cannot dispatch after a production restart', async () => {
  const provider = new KrjHimsProvider({ production: true, providerEnv: {} });
  const placeholder = krjConfig({ HIMS_KRJ_GROUP_ID: '0' });
  assert.equal(provider.isConfigured(placeholder, 'STUDY_UPLOADED'), false);
  await assert.rejects(provider.send({ group: placeholder, event: { ...event(8), groupId: 0 }, action: 'mark_uploaded' }), {
    code: 'HIMS_PLACEHOLDER_GROUP', requiresReview: true,
  });
});

test('order references preserve leading zeros and shareLink is forwarded as the HIMS ZIP value', () => {
  const upload = event(7);
  assert.equal(himsOrderId(upload), '0001134');
  upload.payload.delivery = { archivePath: '/incoming/0001134.zip' };
  assert.equal(himsZipFilePath(upload, { zipField: 'delivery.archivePath' }), '/incoming/0001134.zip');
  assert.equal(himsZipFilePath(upload, group), upload.payload.shareLink);
  delete upload.payload.shareLink;
  upload.payload.reportPdfLink = 'https://pacs.example.com/report.pdf';
  assert.throws(() => himsZipFilePath(upload, group), { code: 'HIMS_ZIP_PATH_REQUIRED', requiresReview: true });
});

test('legacy KRJ configuration without centerId still selects the HIMS workflow', () => {
  const legacy = structuredClone(group);
  delete legacy.centerId;
  for (const type of ['STUDY_UPLOADED', 'SIGNOFF']) {
    assert.deepEqual(planJobs(event(5, type), legacy), planJobs(event(5, type), group));
  }
});

test('HIMS jobs commit without recipients, retain re-uploads and revised reports, and deduplicate only envelope IDs', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hims-repository-'));
  let repository = new OutboxRepository(directory);
  t.after(() => { repository.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const accept = value => repository.accept(value, group, Buffer.from(JSON.stringify(value)), 'test-request');
  accept(event(1)); accept(event(2)); accept(event(3, 'SIGNOFF')); accept(event(4, 'SIGNOFF'));
  assert.deepEqual(repository.listJobs().reverse().map(job => job.action), ['mark_uploaded', 'mark_uploaded', 'send_report', 'send_report']);
  assert.equal(repository.findEvent(2).disposition, 'queued');
  assert.equal(accept(event(1)).duplicate, true);
  repository.close(); repository = new OutboxRepository(directory);
  accept(event(5));
  assert.equal(repository.listJobs().length, 5);
  const claimed = repository.claimJob();
  assert.equal(claimed.action, 'mark_uploaded');
  assert.equal(claimed.event.payload.originReferenceId, '0001134');
  assert.equal(repository.recoverInterruptedJobs(), 1);
  assert.equal(repository.getJob(claimed.id).status, 'needs_review');
});

test('existing SQLite notification jobs migrate without changing their saved route', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hims-migration-'));
  const db = new DatabaseSync(path.join(directory, 'outbox.sqlite'));
  db.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT,event_id INTEGER NOT NULL,mobile TEXT NOT NULL,
    kind TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_ms INTEGER NOT NULL DEFAULT 0,provider_message_id TEXT,error_code TEXT,updated_at TEXT NOT NULL,
    UNIQUE(event_id,mobile));
    INSERT INTO jobs(event_id,mobile,kind,updated_at) VALUES (1,'9876500001','PATIENT','2026-10-27');`);
  db.close();
  const repository = new OutboxRepository(directory);
  t.after(() => { repository.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const job = repository.db.prepare('SELECT * FROM jobs').get();
  assert.equal(job.action, 'notify'); assert.equal(job.operation_key, null);
  assert.equal(job.mobile, '9876500001'); assert.equal(job.status, 'pending');
});

test('HIMS PDF download is restricted to explicit PACS hosts and rejects non-HTTPS URLs', () => {
  const provider = new KrjHimsProvider({ providerEnv: { HIMS_KRJ_REPORT_HOSTS: 'pacs.example.com' } });
  assert.equal(provider.reportUrl('https://pacs.example.com/report.pdf?token=synthetic').hostname, 'pacs.example.com');
  for (const url of ['http://pacs.example.com/report.pdf', 'https://other.example.com/report.pdf',
    'http://127.0.0.1/private', 'https://user:pass@pacs.example.com/report.pdf', 'https://pacs.example.com:444/report.pdf']) {
    assert.throws(() => provider.reportUrl(url));
  }
});
