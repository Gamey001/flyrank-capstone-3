import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { closePool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import { createWidget, migrateOnce, registerTenant, resetDatabase, validSubmission } from './helpers.js';

const app = createApp();

beforeAll(migrateOnce);
beforeEach(resetDatabase);
afterAll(closePool);

describe('authentication', () => {
  it('rejects an unauthenticated request to the widget API', async () => {
    const response = await request(app).get('/api/widgets').expect(401);
    expect(response.body.error.code).toBe('unauthorized');
  });

  it('rejects a token signed with the wrong secret', async () => {
    await request(app).get('/api/widgets').set('authorization', 'Bearer not.a.real.token').expect(401);
  });

  it('registers, then logs in with the same credentials', async () => {
    const email = `login-${Date.now()}@example.test`;
    await request(app)
      .post('/api/auth/register')
      .send({ email, name: 'Acme', password: 'a-sufficiently-long-password' })
      .expect(201);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'a-sufficiently-long-password' })
      .expect(200);

    expect(login.body.token).toEqual(expect.any(String));
    // The hash must never leave the service.
    expect(JSON.stringify(login.body)).not.toContain('scrypt');
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.test', password: 'a-sufficiently-long-password' })
      .expect(401);

    const tenant = await registerTenant(app);
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: tenant.email, password: 'definitely-the-wrong-one' })
      .expect(401);

    // Identical responses: the endpoint must not reveal which emails exist.
    expect(unknown.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it('refuses to register the same email twice', async () => {
    const tenant = await registerTenant(app);
    await request(app)
      .post('/api/auth/register')
      .send({ email: tenant.email.toUpperCase(), name: 'Copy', password: 'a-sufficiently-long-password' })
      .expect(409);
  });
});

describe('multi-tenant isolation', () => {
  it('hides another tenant’s widget from read, update and delete', async () => {
    const alice = await registerTenant(app, 'Alice Ltd');
    const bob = await registerTenant(app, 'Bob GmbH');
    const widget = await createWidget(app, alice);

    await request(app).get(`/api/widgets/${widget.id}`).set(...bob.auth()).expect(404);
    await request(app)
      .patch(`/api/widgets/${widget.id}`)
      .set(...bob.auth())
      .send({ title: 'taken over' })
      .expect(404);
    await request(app).delete(`/api/widgets/${widget.id}`).set(...bob.auth()).expect(404);

    // …and the widget is untouched.
    const owner = await request(app).get(`/api/widgets/${widget.id}`).set(...alice.auth()).expect(200);
    expect(owner.body.widget.title).toBe('Join the list');
  });

  it('never lists another tenant’s widgets', async () => {
    const alice = await registerTenant(app);
    const bob = await registerTenant(app);
    await createWidget(app, alice);

    const bobList = await request(app).get('/api/widgets').set(...bob.auth()).expect(200);
    expect(bobList.body.widgets).toHaveLength(0);
    expect(bobList.body.pagination.total).toBe(0);
  });

  it('never exposes another tenant’s submissions', async () => {
    const alice = await registerTenant(app);
    const bob = await registerTenant(app);
    const widget = await createWidget(app, alice);

    await request(app).post('/api/public/submissions').send(validSubmission(widget.publicId)).expect(202);

    const bobSubmissions = await request(app)
      .get('/api/dashboard/submissions')
      .set(...bob.auth())
      .expect(200);
    expect(bobSubmissions.body.submissions).toHaveLength(0);

    // Even filtering explicitly by Alice's widget id is a 404, not an empty page.
    await request(app)
      .get(`/api/dashboard/submissions?widgetId=${widget.id}`)
      .set(...bob.auth())
      .expect(404);

    const aliceSubmissions = await request(app)
      .get('/api/dashboard/submissions')
      .set(...alice.auth())
      .expect(200);
    expect(aliceSubmissions.body.submissions).toHaveLength(1);
  });
});
