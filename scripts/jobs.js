'use strict';

const { loadConfig } = require('../src/config/env');
const { OutboxRepository } = require('../src/repositories/outbox.repository');

function main() {
  const args = process.argv.slice(2);
  const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const repository = new OutboxRepository(loadConfig().dataDir);
  try {
    if (!args.length || args[0] === 'list') {
      console.table(repository.listJobs(option('--status')));
      return;
    }
    if (args[0] === 'retry') {
      const id = Number(option('--id'));
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Supply a positive --id');
      const job = repository.getJob(id);
      if (!job) throw new Error('Job not found');
      if (job.status === 'needs_review' && !args.includes('--confirm-possible-duplicate')) throw new Error('Check provider logs first, then pass --confirm-possible-duplicate if a resend is appropriate');
      if (!repository.retryJob(id)) throw new Error('Only failed or reviewed jobs can be retried');
      console.log(`Job ${id} is pending. The running worker will process it.`);
      return;
    }
    throw new Error('Use: jobs list [--status STATUS] | jobs retry --id ID [--confirm-possible-duplicate]');
  } finally { repository.close(); }
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
