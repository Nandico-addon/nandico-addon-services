'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createApplication } = require('../src/app');
const { loadConfig } = require('../src/config/env');
const { createLogger } = require('../src/utils/logger');
const { OutboxRepository } = require('../src/repositories/outbox.repository');
const { ProviderError } = require('../src/utils/errors');
const { AiSensyProviderService } = require('../src/services/providers/aisensy.service');
const { NotificationService } = require('../src/services/notification.service');
const { sign, send } = require('../scripts/send-event');

const credentials = { user: 'nandico', password: 'test-basic-password', secret: 'test-hmac-secret' };
const event = (id, groupId = 42, type = 'SIGNOFF') => {
  const value = { ...JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/signoff.json'))), id, groupId, type };
  if (type !== 'SIGNOFF') {
    value.payload.hasReport = false; delete value.payload.reportPdfLink;
    value.payload.recipients = [value.payload.recipients[type === 'VIEW_IMAGES_DOCTOR' ? 1 : 0]];
  }
  return value;
};
const encode = (value) => Buffer.from(JSON.stringify(value));
const baseConfig = (directory) => ({ ...loadConfig({ BASIC_USER: credentials.user,
  BASIC_PASSWORD: credentials.password, HMAC_SECRET: credentials.secret }),
  dataDir: path.join(directory, 'data'), logDir: path.join(directory, 'logs'), workerIntervalMs: 100 });

test('backend contract, authentication, group routing, deduplication and logs', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nandico-backend-test-'));
  const config = baseConfig(directory);
  const logger = createLogger({ directory: config.logDir, output: null });
  const calls = [];
  const options = { logger, providers: {
    client57: { isConfigured: () => true, send: async (job) => { calls.push(job); return { status: 'accepted', providerMessageId: 'test-message-id' }; } },
  }, groupLookup: (id, settings) => id === 57 ? { groupId: 57, provider: 'client57', enabled: true,
    events: ['SIGNOFF'], credentialRefs: { apiKey: 'GROUP_57_TEST_KEY' } } : require('../src/config/groups').getGroupConfig(id, settings) };
  let app = createApplication(config, options);
  let base;
  const start = async () => { const address = await app.start(0); base = `http://127.0.0.1:${address.port}`; };
  const post = (body, overrides = {}, headers = {}) => send(base + '/outbox', body, { ...sign(body, { ...credentials, ...overrides }), ...headers });
  await start();
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  await t.test('API-only routes: health 200, root 404, outbox GET 405', async () => {
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base)).status, 404);
    const response = await fetch(base + '/outbox');
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'POST');
    assert.equal((await fetch(base + '/api/integrations')).status, 404);
  });
  await t.test('known HMAC vector matches the document', () => {
    assert.equal(crypto.createHmac('sha256', 'key').update('The quick brown fox jumps over the lazy dog').digest('hex'),
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });
  await t.test('both authentication schemes, fresh timestamps and exact body bytes are required', async () => {
    const raw = encode(event(100));
    assert.equal((await post(raw, { password: 'wrong' })).status, 401);
    assert.equal((await post(raw, { secret: 'wrong' })).status, 401);
    for (const field of ['Authorization', 'X-Timestamp', 'X-Signature']) {
      const headers = sign(raw, credentials); delete headers[field];
      assert.equal((await send(base + '/outbox', raw, headers)).status, 401);
    }
    for (const timestamp of [String(Math.floor(Date.now() / 1000) - 600), String(Math.floor(Date.now() / 1000) + 600), 'NaN', 'Infinity', '']) {
      assert.equal((await send(base + '/outbox', raw, sign(raw, credentials, timestamp))).status, 401);
    }
    assert.equal((await send(base + '/outbox', Buffer.concat([raw, Buffer.from('\n')]), sign(raw, credentials))).status, 401);
    assert.equal(app.repository.findEvent(100), undefined);
    assert.equal((await post(raw)).status, 200);
  });
  await t.test('all event types are acknowledged and simulated per recipient', async () => {
    for (const [index, type] of ['SIGNOFF', 'VIEW_IMAGES_PATIENT', 'VIEW_IMAGES_DOCTOR'].entries()) {
      const result = await post(encode(event(110 + index, 42, type)));
      assert.equal(result.status, 200); assert.equal(JSON.parse(result.body).status, 'accepted');
    }
    await app.worker.wake();
    assert.ok(app.repository.listJobs().every((job) => job.status === 'simulated'));
  });
  await t.test('unknown groups return 503 and unselected events are filtered', async () => {
    const unknown = await post(encode(event(120, 999)));
    assert.equal(unknown.status, 503); assert.equal(JSON.parse(unknown.body).code, 'GROUP_NOT_CONFIGURED');
    assert.equal(app.repository.findEvent(120), undefined);
    const pending = await post(encode(event(122, 2396)));
    assert.equal(pending.status, 503);
    assert.equal(JSON.parse(pending.body).code, 'PROVIDER_NOT_CONFIGURED');
    assert.equal(app.repository.findEvent(122), undefined);
    const unconfigured = await post(encode(event(121, 57, 'VIEW_IMAGES_PATIENT')));
    // This configured test client filters patient events, rather than sending them.
    assert.equal(JSON.parse(unconfigured.body).status, 'filtered');
  });
  await t.test('group ID selects the correct service; duplicate IDs never cross groups', async () => {
    const result = await post(encode(event(130, 57)));
    assert.equal(result.status, 200);
    await app.worker.wake();
    assert.equal(calls.length, 3);
    assert.ok(calls.every((job) => job.event.groupId === 57 && job.group.credentialRefs.apiKey === 'GROUP_57_TEST_KEY'));
    assert.equal((await post(encode(event(130, 42)))).status, 409);
    assert.equal(JSON.parse((await post(encode(event(130, 57)))).body).status, 'duplicate');
    assert.equal((await post(encode(event(131, 57)), {}, { Authorization: 'Basic invalid' })).status, 401);
  });
  await t.test('eight parallel retries and duplicate mobile numbers create one set of jobs', async () => {
    const value = event(140); value.payload.recipients.push(value.payload.recipients[0]);
    const raw = encode(value);
    const results = await Promise.all(Array.from({ length: 8 }, () => post(raw)));
    assert.equal(results.filter((result) => JSON.parse(result.body).status === 'accepted').length, 1);
    assert.equal(results.filter((result) => JSON.parse(result.body).status === 'duplicate').length, 7);
    assert.equal(app.repository.listJobs().filter((job) => job.event_id === 140).length, 3);
  });
  await t.test('invalid JSON, schema, encoding and oversized bodies are rejected', async () => {
    for (const raw of [Buffer.from('{invalid'), encode(null), encode({}), encode({ ...event(150), groupId: '42' }), Buffer.from([0xff])]) {
      assert.equal((await post(raw)).status, 400);
    }
    assert.equal((await post(encode(event(151)), {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post(Buffer.alloc(1024 * 1024 + 1, 32))).status, 413);
  });
  await t.test('Unicode and omitted optional fields follow the contract', async () => {
    const value = event(160); value.payload.patientName = 'डेमो रोगी';
    assert.equal((await post(Buffer.from(JSON.stringify(value, null, 2)))).status, 200);
    const empty = event(161); delete empty.payload.recipients; delete empty.payload.shareLink; delete empty.payload.patientName;
    assert.equal((await post(encode(empty))).status, 200);
    assert.equal(app.repository.listJobs().filter((job) => job.event_id === 161).length, 0);
  });
  await t.test('persistent IDs survive a server restart', async () => {
    await app.close(); app = createApplication(config, options); await start();
    assert.equal(JSON.parse((await post(encode(event(140)))).body).status, 'duplicate');
    assert.equal(app.repository.listJobs().filter((job) => job.event_id === 140).length, 3);
  });
  await t.test('logs correlate requests/jobs without patient data, headers or credentials', async () => {
    const logs = fs.readdirSync(config.logDir).map((file) => fs.readFileSync(path.join(config.logDir, file), 'utf8')).join('');
    const lines = logs.trim().split('\n').map(JSON.parse);
    assert.ok(lines.some((entry) => entry.event === 'outbox.accepted' && entry.groupId === 42 && entry.requestId));
    assert.ok(lines.some((entry) => entry.event === 'notification.simulated' && entry.jobId));
    assert.ok(lines.some((entry) => entry.route === '/outbox' && entry.method === 'POST' && entry.httpStatus === 401));
    for (const value of ['DEMO PATIENT', '9876500001', credentials.password, credentials.secret, 'X-Signature', 'Authorization', 'pacs.example.com', '123456']) assert.ok(!logs.includes(value), `logs must not contain ${value}`);
  });
});

test('an incomplete provider configuration is rejected before acknowledging or storing an event', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nandico-provider-config-'));
  const app = createApplication(baseConfig(directory), { logger: createLogger({ output: null }) });
  try {
    const address = await app.start(0);
    const raw = encode(event(1, 2396));
    const result = await send(`http://127.0.0.1:${address.port}/outbox`, raw, sign(raw, credentials));
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.body).code, 'PROVIDER_NOT_CONFIGURED');
    assert.equal(app.repository.findEvent(1), undefined);
    assert.equal(app.repository.listJobs().length, 0);
  } finally { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('retryable provider failures persist their schedule and can recover without duplicating jobs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nandico-retries-'));
  const config = { ...baseConfig(directory), workerIntervalMs: 60_000 };
  let attempts = 0;
  const app = createApplication(config, { logger: createLogger({ output: null }),
    groupLookup: (groupId) => ({ groupId, provider: 'limited', enabled: true, events: ['SIGNOFF'], credentialRefs: {} }),
    providers: { limited: { isConfigured: () => true, send: async () => {
      if (attempts++ === 0) throw new ProviderError('HTTP_429', { retryable: true });
      return { status: 'accepted' };
    } } },
  });
  try {
    const address = await app.start(0);
    const value = event(1, 57); value.payload.recipients = [value.payload.recipients[0]];
    const raw = encode(value);
    assert.equal((await send(`http://127.0.0.1:${address.port}/outbox`, raw, sign(raw, credentials))).status, 200);
    await app.worker.wake();
    const job = app.repository.listJobs()[0];
    assert.equal(job.status, 'retry_wait');
    const scheduled = app.repository.db.prepare('SELECT next_attempt_ms FROM jobs WHERE id=?').get(job.id);
    assert.ok(scheduled.next_attempt_ms > Date.now() + 50000);
    app.repository.db.prepare('UPDATE jobs SET next_attempt_ms=0 WHERE id=?').run(job.id);
    await app.worker.wake();
    assert.equal(app.repository.listJobs()[0].status, 'accepted');
    assert.equal(app.repository.listJobs()[0].attempts, 2);
    assert.equal(app.repository.listJobs().length, 1);
  } finally { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('HTTP acknowledgement does not wait for a slow provider', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nandico-fast-ack-'));
  const config = baseConfig(directory);
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let started = false;
  const app = createApplication(config, { logger: createLogger({ output: null }),
    groupLookup: (id) => ({ groupId: id, provider: 'slow', enabled: true, events: ['SIGNOFF'], credentialRefs: {} }),
    providers: { slow: { isConfigured: () => true, send: async () => { started = true; await wait; return { status: 'accepted' }; } } },
  });
  try {
    const address = await app.start(0);
    const raw = encode(event(1, 57));
    const response = await Promise.race([
      send(`http://127.0.0.1:${address.port}/outbox`, raw, sign(raw, credentials)),
      new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('acknowledgement waited for provider')), 2000); timeout.unref(); }),
    ]);
    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, true);
  } finally { release(); await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('AiSensy adapter uses the group credential, template order and safe failure classification', async () => {
  const config = { providerEnv: { GROUP_57_KEY: 'client-private-key' }, providerTimeoutMs: 15000 };
  let captured;
  const provider = new AiSensyProviderService(config, async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });
  const group = { credentialRefs: { apiKey: 'GROUP_57_KEY' }, templates: { SIGNOFF: { name: 'Report Ready', fields: ['patientName', 'shareLink', 'otpCode'] } } };
  const job = { event: event(1, 57), mobile: '9876500001', group };
  assert.equal(provider.isConfigured(group, 'SIGNOFF'), true);
  assert.equal((await provider.send(job)).status, 'accepted');
  assert.equal(captured.url, 'https://backend.aisensy.com/campaign/t1/api/v2');
  assert.equal(captured.body.apiKey, 'client-private-key');
  assert.equal(captured.body.destination, '+919876500001');
  assert.equal(captured.body.templateParams[2], '123456');
  provider.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  await assert.rejects(provider.send(job), (error) => error instanceof ProviderError && error.retryable);
  provider.fetch = async () => { throw new Error('echo client-private-key'); };
  await assert.rejects(provider.send(job), (error) => error.ambiguous && !error.message.includes('client-private-key'));
  provider.fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: false, error: 'client-private-key' }) });
  await assert.rejects(provider.send(job), (error) => error.code === 'AISENSY_REJECTED');
});

