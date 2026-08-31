import type { Express } from 'express';
import request from 'supertest';
import { pool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';

// These run against the real Postgres from docker-compose: unique indexes,
// transactions and tenant filters are the behaviours under test, and none of
// them exist in a mock.

export const migrateOnce = async (): Promise<void> => {
  await runMigrations();
};

// CASCADE from tenants reaches widgets and submissions; jobs stand alone.
export const resetDatabase = async (): Promise<void> => {
  await pool.query('TRUNCATE tenants, jobs RESTART IDENTITY CASCADE');
};

export interface TestTenant {
  token: string;
  tenantId: string;
  email: string;
  auth: () => [string, string];
}

let sequence = 0;

export const registerTenant = async (app: Express, name = 'Test Co'): Promise<TestTenant> => {
  sequence += 1;
  const email = `tenant-${Date.now()}-${sequence}@example.test`;
  const response = await request(app)
    .post('/api/auth/register')
    .send({ email, name, password: 'a-sufficiently-long-password' })
    .expect(201);

  return {
    token: response.body.token,
    tenantId: response.body.tenant.id,
    email,
    auth: () => ['authorization', `Bearer ${response.body.token}`],
  };
};

export const widgetPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Newsletter',
  type: 'signup_form',
  title: 'Join the list',
  fields: [
    { name: 'email', label: 'Email', type: 'email', required: true },
    { name: 'consent', label: 'I agree', type: 'checkbox', required: true },
  ],
  ...overrides,
});

export const createWidget = async (
  app: Express,
  tenant: TestTenant,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; publicId: string; body: Record<string, never> }> => {
  const response = await request(app)
    .post('/api/widgets')
    .set(...tenant.auth())
    .send(widgetPayload(overrides))
    .expect(201);
  return { id: response.body.widget.id, publicId: response.body.widget.publicId, body: response.body.widget };
};

export const validSubmission = (publicId: string, overrides: Record<string, unknown> = {}) => ({
  widgetId: publicId,
  data: { email: 'visitor@example.com', consent: true },
  ...overrides,
});
