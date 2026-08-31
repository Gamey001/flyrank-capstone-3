/**
 * The rate limiters are built from env at module load, so this file lowers the
 * limits *before* importing the app. It is also its own file because vitest
 * gives each file a fresh module registry — these low limits cannot leak into
 * any other test.
 *
 * `TRUST_PROXY_HOPS=1` lets each test present its own client IP via
 * X-Forwarded-For, so tests get independent budgets instead of sharing (and
 * exhausting) 127.0.0.1's.
 */
process.env.RATE_LIMIT_IP_MAX = '5';
process.env.RATE_LIMIT_IP_WINDOW_SECONDS = '60';
process.env.RATE_LIMIT_WIDGET_MAX = '100';
process.env.TRUST_PROXY_HOPS = '1';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

const { closePool } = await import('../src/db/pool.js');
const { createApp } = await import('../src/http/app.js');
const { createWidget, migrateOnce, registerTenant, resetDatabase, validSubmission } = await import('./helpers.js');

const app = createApp();

let visitorIp = 0;
const nextIp = (): string => `203.0.113.${(visitorIp += 1)}`;

beforeAll(migrateOnce);
beforeEach(resetDatabase);
afterAll(closePool);

describe('abuse protection — per-IP rate limiting', () => {
  it('returns 429 under a burst and keeps the API serving everything else', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);
    const ip = nextIp();

    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await request(app)
        .post('/api/public/submissions')
        .set('x-forwarded-for', ip)
        .send(validSubmission(widget.publicId, { data: { email: `burst${i}@example.com`, consent: true } }));
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses.slice(5)).toEqual(Array.from({ length: 7 }, () => 429));

    // The point of a rate limit is that the service stays up. A flooding client
    // must not take the rest of the API down with it.
    await request(app).get('/healthz').expect(200);
    await request(app).get(`/api/public/widgets/${widget.publicId}/config`).expect(200);
    await request(app).get('/api/dashboard/stats').set(...tenant.auth()).expect(200);
  });

  it('keeps serving a different visitor while one is being limited', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);
    const flooder = nextIp();
    const bystander = nextIp();

    for (let i = 0; i < 10; i += 1) {
      await request(app)
        .post('/api/public/submissions')
        .set('x-forwarded-for', flooder)
        .send(validSubmission(widget.publicId));
    }

    await request(app)
      .post('/api/public/submissions')
      .set('x-forwarded-for', flooder)
      .send(validSubmission(widget.publicId))
      .expect(429);

    // Legitimate traffic from anywhere else is unaffected — a per-IP limit that
    // punished everyone would be a denial of service, not a defence against one.
    await request(app)
      .post('/api/public/submissions')
      .set('x-forwarded-for', bystander)
      .send(validSubmission(widget.publicId))
      .expect(202);
  });

  it('tells a rejected client how long to wait', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);
    const ip = nextIp();

    let limited: request.Response | null = null;
    for (let i = 0; i < 12 && !limited; i += 1) {
      const response = await request(app)
        .post('/api/public/submissions')
        .set('x-forwarded-for', ip)
        .send(validSubmission(widget.publicId));
      if (response.status === 429) limited = response;
    }

    expect(limited).not.toBeNull();
    expect(limited!.body.error.code).toBe('too_many_requests');
    expect(limited!.body.error.retryAfterSeconds).toBeGreaterThan(0);
    // draft-7 headers, so a well-behaved client can back off on its own.
    expect(limited!.headers['ratelimit']).toBeDefined();
  });

  it('does not spend a visitor’s budget on CORS preflights', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);
    const ip = nextIp();

    for (let i = 0; i < 20; i += 1) {
      await request(app)
        .options('/api/public/submissions')
        .set('x-forwarded-for', ip)
        .set('origin', 'https://customer.example')
        .set('access-control-request-method', 'POST')
        .expect(204);
    }

    await request(app)
      .post('/api/public/submissions')
      .set('x-forwarded-for', ip)
      .send(validSubmission(widget.publicId))
      .expect(202);
  });

  it('does not rate-limit the config endpoint the widget needs to render', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);
    const ip = nextIp();

    for (let i = 0; i < 15; i += 1) {
      await request(app)
        .get(`/api/public/widgets/${widget.publicId}/config`)
        .set('x-forwarded-for', ip)
        .expect(200);
    }
  });
});
