import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool, pool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import { env } from '../src/config/env.js';
import { createWidget, migrateOnce, registerTenant, resetDatabase, validSubmission } from './helpers.js';

const app = createApp();

beforeAll(migrateOnce);
beforeEach(resetDatabase);
afterAll(closePool);

describe('CORS on the public submission endpoint', () => {
  it('answers the preflight with the methods and headers the widget uses', async () => {
    const response = await request(app)
      .options('/api/public/submissions')
      .set('origin', 'https://a-customer-site.example')
      .set('access-control-request-method', 'POST')
      .set('access-control-request-headers', 'content-type,idempotency-key')
      .expect(204);

    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toContain('idempotency-key');
    // Without a max-age the browser re-preflights before every submission.
    expect(Number(response.headers['access-control-max-age'])).toBeGreaterThan(0);
  });

  it('allows the actual POST from an origin it has never seen', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    const response = await request(app)
      .post('/api/public/submissions')
      .set('origin', 'https://some-random-customer.example')
      .send(validSubmission(widget.publicId))
      .expect(202);

    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it('restricts the admin API to the configured origins', async () => {
    const tenant = await registerTenant(app);
    await request(app)
      .get('/api/widgets')
      .set('origin', env.ADMIN_CORS_ORIGINS[0] as string)
      .set(...tenant.auth())
      .expect(200);

    // An unlisted origin is refused before it reaches the route.
    await request(app)
      .get('/api/widgets')
      .set('origin', 'https://evil.example')
      .set(...tenant.auth())
      .expect(403);
  });
});

describe('storing a valid submission', () => {
  it('stores the submission against the right widget and tenant', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    const response = await request(app)
      .post('/api/public/submissions')
      .set('origin', 'http://localhost:5500')
      .send(validSubmission(widget.publicId, { pageUrl: 'http://localhost:5500/pricing' }))
      .expect(202);

    expect(response.body).toMatchObject({ ok: true, id: expect.any(String) });
    expect(response.headers['cache-control']).toBe('no-store');

    const listed = await request(app)
      .get('/api/dashboard/submissions')
      .set(...tenant.auth())
      .expect(200);

    expect(listed.body.submissions).toHaveLength(1);
    expect(listed.body.submissions[0]).toMatchObject({
      widgetId: widget.id,
      tenantId: tenant.tenantId,
      status: 'stored',
      pageUrl: 'http://localhost:5500/pricing',
      data: { email: 'visitor@example.com', consent: true },
    });
  });

  it('normalises what it stores and drops nothing the widget declared', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant, {
      fields: [
        { name: 'email', label: 'Email', type: 'email', required: true },
        { name: 'note', label: 'Note', type: 'textarea', required: false },
      ],
    });

    await request(app)
      .post('/api/public/submissions')
      .send({ widgetId: widget.publicId, data: { email: '  Visitor@EXAMPLE.com  ', note: '  hi  ' } })
      .expect(202);

    const listed = await request(app).get('/api/dashboard/submissions').set(...tenant.auth()).expect(200);
    expect(listed.body.submissions[0].data).toEqual({ email: 'visitor@example.com', note: 'hi' });
    expect(listed.body.submissions[0].email).toBe('visitor@example.com');
  });
});

describe('boundary validation', () => {
  it('rejects a malformed JSON body with a 400, never a 500', async () => {
    const response = await request(app)
      .post('/api/public/submissions')
      .set('content-type', 'application/json')
      .send('{"widgetId": ')
      .expect(400);

    expect(response.body.error.code).toBe('bad_request');
    expect(response.body.error).toHaveProperty('requestId');
  });

  it('rejects an oversized payload with a 413 and JSON', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    const response = await request(app)
      .post('/api/public/submissions')
      .set('content-type', 'application/json')
      .send(
        JSON.stringify({
          widgetId: widget.publicId,
          data: { email: 'v@example.com', consent: true, note: 'x'.repeat(env.SUBMISSION_BODY_LIMIT_BYTES) },
        }),
      )
      .expect(413);

    expect(response.body.error.code).toBe('payload_too_large');
  });

  it('rejects fields the widget never declared', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    const response = await request(app)
      .post('/api/public/submissions')
      .send(validSubmission(widget.publicId, { data: { email: 'v@example.com', consent: true, is_admin: 'yes' } }))
      .expect(422);

    expect(response.body.error.details[0].message).toMatch(/unrecognized key/i);
  });

  it('reports every invalid field at once, with the field name', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    const response = await request(app)
      .post('/api/public/submissions')
      .send({ widgetId: widget.publicId, data: { email: 'nope', consent: false } })
      .expect(422);

    expect(response.body.error.details).toEqual(
      expect.arrayContaining([
        { path: 'email', message: 'Must be a valid email address' },
        { path: 'consent', message: 'I agree is required' },
      ]),
    );
  });

  it('404s for an unknown widget instead of leaking whether the id exists', async () => {
    const response = await request(app)
      .post('/api/public/submissions')
      .send(validSubmission('doesnotexist1234'))
      .expect(404);
    expect(response.body.error.code).toBe('not_found');
  });

  it('rejects an unparseable widget id at the schema, before any query runs', async () => {
    await request(app).post('/api/public/submissions').send(validSubmission('!!')).expect(422);
  });

  it('enforces a widget’s origin allow-list when it has one', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant, { allowedOrigins: ['https://acme.example'] });

    await request(app)
      .post('/api/public/submissions')
      .set('origin', 'https://not-acme.example')
      .send(validSubmission(widget.publicId))
      .expect(403);

    await request(app)
      .post('/api/public/submissions')
      .set('origin', 'https://acme.example')
      .send(validSubmission(widget.publicId))
      .expect(202);
  });
});

