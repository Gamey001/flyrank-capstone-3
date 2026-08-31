import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool, pool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import { createWidget, migrateOnce, registerTenant, resetDatabase, validSubmission } from './helpers.js';

const app = createApp();

beforeAll(migrateOnce);
beforeEach(resetDatabase);
afterAll(closePool);

describe('dashboard aggregation', () => {
  it('reports totals, a timeseries, per-widget counts and a geo breakdown', async () => {
    const tenant = await registerTenant(app);
    const newsletter = await createWidget(app, tenant, { name: 'Newsletter' });
    const contact = await createWidget(app, tenant, { name: 'Contact' });

    for (let i = 0; i < 3; i += 1) {
      await request(app)
        .post('/api/public/submissions')
        .send(validSubmission(newsletter.publicId, { data: { email: `a${i}@example.com`, consent: true } }))
        .expect(202);
    }
    await request(app).post('/api/public/submissions').send(validSubmission(contact.publicId)).expect(202);
    await request(app)
      .post('/api/public/submissions')
      .send(
        validSubmission(newsletter.publicId, {
          data: { email: 'bot@spam.test', consent: true, company_website: 'http://spam.example' },
        }),
      )
      .expect(202);

    // Give two rows a country so the geo breakdown has something to group on.
    await pool.query(
      `UPDATE submissions SET country = 'Germany', country_code = 'DE', geo_status = 'enriched', geo_provider = 'mock-a'
       WHERE id IN (SELECT id FROM submissions WHERE status = 'stored' LIMIT 2)`,
    );

    const response = await request(app).get('/api/dashboard/stats?days=7').set(...tenant.auth()).expect(200);

    expect(response.body.totals).toMatchObject({ submissions: 5, stored: 4, spam: 1, enriched: 2 });
    expect(response.body.timeseries).toHaveLength(1);
    expect(response.body.timeseries[0]).toMatchObject({ stored: 4, spam: 1 });

    const byName = Object.fromEntries(
      response.body.widgets.map((row: { name: string; stored: number }) => [row.name, row.stored]),
    );
    expect(byName).toEqual({ Newsletter: 3, Contact: 1 });

    expect(response.body.geo).toEqual(
      expect.arrayContaining([{ countryCode: 'DE', country: 'Germany', submissions: 2 }]),
    );
  });

  it('includes a widget with no submissions yet, rather than omitting it', async () => {
    const tenant = await registerTenant(app);
    await createWidget(app, tenant, { name: 'Brand new' });

    const response = await request(app).get('/api/dashboard/stats').set(...tenant.auth()).expect(200);
    expect(response.body.widgets).toEqual([
      expect.objectContaining({ name: 'Brand new', stored: 0, spam: 0, lastSubmissionAt: null }),
    ]);
  });

  it('supports hourly granularity', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);
    await request(app).post('/api/public/submissions').send(validSubmission(widget.publicId)).expect(202);

    const response = await request(app)
      .get('/api/dashboard/stats?days=1&granularity=hour')
      .set(...tenant.auth())
      .expect(200);
    expect(response.body.window.granularity).toBe('hour');
    expect(response.body.timeseries).toHaveLength(1);
  });

  it('rejects nonsense query parameters instead of guessing', async () => {
    const tenant = await registerTenant(app);
    await request(app).get('/api/dashboard/stats?days=0').set(...tenant.auth()).expect(422);
    await request(app).get('/api/dashboard/stats?granularity=century').set(...tenant.auth()).expect(422);
    await request(app)
      .get('/api/dashboard/submissions?from=2026-02-01&to=2026-01-01')
      .set(...tenant.auth())
      .expect(422);
    await request(app).get('/api/dashboard/submissions?limit=9999').set(...tenant.auth()).expect(422);
  });

  it('paginates and filters submissions', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/public/submissions')
        .send(validSubmission(widget.publicId, { data: { email: `p${i}@example.com`, consent: true } }))
        .expect(202);
    }

    const page = await request(app)
      .get('/api/dashboard/submissions?limit=2&offset=0')
      .set(...tenant.auth())
      .expect(200);
    expect(page.body.submissions).toHaveLength(2);
    expect(page.body.pagination).toEqual({ total: 5, limit: 2, offset: 0 });

    const filtered = await request(app)
      .get(`/api/dashboard/submissions?widgetId=${widget.id}&status=stored`)
      .set(...tenant.auth())
      .expect(200);
    expect(filtered.body.pagination.total).toBe(5);
  });

  it('never caches a dashboard response in a shared cache', async () => {
    const tenant = await registerTenant(app);
    const response = await request(app).get('/api/dashboard/stats').set(...tenant.auth()).expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
});

describe('service surface', () => {
  it('answers liveness and readiness', async () => {
    await request(app).get('/healthz').expect(200);
    const ready = await request(app).get('/readyz').expect(200);
    expect(ready.body).toMatchObject({ status: 'ready', database: 'ok' });
  });

  it('returns a JSON 404 for an unknown route, not an HTML error page', async () => {
    const response = await request(app).get('/no/such/route').expect(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.error.code).toBe('not_found');
  });
});
