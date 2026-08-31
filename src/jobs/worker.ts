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

const backoffSeconds = (attempts: number): number => Math.min(2 ** attempts, 300);

const runJob = async (job: Job): Promise<void> => {
  const handler = HANDLERS[job.type];

  if (!handler) {
    // A missing handler is a deploy problem, not a transient fault: retrying it
    // would only delay the alert.
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
      // The line an alerting rule matches on in a hosted deployment.
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
  // Runs one batch synchronously; lets tests drive the worker without timers.
  tick(): Promise<number>;
}

export const createWorker = (): Worker => {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = false;

  const tick = async (): Promise<number> => {
    // Ticks must not overlap: a slow batch would otherwise stack them up until
    // the connection pool is exhausted.
    if (running) return 0;
    running = true;
    try {
      const requeued = await jobsRepository.requeueStale(STALE_JOB_SECONDS);
      if (requeued > 0) logger.warn({ requeued }, 'requeued stale jobs from a dead worker');

      // Safe as Promise.all rather than allSettled because runJob never rejects.
      const jobs = await jobsRepository.claimBatch(env.JOB_BATCH_SIZE);
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
      // Drain an in-flight batch so shutdown does not orphan claimed jobs.
      while (running) await new Promise((resolve) => setTimeout(resolve, 25));
    },
    tick,
  };
};
