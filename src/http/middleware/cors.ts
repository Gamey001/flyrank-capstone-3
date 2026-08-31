import cors, { type CorsOptions } from 'cors';
import type { RequestHandler } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

// Two policies on purpose. The public widget endpoints must accept any origin —
// an allow-list would mean a deploy every time a customer installs the widget on
// a new domain — so they carry no credentials, and per-widget origin rules live
// in the submission service instead. The admin API is the opposite.

const PUBLIC_HEADERS = ['content-type', 'accept', 'idempotency-key', 'x-request-id'];

const publicOptions: CorsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: PUBLIC_HEADERS,
  exposedHeaders: ['x-request-id', 'retry-after', 'ratelimit-remaining', 'ratelimit-reset'],
  credentials: false,
  // Without a max-age the browser re-preflights before every submission.
  maxAge: 86_400,
  optionsSuccessStatus: 204,
};

const adminOptions: CorsOptions = {
  origin(origin, callback) {
    // No Origin means a non-browser client. CORS is a browser mechanism and
    // enforcing it here would protect nothing — auth is the real gate.
    if (!origin) return callback(null, true);
    if (env.ADMIN_CORS_ORIGINS.includes(origin)) return callback(null, true);
    // AppError rather than Error, or the rejection surfaces as an opaque 500.
    return callback(AppError.forbidden(`Origin ${origin} is not allowed to call the admin API`));
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['content-type', 'accept', 'authorization', 'x-request-id'],
  exposedHeaders: ['x-request-id'],
  credentials: true,
  maxAge: 600,
  optionsSuccessStatus: 204,
};

export const publicCors: RequestHandler = cors(publicOptions);
export const adminCors: RequestHandler = cors(adminOptions);
