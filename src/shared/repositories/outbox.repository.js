'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { planJobs } = require('../services/delivery-plan.service');

class OutboxRepository {
  constructor(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = path.join(directory, 'outbox.sqlite');
    this.db = new DatabaseSync(filename);
    fs.chmodSync(filename, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, type TEXT NOT NULL,
        body TEXT NOT NULL, group_config TEXT NOT NULL, request_id TEXT NOT NULL,
        disposition TEXT NOT NULL, received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES events(id),
        mobile TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER NOT NULL DEFAULT 0,
        provider_message_id TEXT, error_code TEXT, updated_at TEXT NOT NULL,
        UNIQUE(event_id, mobile)
      );
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status, next_attempt_ms);
    `);
    // Additive migration preserves queued notifications and their saved routes.
    const columns = new Set(this.db.prepare('PRAGMA table_info(jobs)').all().map(column => column.name));
    if (!columns.has('action')) this.db.exec("ALTER TABLE jobs ADD COLUMN action TEXT NOT NULL DEFAULT 'notify'");
    if (!columns.has('operation_key')) this.db.exec('ALTER TABLE jobs ADD COLUMN operation_key TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS jobs_operation_key ON jobs(operation_key) WHERE operation_key IS NOT NULL');
  }

  findEvent(id) { return this.db.prepare('SELECT id, group_id, disposition FROM events WHERE id=?').get(id); }

  accept(event, group, rawBody, requestId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.findEvent(event.id);
      if (previous) {
        this.db.exec('COMMIT');
        return { duplicate: true, conflict: previous.group_id !== event.groupId };
      }
      const planned = planJobs(event, group);
      const filtered = !group.events.includes(event.type);
      let disposition = filtered ? 'filtered' : planned.length ? 'queued' : group.jobMode === 'hims' ? 'no_action' : 'no_recipients';
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO events (id,group_id,type,body,group_config,request_id,disposition,received_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(event.id, event.groupId, event.type, rawBody.toString('utf8'), JSON.stringify(group), requestId, disposition, now);
      let jobCount = 0;
      const insert = this.db.prepare('INSERT INTO jobs(event_id,mobile,kind,action,operation_key,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING');
      for (const job of planned) jobCount += Number(insert.run(event.id, job.mobile, job.kind, job.action, job.operationKey, now).changes);
      if (planned.length && !jobCount) {
        disposition = 'action_already_queued';
        this.db.prepare('UPDATE events SET disposition=? WHERE id=?').run(disposition, event.id);
      }
      this.db.exec('COMMIT');
      return { duplicate: false, disposition, recipientCount: group.jobMode === 'hims' ? 0 : jobCount };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  recoverInterruptedJobs() {
    return Number(this.db.prepare("UPDATE jobs SET status='needs_review',error_code='INTERRUPTED_SEND',updated_at=? WHERE status='processing'")
      .run(new Date().toISOString()).changes);
  }

  claimJob() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT j.*,e.group_id,e.type,e.body,e.group_config,e.request_id FROM jobs j
        JOIN events e ON e.id=j.event_id WHERE j.status IN ('pending','retry_wait') AND j.next_attempt_ms <= ?
        ORDER BY j.id LIMIT 1`).get(Date.now());
      if (row) this.db.prepare("UPDATE jobs SET status='processing',attempts=attempts+1,updated_at=? WHERE id=?")
        .run(new Date().toISOString(), row.id);
      this.db.exec('COMMIT');
      return row ? { id: row.id, mobile: row.mobile, kind: row.kind, action: row.action, attempts: row.attempts + 1,
        event: JSON.parse(row.body), group: JSON.parse(row.group_config), requestId: row.request_id } : null;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  finishJob(id, { status, providerMessageId = null, errorCode = null, nextAttemptMs = 0 }) {
    this.db.prepare('UPDATE jobs SET status=?,provider_message_id=?,error_code=?,next_attempt_ms=?,updated_at=? WHERE id=?')
      .run(status, providerMessageId, errorCode, nextAttemptMs, new Date().toISOString(), id);
  }

  getJob(id) { return this.db.prepare('SELECT id,status FROM jobs WHERE id=?').get(id); }

  retryJob(id) {
    return Number(this.db.prepare("UPDATE jobs SET status='pending',attempts=0,next_attempt_ms=0,error_code=NULL,updated_at=? WHERE id=? AND status IN ('failed','needs_review')")
      .run(new Date().toISOString(), id).changes) > 0;
  }

  listJobs(status) {
    const query = `SELECT j.id,j.event_id,e.group_id,j.action,j.status,j.attempts,j.provider_message_id,j.error_code,j.updated_at FROM jobs j JOIN events e ON e.id=j.event_id`;
    return status ? this.db.prepare(query + ' WHERE j.status=? ORDER BY j.id DESC LIMIT 100').all(status)
      : this.db.prepare(query + ' ORDER BY j.id DESC LIMIT 100').all();
  }

  ping() { this.db.prepare('SELECT 1').get(); }
  close() { this.db.close(); }
}

module.exports = { OutboxRepository };
