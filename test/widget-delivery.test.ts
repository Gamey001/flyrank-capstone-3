import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import { widgetAsset } from '../src/services/widget-asset.service.js';
import { createWidget, migrateOnce, registerTenant, resetDatabase } from './helpers.js';

const app = createApp();

beforeAll(migrateOnce);
beforeEach(resetDatabase);
afterAll(closePool);

describe('widget management', () => {
  it('creates a widget and returns a ready-to-paste embed snippet', async () => {
    const tenant = await registerTenant(app);
    const response = await request(app)
      .post('/api/widgets')
      .set(...tenant.auth())
      .send({
        name: 'Newsletter',
        type: 'signup_form',
        title: 'Join the list',
        fields: [{ name: 'email', label: 'Email', type: 'email', required: true }],
      })
      .expect(201);

    const { widget } = response.body;
    expect(widget.publicId).toMatch(/^[a-z0-9]{16}$/);
    expect(widget.embed.snippet).toBe(
      `<script src="${widget.embed.scriptUrl}" async></script>`,
    );
    expect(widget.embed.scriptUrl).toContain(`/embed/${widgetAsset.version}/widget.js?id=${widget.publicId}`);
  });

  it('rejects an invalid widget definition with a 422 and per-field messages', async () => {
    const tenant = await registerTenant(app);
    const response = await request(app)
      .post('/api/widgets')
      .set(...tenant.auth())
      .send({ name: '', type: 'not_a_type', title: 'x', fields: [] })
      .expect(422);

    expect(response.body.error.code).toBe('unprocessable_entity');
    expect(response.body.error.details.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(['name', 'type', 'fields']),
    );
  });

  it('rejects a honeypot name that collides with a real field', async () => {
    const tenant = await registerTenant(app);
    await request(app)
      .post('/api/widgets')
      .set(...tenant.auth())
      .send({
        name: 'Bad',
        type: 'signup_form',
        title: 'Bad',
        honeypotField: 'email',
        fields: [{ name: 'email', label: 'Email', type: 'email', required: true }],
      })
      .expect(422);
  });

  it('bumps the revision on update and soft-deletes on delete', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    const updated = await request(app)
      .patch(`/api/widgets/${widget.id}`)
      .set(...tenant.auth())
      .send({ title: 'New title' })
      .expect(200);
    expect(updated.body.widget.revision).toBe(2);
    expect(updated.body.widget.title).toBe('New title');

    await request(app).delete(`/api/widgets/${widget.id}`).set(...tenant.auth()).expect(204);
    await request(app).get(`/api/widgets/${widget.id}`).set(...tenant.auth()).expect(404);
    // A deleted widget stops serving publicly too.
    await request(app).get(`/api/public/widgets/${widget.publicId}/config`).expect(404);
  });
});

describe('widget delivery', () => {
  it('serves the versioned bundle as immutable, cacheable-forever JavaScript', async () => {
    const response = await request(app).get(`/embed/${widgetAsset.version}/widget.js`).expect(200);

    expect(response.headers['content-type']).toContain('application/javascript');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.headers['x-widget-version']).toBe(widgetAsset.version);
    expect(response.text).toContain('flyrank');
  });

  it('redirects an outdated bundle version to the current one, preserving ?id', async () => {
    const response = await request(app).get('/embed/v0000deadbeef/widget.js?id=abc123').expect(302);
    expect(response.headers.location).toBe(`${widgetAsset.versionedPath}?id=abc123`);
  });

  it('serves the unversioned bundle with a short cache instead of an immutable one', async () => {
    const response = await request(app).get('/widget.js').expect(200);
    expect(response.headers['cache-control']).toBe('public, max-age=300, stale-while-revalidate=600');
  });

  it('serves a small public config with cache headers and no tenant data', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant, {
      webhookUrl: 'https://example.com/hook',
      notifyEmail: 'leads@example.test',
    });

    const response = await request(app)
      .get(`/api/public/widgets/${widget.publicId}/config`)
      .set('origin', 'http://localhost:5500')
      .expect(200);

    expect(response.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(response.headers.etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers.vary).toBe('Origin');

    // The config is a projection, not the row: none of this may reach a page
    // on someone else's website.
    expect(response.body).not.toHaveProperty('tenantId');
    expect(response.body).not.toHaveProperty('webhookUrl');
    expect(response.body).not.toHaveProperty('notifyEmail');
    expect(response.body.honeypotField).toBe('company_website');
    // "Small payload" is a requirement, so it is asserted rather than assumed.
    expect(JSON.stringify(response.body).length).toBeLessThan(2048);
  });

  it('answers a conditional request with 304 and no body', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    const first = await request(app).get(`/api/public/widgets/${widget.publicId}/config`).expect(200);
    const revalidated = await request(app)
      .get(`/api/public/widgets/${widget.publicId}/config`)
      .set('if-none-match', first.headers.etag as string)
      .expect(304);
    expect(revalidated.text).toBe('');
  });

  it('changes the config ETag when the widget changes', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);

    const before = await request(app).get(`/api/public/widgets/${widget.publicId}/config`).expect(200);
    await request(app)
      .patch(`/api/widgets/${widget.id}`)
      .set(...tenant.auth())
      .send({ title: 'Changed' })
      .expect(200);
    const after = await request(app).get(`/api/public/widgets/${widget.publicId}/config`).expect(200);

    expect(after.headers.etag).not.toBe(before.headers.etag);
  });

  it('does not serve a paused widget publicly', async () => {
    const tenant = await registerTenant(app);
    const widget = await createWidget(app, tenant);
    await request(app)
      .patch(`/api/widgets/${widget.id}`)
      .set(...tenant.auth())
      .send({ status: 'paused' })
      .expect(200);

    await request(app).get(`/api/public/widgets/${widget.publicId}/config`).expect(404);
  });
});