test('repository recovery is explicit and CLI-style opening does not reset active jobs', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nandico-recovery-'));
  let repository = new OutboxRepository(directory);
  try {
    const value = event(1);
    repository.accept(value, { groupId: 42, provider: 'demo', events: ['SIGNOFF'] }, encode(value), 'request-id');
    const job = repository.claimJob();
    const inspector = new OutboxRepository(directory);
    assert.equal(inspector.getJob(job.id).status, 'processing'); inspector.close();
    repository.close(); repository = new OutboxRepository(directory);
    assert.equal(repository.recoverInterruptedJobs(), 1);
    assert.equal(repository.getJob(job.id).status, 'needs_review');
    assert.equal(repository.retryJob(job.id), true);
    assert.equal(repository.getJob(job.id).status, 'pending');
  } finally { repository.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('production configuration rejects example credentials and demo mode', () => {
  assert.throws(() => loadConfig({}), /BASIC_PASSWORD/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', BASIC_PASSWORD: 'example-password', HMAC_SECRET: 'example-secret' }), /real PACS credentials/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', BASIC_PASSWORD: 'real-password', HMAC_SECRET: 'real-secret', ALLOW_DEMO_GROUP: 'true' }), /Disable ALLOW_DEMO_GROUP/);
  const config = loadConfig({ NODE_ENV: 'production', BASIC_PASSWORD: 'real-password', HMAC_SECRET: 'real-secret' });
  assert.equal(config.allowDemoGroup, false);
});

