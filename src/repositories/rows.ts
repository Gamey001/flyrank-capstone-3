import type { Job, Submission, Tenant, TenantWithSecret, Widget } from '../domain/models.js';

export interface TenantRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: Date;
}

export const toTenant = (row: TenantRow): Tenant => ({
  id: row.id,
  email: row.email,
  name: row.name,
  createdAt: row.created_at,
});

export const toTenantWithSecret = (row: TenantRow): TenantWithSecret => ({
  ...toTenant(row),
  passwordHash: row.password_hash,
});

export interface WidgetRow {
  id: string;
  tenant_id: string;
  public_id: string;
  name: string;
  type: Widget['type'];
  status: Widget['status'];
  title: string;
  description: string | null;
  button_text: string;
  success_message: string;
  fields: Widget['fields'];
  display: Widget['display'];
  honeypot_field: string;
  allowed_origins: string[];
  webhook_url: string | null;
  notify_email: string | null;
  revision: number;
  created_at: Date;
  updated_at: Date;
}

export const toWidget = (row: WidgetRow): Widget => ({
  id: row.id,
  tenantId: row.tenant_id,
  publicId: row.public_id,
  name: row.name,
  type: row.type,
  status: row.status,
  title: row.title,
  description: row.description,
  buttonText: row.button_text,
  successMessage: row.success_message,
  fields: row.fields ?? [],
  display: row.display ?? {},
  honeypotField: row.honeypot_field,
  allowedOrigins: row.allowed_origins ?? [],
  webhookUrl: row.webhook_url,
  notifyEmail: row.notify_email,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface SubmissionRow {
  id: string;
  widget_id: string;
  tenant_id: string;
  status: Submission['status'];
  spam_reason: string | null;
  data: Record<string, unknown>;
  email: string | null;
  ip_address: string | null;
  user_agent: string | null;
  origin: string | null;
  referer: string | null;
  page_url: string | null;
  geo_provider: string | null;
  geo_status: string;
  country: string | null;
  country_code: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  idempotency_key: string | null;
  created_at: Date;
}

export const toSubmission = (row: SubmissionRow): Submission => ({
  id: row.id,
  widgetId: row.widget_id,
  tenantId: row.tenant_id,
  status: row.status,
  spamReason: row.spam_reason,
  data: row.data,
  email: row.email,
  ipAddress: row.ip_address,
  userAgent: row.user_agent,
  origin: row.origin,
  referer: row.referer,
  pageUrl: row.page_url,
  geoProvider: row.geo_provider,
  geoStatus: row.geo_status,
  country: row.country,
  countryCode: row.country_code,
  region: row.region,
  city: row.city,
  latitude: row.latitude,
  longitude: row.longitude,
  idempotencyKey: row.idempotency_key,
  createdAt: row.created_at,
});

export interface JobRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: Job['status'];
  attempts: number;
  max_attempts: number;
  run_at: Date;
  last_error: string | null;
  created_at: Date;
}

export const toJob = <T extends Record<string, unknown>>(row: JobRow): Job<T> => ({
  id: row.id,
  type: row.type,
  payload: row.payload as T,
  status: row.status,
  attempts: row.attempts,
  maxAttempts: row.max_attempts,
  runAt: row.run_at,
  lastError: row.last_error,
  createdAt: row.created_at,
});
