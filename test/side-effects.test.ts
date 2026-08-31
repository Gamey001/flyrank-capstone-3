import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { closePool, pool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import { createWorker } from '../src/jobs/worker.js';
import { jobsRepository } from '../src/repositories/jobs.repository.js';
import { mailer } from '../src/services/mailer.js';
import { createWidget, migrateOnce, registerTenant, resetDatabase, validSubmission } from './helpers.js';

/**
 * Safe side effects: storing the lead is the job that must not fail. The
 * confirmation email and the webhook are consequences of it, and are allowed
 * to fail, retry, and eventually give up — without the visitor ever knowing.
 */

const app = createApp();
const worker = createWorker();

beforeAll(migrateOnce);
beforeEach(async () => {
  await resetDatabase();
  vi.restoreAllMocks();
});
afterAll(closePool);

const jobsFor = async (type: string) => {
  const { rows } = await pool.query('SELECT * FROM jobs WHERE type = $1 ORDER BY created_at', [type]);
  return rows;
};

describe('side effects are queued, not inlined', () => {
  it('commits the submission and its notification job together', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant, {
      notifyEmail: 'owner@example.test',
      webhookUrl: 'https://hooks.example/inbox',
    });

    await request(app).post('/api/public/submissions').send(validSubmission(widget.publicId)).expect(202);

    // The transactional outbox: the row and the work it implies exist together
    // or not at all.
    expect(await jobsFor('submission.notify_email')).toHaveLength(1);
    expect(await jobsFor('submission.webhook')).toHaveLength(1);
  });

  it('queues nothing for a widget with no notification configured', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    await request(app).post('/api/public/submissions').send(validSubmission(widget.publicId)).expect(202);
    expect(await jobsFor('submission.notify_email')).toHaveLength(0);
  });

  it('does not notify anyone about spam', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant, { notifyEmail: 'owner@example.test' });

    await request(app)
      .post('/api/public/submissions')
      .send(
        validSubmission(widget.publicId, {
          data: { email: 'bot@spam.test', consent: true, company_website: 'http://spam.example' },
        }),
      )
      .expect(202);

    expect(await jobsFor('submission.notify_email')).toHaveLength(0);
  });
});

describe('a failing side effect never breaks the submission', () => {
  it('stores and returns success even when the mail provider is down', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant, { notifyEmail: 'owner@example.test' });

    const send = vi.spyOn(mailer, 'send').mockRejectedValue(new Error('simulated mail provider outage'));

    const response = await request(app)
      .post('/api/public/submissions')
      .send(validSubmission(widget.publicId))
      .expect(202);
    expect(response.body.ok).toBe(true);

    // The visitor already has their answer; the failure happens afterwards.
    await worker.tick();
    expect(send).toHaveBeenCalled();

    const stored = await request(app).get('/api/dashboard/submissions').set(...tenant.auth()).expect(200);
    expect(stored.body.submissions).toHaveLength(1);
    expect(stored.body.submissions[0].id).toBe(response.body.id);

    const [job] = await jobsFor('submission.notify_email');
    expect(job.status).toBe('pending'); // scheduled for retry, not lost
    expect(job.attempts).toBe(1);
    expect(job.last_error).toContain('simulated mail provider outage');
  });

  it('stores and returns success even when the webhook endpoint is unreachable', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant, {
      // A port nothing is listening on: the delivery genuinely fails.
      webhookUrl: 'http://127.0.0.1:9/never-listening',
    });

    const response = await request(app)
      .post('/api/public/submissions')
      .send(validSubmission(widget.publicId))
      .expect(202);

    await worker.tick();

    const [job] = await jobsFor('submission.webhook');
    expect(job.attempts).toBe(1);
    expect(job.status).toBe('pending');

    const stored = await request(app).get('/api/dashboard/submissions').set(...tenant.auth()).expect(200);
    expect(stored.body.submissions[0].id).toBe(response.body.id);
  });
});

describe('the background worker', () => {
  it('retries with backoff, then marks the job dead and raises an alert', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant, { notifyEmail: 'owner@example.test' });
    vi.spyOn(mailer, 'send').mockRejectedValue(new Error('still down'));

    await request(app).post('/api/public/submissions').send(validSubmission(widget.publicId)).expect(202);

    const [queued] = await jobsFor('submission.notify_email');
    // Two attempts allowed, so the ceiling is reached in a bounded test.
    await pool.query('UPDATE jobs SET max_attempts = 2 WHERE id = $1', [queued.id]);

    await worker.tick();
    let job = await jobsRepository.findById(queued.id);
    expect(job?.status).toBe('pending');
    // Backoff: the retry is scheduled in the future, not run immediately.
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now());

    await pool.query('UPDATE jobs SET run_at = now() WHERE id = $1', [queued.id]);
    await worker.tick();

    job = await jobsRepository.findById(queued.id);
    expect(job?.status).toBe('dead');
    expect(job?.attempts).toBe(2);
    expect(job?.lastError).toContain('still down');
  });

  it('marks a job succeeded once its handler stops failing', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant, { notifyEmail: 'owner@example.test' });

    const send = vi
      .spyOn(mailer, 'send')
      .mockRejectedValueOnce(new Error('transient blip'))
      .mockResolvedValue(undefined);

    await request(app).post('/api/public/submissions').send(validSubmission(widget.publicId)).expect(202);
    const [queued] = await jobsFor('submission.notify_email');

    await worker.tick();
    expect((await jobsRepository.findById(queued.id))?.status).toBe('pending');

    await pool.query('UPDATE jobs SET run_at = now() WHERE id = $1', [queued.id]);
    await worker.tick();

    const job = await jobsRepository.findById(queued.id);
    expect(job?.status).toBe('succeeded');
    expect(job?.lastError).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('gives up immediately on a job type it has no handler for', async () => {
    const job = await jobsRepository.enqueue({ type: 'nonexistent.type', payload: {} });
    await worker.tick();

    const after = await jobsRepository.findById(job.id);
    // A missing handler is a deploy bug, not a transient fault — retrying it
    // five times only delays the alert.
    expect(after?.status).toBe('dead');
    expect(after?.attempts).toBe(1);
  });

  it('reclaims a job abandoned by a worker that died mid-run', async () => {
    const job = await jobsRepository.enqueue({ type: 'submission.notify_email', payload: { submissionId: 'x', to: 'y' } });
    await pool.query(`UPDATE jobs SET status = 'running', locked_at = now() - interval '10 minutes' WHERE id = $1`, [
      job.id,
    ]);

    const requeued = await jobsRepository.requeueStale(120);
    expect(requeued).toBe(1);
    expect((await jobsRepository.findById(job.id))?.status).toBe('pending');
  });

  it('claims each job exactly once when workers run concurrently', async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        jobsRepository.enqueue({ type: 'submission.notify_email', payload: { n: i } }),
      ),
    );

    // FOR UPDATE SKIP LOCKED is what makes this safe: two workers claiming at
    // the same moment must take disjoint sets, never the same job twice.
    const [a, b] = await Promise.all([jobsRepository.claimBatch(10), jobsRepository.claimBatch(10)]);
    const ids = [...a, ...b].map((job) => job.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(6);
  });
});
