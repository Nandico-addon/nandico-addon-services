'use strict';

const { ProviderError } = require('../utils/errors');

class WorkerService {
  constructor(repository, notifications, config, logger) {
    this.repository = repository; this.notifications = notifications;
    this.config = config; this.logger = logger;
    this.running = false; this.stopped = false; this.pending = Promise.resolve();
  }

  start() {
    const count = this.repository.recoverInterruptedJobs();
    if (count) this.logger.warn('worker.interrupted_jobs_need_review', { count });
    this.timer = setInterval(() => this.wake(), this.config.workerIntervalMs);
    this.timer.unref(); this.wake();
  }

  wake() {
    if (!this.running && !this.stopped) this.pending = this.tick();
    return this.pending;
  }

  async tick() {
    this.running = true;
    try {
      for (let count = 0; count < 25 && !this.stopped; count++) {
        const job = this.repository.claimJob();
        if (!job) break;
        const context = { requestId: job.requestId, eventId: job.event.id, groupId: job.event.groupId,
          eventType: job.event.type, provider: job.group.provider, jobId: job.id, attempt: job.attempts };
        this.logger.info('notification.started', context);
        let outcome;
        try { outcome = await this.notifications.send(job); }
        catch (error) {
          const known = error instanceof ProviderError;
          const ambiguous = !known || error.ambiguous;
          const retry = known && error.retryable && job.attempts < this.config.maxDeliveryAttempts;
          outcome = {
            status: ambiguous ? 'needs_review' : retry ? 'retry_wait' : 'failed',
            errorCode: known ? error.code : 'UNEXPECTED_PROVIDER_ERROR',
            nextAttemptMs: retry ? Date.now() + Math.min(3600000, 60000 * 2 ** (job.attempts - 1)) : 0,
          };
        }
        // Persist before claiming another job. A failed local write leaves it
        // processing; startup recovery marks it needs_review instead of resending.
        this.repository.finishJob(job.id, outcome);
        this.logger[outcome.status === 'failed' || outcome.status === 'needs_review' ? 'error' : outcome.status === 'retry_wait' ? 'warn' : 'info']
          (`notification.${outcome.status}`, { ...context, status: outcome.status, errorCode: outcome.errorCode });
      }
    } catch { this.logger.error('worker.storage_failed', { errorCode: 'WORKER_STORAGE_ERROR' }); }
    finally { this.running = false; }
  }

  async stop() { this.stopped = true; clearInterval(this.timer); await this.pending; }
}

module.exports = { WorkerService };
