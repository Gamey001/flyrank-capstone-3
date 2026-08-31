/**
 * The per-widget limiter, isolated in its own file so it can be configured
 * independently of the per-IP one: the IP budget is opened wide and the widget
 * budget is tightened, which is the only way to observe one without the other.
 */
process.env.RATE_LIMIT_IP_MAX = '100000';
process.env.RATE_LIMIT_WIDGET_MAX = '3';
process.env.RATE_LIMIT_WIDGET_WINDOW_SECONDS = '60';
process.env.TRUST_PROXY_HOPS = '1';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

const { closePool } = await import('../src/db/pool.js');
const { createApp } = await import('../src/http/app.js');
const { createWidget, migrateOnce, registerTenant, resetDatabase, validSubmission } = await import('./helpers.js');

const app = createApp();

let visitorIp = 0;
const nextIp = (): string => `198.51.100.${(visitorIp += 1)}`;

beforeAll(migrateOnce);
beforeEach(resetDatabase);
afterAll(closePool);

describe('per-widget rate limiting', () => {
  it('caps a distributed flood against one widget without touching another', async () => {
    const tenant = await registerTenant(app);
    const busy = await createWidget(app, tenant, { name: 'Busy' });
    const quiet = await createWidget(app, tenant, { name: 'Quiet' });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      // Every request from a different IP, so the per-IP limiter cannot be the
      // thing that catches this — only the per-widget budget can.
      const response = await request(app)
        .post('/api/public/submissions')
        .set('x-forwarded-for', nextIp())
        .send(validSubmission(busy.publicId));
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 3)).toEqual([202, 202, 202]);
    expect(statuses.slice(3).every((status) => status === 429)).toBe(true);

    const limited = await request(app)
      .post('/api/public/submissions')
      .set('x-forwarded-for', nextIp())
      .send(validSubmission(busy.publicId))
      .expect(429);
    expect(limited.body.error.scope).toBe('widget');

    // A different widget has its own budget — one customer's traffic spike must
    // not silence another customer's form.
    await request(app)
      .post('/api/public/submissions')
      .set('x-forwarded-for', nextIp())
      .send(validSubmission(quiet.publicId))
      .expect(202);
  });
});