test('custom provider adapters must return a recognized acknowledgement', async () => {
  const service = new NotificationService({ get: () => ({ send: async () => ({ status: 'delivered' }) }) });
  await assert.rejects(service.send({ event: event(1), group: { provider: 'custom' } }), (error) => error.code === 'PROVIDER_ACK_INVALID' && error.ambiguous);
});

test('Postman collection signs its resolved body and reaches the local receiver', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nandico-postman-'));
  const app = createApplication(baseConfig(directory), { logger: createLogger({ output: null }) });
  const collection = JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/local.postman_collection.json')));
  const script = collection.event[0].script.exec.join('\n');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    const address = await app.start(0);
    for (const item of collection.item.filter(item => item.request.method === 'POST')) {
      const values = new Map(collection.variable.map(variable => [variable.key, variable.value]));
      values.set('baseUrl', `http://127.0.0.1:${address.port}`);
      values.set('basicPassword', credentials.password);
      values.set('hmacSecret', credentials.secret);
      const replaceIn = text => text.replace(/\{\{([^}]+)\}\}/g, (_, name) => values.get(name) ?? '');
      let skipped = false;
      const pm = { request: item.request, execution: { skipRequest: () => { skipped = true; } }, variables: {
        get: name => values.get(name), set: (name, value) => values.set(name, value), replaceIn,
      } };
      const run = () => new AsyncFunction('pm', 'crypto', 'require', script)(pm, crypto.webcrypto, require);
      if (item.name.includes('2396')) {
        await assert.rejects(run(), /allowGroup2396Send/);
        assert.equal(skipped, true);
        skipped = false;
        values.set('allowGroup2396Send', 'true');
        await assert.rejects(run(), /testMobile/);
        assert.equal(skipped, true);
        skipped = false;
        values.set('testMobile', '9876500001');
      }
      await run();
      assert.equal(skipped, false);
      const raw = Buffer.from(replaceIn(item.request.body.raw));
      const headers = Object.fromEntries(item.request.header.map(header => [header.key, replaceIn(header.value)]));
      headers.Authorization = 'Basic ' + Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64');
      const response = await send(replaceIn(item.request.url), raw, headers);
      const groupId = JSON.parse(raw).groupId;
      assert.equal(response.status, groupId === 42 ? 200 : 503);
      if (groupId === 2396) assert.equal(JSON.parse(response.body).code, 'PROVIDER_NOT_CONFIGURED');
    }
  } finally { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
