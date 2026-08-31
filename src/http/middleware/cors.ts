import cors, { type CorsOptions } from 'cors';
import type { RequestHandler } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';

/**
 * Two CORS policies, because there are two kinds of caller.
 *
 * The public widget endpoints are reachable from any website — that is the
 * product. Locking them to an allow-list would mean re-deploying every time a
 * customer installs the widget on a new domain, so they are open, they carry no
 * credentials, and per-widget origin rules are enforced in the submission
 * service where the widget's own allow-list lives.
 *
 * The admin/dashboard API is the opposite: a named allow-list, credentials on,
 * and an unknown origin is refused.
 */

const PUBLIC_HEADERS = ['content-type', 'accept', 'idempotency-key', 'x-request-id'];

const publicOptions: CorsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: PUBLIC_HEADERS,
  exposedHeaders: ['x-request-id', 'retry-after', 'ratelimit-remaining', 'ratelimit-reset'],
  credentials: false,
  // Cache the preflight for a day: without it the browser pays an extra
  // round trip before every submission.
  maxAge: 86_400,
  optionsSuccessStatus: 204,
};

const adminOptions: CorsOptions = {
  origin(origin, callback) {
    // No Origin header = a non-browser client (curl, a server). CORS is a
    // browser mechanism; there is nothing to protect against here.
    if (!origin) return callback(null, true);
    if (env.ADMIN_CORS_ORIGINS.includes(origin)) return callback(null, true);
    // An AppError rather than a bare Error, so the rejection surfaces as a
    // 403 with the usual JSON body instead of an opaque 500.
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