describe('spam controls', () => {
  it('silently drops a submission with a filled honeypot', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    const response = await request(app)
      .post('/api/public/submissions')
      .send(
        validSubmission(widget.publicId, {
          data: { email: 'bot@spam.test', consent: true, company_website: 'http://spam.example' },
        }),
      )
      .expect(202);

    // A bot must not be able to tell it was caught: same status, same shape.
    expect(response.body.ok).toBe(true);

    const stored = await request(app)
      .get('/api/dashboard/submissions?status=stored')
      .set(...tenant.auth())
      .expect(200);
    expect(stored.body.submissions).toHaveLength(0);

    const spam = await request(app)
      .get('/api/dashboard/submissions?status=spam')
      .set(...tenant.auth())
      .expect(200);
    expect(spam.body.submissions).toHaveLength(1);
    expect(spam.body.submissions[0].spamReason).toBe('honeypot_filled');
    // The honeypot value itself is never kept.
    expect(spam.body.submissions[0].data).not.toHaveProperty('company_website');
  });

  it('flags a form that was filled impossibly fast', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    await request(app)
      .post('/api/public/submissions')
      .send(validSubmission(widget.publicId, { elapsedMs: 40 }))
      .expect(202);

    const spam = await request(app)
      .get('/api/dashboard/submissions?status=spam')
      .set(...tenant.auth())
      .expect(200);
    expect(spam.body.submissions[0].spamReason).toBe('submitted_too_fast');
  });

  it('lets a human-paced submission through', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    await request(app)
      .post('/api/public/submissions')
      .send(validSubmission(widget.publicId, { elapsedMs: 9_000 }))
      .expect(202);

    const stored = await request(app)
      .get('/api/dashboard/submissions?status=stored')
      .set(...tenant.auth())
      .expect(200);
    expect(stored.body.submissions).toHaveLength(1);
  });
});

describe('idempotency', () => {
  it('stores one row when the same request is retried with the same key', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    const first = await request(app)
      .post('/api/public/submissions')
      .set('idempotency-key', 'retry-me-once')
      .send(validSubmission(widget.publicId))
      .expect(202);

    const replay = await request(app)
      .post('/api/public/submissions')
      .set('idempotency-key', 'retry-me-once')
      .send(validSubmission(widget.publicId))
      .expect(200);

    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.duplicate).toBe(true);
    expect(replay.headers['idempotent-replay']).toBe('true');

    const { rows } = await pool.query('SELECT count(*)::int AS count FROM submissions');
    expect(rows[0].count).toBe(1);
  });

  it('keeps concurrent retries of the same key down to a single row', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    // Five requests in flight at once: the unique index is the only thing
    // standing between this and five duplicate leads.
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post('/api/public/submissions')
          .set('idempotency-key', 'concurrent-key')
          .send(validSubmission(widget.publicId)),
      ),
    );

    expect(responses.every((response) => response.status === 202 || response.status === 200)).toBe(true);
    const ids = new Set(responses.map((response) => response.body.id));
    expect(ids.size).toBe(1);

    const { rows } = await pool.query('SELECT count(*)::int AS count FROM submissions');
    expect(rows[0].count).toBe(1);
  });

  it('treats different keys as different submissions', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    await request(app)
      .post('/api/public/submissions')
      .set('idempotency-key', 'key-a')
      .send(validSubmission(widget.publicId))
      .expect(202);
    await request(app)
      .post('/api/public/submissions')
      .set('idempotency-key', 'key-b')
      .send(validSubmission(widget.publicId))
      .expect(202);

    const { rows } = await pool.query('SELECT count(*)::int AS count FROM submissions');
    expect(rows[0].count).toBe(2);
  });
});
