import { env } from '../config/env.js';
import type { Job } from '../domain/models.js';
import { logger } from '../lib/logger.js';
import { jobsRepository } from '../repositories/jobs.repository.js';
import { assertEmailPayload, submissionEmailHandler } from './handlers/submission-email.handler.js';
import { assertWebhookPayload, submissionWebhookHandler } from './handlers/submission-webhook.handler.js';
import { JOB_TYPES } from './types.js';

type Handler = (payload: Record<string, unknown>) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  [JOB_TYPES.submissionEmail]: (payload) => submissionEmailHandler(assertEmailPayload(payload)),
  [JOB_TYPES.submissionWebhook]: (payload) => submissionWebhookHandler(assertWebhookPayload(payload)),
};

// A job still 'running' after this long belongs to a worker that died.
const STALE_JOB_SECONDS = 120;

/** Exponential backoff with a ceiling: 2s, 4s, 8s, 16s, … capped at 5 minutes. */
const backoffSeconds = (attempts: number): number => Math.min(2 ** attempts, 300);

const runJob = async (job: Job): Promise<void> => {
  const handler = HANDLERS[job.type];

  if (!handler) {
    // An unknown type is a deploy problem, not a transient fault. Retrying it
    // 5 times just delays the alert.
    logger.error({ jobId: job.id, type: job.type }, 'no handler registered for job type');
    await jobsRepository.markFailed(job.id, `no handler registered for job type "${job.type}"`, {
      retryInSeconds: null,
    });
    return;
  }

  try {
    await handler(job.payload);
    await jobsRepository.markSucceeded(job.id);
    logger.debug({ jobId: job.id, type: job.type, attempts: job.attempts }, 'job succeeded');
  } catch (error) {
    const message = (error as Error).message;
    const exhausted = job.attempts >= job.maxAttempts;

    await jobsRepository.markFailed(job.id, message, {
      retryInSeconds: exhausted ? null : backoffSeconds(job.attempts),
    });

    if (exhausted) {
      // The failure alert required by shared requirement #3. In a hosted
      // deployment this is the line an alerting rule matches on.
      logger.error(
        { jobId: job.id, type: job.type, attempts: job.attempts, err: message, alert: 'job_dead' },
        'JOB DEAD after exhausting retries — needs manual attention',
      );
    } else {
      logger.warn(
        { jobId: job.id, type: job.type, attempts: job.attempts, err: message },
        'job failed, scheduled for retry',
      );
    }
  }
};

export interface Worker {
  start(): void;
  stop(): Promise<void>;
  /** Processes one batch immediately. Exposed so tests need no timers. */
  tick(): Promise<number>;
}

/**
 * Polling worker over the `jobs` table.
 *
 * Polling (rather than a broker) is a deliberate choice for this system: it
 * keeps the $0 stack to one dependency, the queue is transactional with the
 * data it refers to, and at lead-capture volumes a one-second poll is far
 * inside the latency anyone notices.
 */
export const createWorker = (): Worker => {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = false;

  const tick = async (): Promise<number> => {
    // A tick is never allowed to overlap itself: a slow batch would otherwise
    // stack up ticks until the pool is exhausted.
    if (running) return 0;
    running = true;
    try {
      const requeued = await jobsRepository.requeueStale(STALE_JOB_SECONDS);
      if (requeued > 0) logger.warn({ requeued }, 'requeued stale jobs from a dead worker');

      const jobs = await jobsRepository.claimBatch(env.JOB_BATCH_SIZE);
      // Batch members are independent; one slow webhook should not delay the
      // rest, and runJob never rejects.
      await Promise.all(jobs.map(runJob));
      return jobs.length;
    } catch (error) {
      logger.error({ err: error }, 'job worker tick failed');
      return 0;
    } finally {
      running = false;
    }
  };

  const loop = (): void => {
    if (stopped) return;
    void tick().finally(() => {
      if (stopped) return;
      timer = setTimeout(loop, env.JOB_POLL_INTERVAL_MS);
      timer.unref();
    });
  };

  return {
    start() {
      if (timer || stopped) return;
      logger.info({ intervalMs: env.JOB_POLL_INTERVAL_MS, batch: env.JOB_BATCH_SIZE }, 'job worker started');
      loop();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      // Let an in-flight batch finish so a shutdown does not orphan jobs.
      while (running) await new Promise((resolve) => setTimeout(resolve, 25));
    },
    tick,
  };
};
