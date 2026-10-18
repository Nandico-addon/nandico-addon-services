'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

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
      const recipients = [...new Map((event.payload.recipients || []).map((r) => [r.mobile, r])).values()];
      const filtered = !group.events.includes(event.type);
      const disposition = filtered ? 'filtered' : recipients.length ? 'queued' : 'no_recipients';
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO events (id,group_id,type,body,group_config,request_id,disposition,received_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(event.id, event.groupId, event.type, rawBody.toString('utf8'), JSON.stringify(group), requestId, disposition, now);
      if (!filtered) {
        const insert = this.db.prepare('INSERT INTO jobs(event_id,mobile,kind,updated_at) VALUES (?,?,?,?)');
        for (const recipient of recipients) insert.run(event.id, recipient.mobile, recipient.kind, now);
      }
      this.db.exec('COMMIT');
      return { duplicate: false, disposition, recipientCount: filtered ? 0 : recipients.length };
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
      return row ? { id: row.id, mobile: row.mobile, kind: row.kind, attempts: row.attempts + 1,
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
    const query = `SELECT j.id,j.event_id,e.group_id,j.status,j.attempts,j.provider_message_id,j.error_code,j.updated_at FROM jobs j JOIN events e ON e.id=j.event_id`;
    return status ? this.db.prepare(query + ' WHERE j.status=? ORDER BY j.id DESC LIMIT 100').all(status)
      : this.db.prepare(query + ' ORDER BY j.id DESC LIMIT 100').all();
  }

  ping() { this.db.prepare('SELECT 1').get(); }
  close() { this.db.close(); }
}

module.exports = { OutboxRepository };
