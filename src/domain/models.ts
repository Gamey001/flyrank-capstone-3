export type WidgetType = 'signup_form' | 'contact_form' | 'cta_popover';
export type WidgetStatus = 'active' | 'paused';
export type SubmissionStatus = 'stored' | 'spam';
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead';

export interface Tenant {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

export interface TenantWithSecret extends Tenant {
  passwordHash: string;
}

export interface WidgetField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'textarea' | 'select' | 'checkbox';
  required: boolean;
  placeholder?: string;
  options?: string[];
  maxLength?: number;
}

export interface WidgetDisplay {
  position?: 'inline' | 'bottom-right' | 'bottom-left';
  theme?: 'light' | 'dark';
  accentColor?: string;
  delaySeconds?: number;
}

export interface Widget {
  id: string;
  tenantId: string;
  publicId: string;
  name: string;
  type: WidgetType;
  status: WidgetStatus;
  title: string;
  description: string | null;
  buttonText: string;
  successMessage: string;
  fields: WidgetField[];
  display: WidgetDisplay;
  honeypotField: string;
  allowedOrigins: string[];
  webhookUrl: string | null;
  notifyEmail: string | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GeoResult {
  provider: string;
  status: 'enriched' | 'unavailable' | 'skipped';
  country?: string | null;
  countryCode?: string | null;
  region?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface Submission {
  id: string;
  widgetId: string;
  tenantId: string;
  status: SubmissionStatus;
  spamReason: string | null;
  data: Record<string, unknown>;
  email: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  origin: string | null;
  referer: string | null;
  pageUrl: string | null;
  geoProvider: string | null;
  geoStatus: string;
  country: string | null;
  countryCode: string | null;
  region: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  idempotencyKey: string | null;
  createdAt: Date;
}

export interface Job<TPayload = Record<string, unknown>> {
  id: string;
  type: string;
  payload: TPayload;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lastError: string | null;
  createdAt: Date;
}
