import 'dotenv/config';
import { z } from 'zod';

/**
 * Every environment variable the app reads is declared — and validated — here.
 * The process refuses to boot on a bad value rather than failing later in a
 * request. Secrets are read here and nowhere else.
 */

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  ADMIN_CORS_ORIGINS: z.string().default('http://localhost:3000').transform(csv),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TEST_DATABASE_URL: z.string().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_SECONDS: z.coerce.number().int().min(60).default(86_400),

  SUBMISSION_BODY_LIMIT_BYTES: z.coerce.number().int().min(256).max(1_048_576).default(16_384),
  RATE_LIMIT_IP_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_IP_MAX: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_WIDGET_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_WIDGET_MAX: z.coerce.number().int().min(1).default(60),
  SPAM_MIN_FILL_MS: z.coerce.number().int().min(0).default(1200),

  GEO_PROVIDERS: z.string().default('ip-api,ipapi-co').transform(csv),
  GEO_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(1500),
  GEO_FORCE_DOWN: z.string().default('').transform(csv),

  JOB_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  JOB_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  RUN_WORKER_IN_PROCESS: booleanish.default('true'),

  EMAIL_TRANSPORT: z.enum(['log', 'smtp', 'fail']).default('log'),
  EMAIL_FROM: z.string().default('FlyRank Widgets <no-reply@flyrank.local>'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  // Printed, not logged: the logger itself depends on this module.
  console.error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  process.exit(1);
}

const raw = parsed.data;

const isTest = raw.NODE_ENV === 'test';
const databaseUrl = isTest ? (raw.TEST_DATABASE_URL ?? raw.DATABASE_URL) : raw.DATABASE_URL;

export const env = {
  ...raw,
  DATABASE_URL: databaseUrl,
  isTest,
  isProduction: raw.NODE_ENV === 'production',
} as const;

export type Env = typeof env;
