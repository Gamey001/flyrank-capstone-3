import type { Request, RequestHandler, Response } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

// Two limiters in series for two threat models: per-IP stops one machine
// flooding, per-widget caps a distributed flood that shares no IP.
//
// The in-memory store is correct for one instance only — across several
// replicas the effective limit multiplies by the replica count.

const rejection =
  (scope: string) =>
  (req: Request, res: Response): void => {
    const retryAfter = res.getHeader('retry-after');
    logger.warn({ scope, ip: req.ip, path: req.path }, 'rate limit exceeded');
    res.status(429).json({
      error: {
        code: 'too_many_requests',
        message: 'Too many submissions from this source. Please slow down and try again shortly.',
        scope,
        ...(retryAfter !== undefined ? { retryAfterSeconds: Number(retryAfter) } : {}),
        requestId: res.getHeader('x-request-id'),
      },
    });
  };

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
} satisfies Partial<Options>;

export const submissionIpRateLimit: RequestHandler = rateLimit({
  ...base,
  windowMs: env.RATE_LIMIT_IP_WINDOW_SECONDS * 1000,
  limit: env.RATE_LIMIT_IP_MAX,
  handler: rejection('ip'),
  // Counting preflights would spend a visitor's budget before they submitted.
  skip: (req) => req.method === 'OPTIONS',
});

export const submissionWidgetRateLimit: RequestHandler = rateLimit({
  ...base,
  windowMs: env.RATE_LIMIT_WIDGET_WINDOW_SECONDS * 1000,
  limit: env.RATE_LIMIT_WIDGET_MAX,
  handler: rejection('widget'),
  skip: (req) => req.method === 'OPTIONS',
  // Runs after the body parser but before validation, so widgetId is present
  // but untrusted; an unusable one falls back to an IP key and is rejected by
  // the schema a moment later.
  keyGenerator: (req) => {
    const body = req.body as { widgetId?: unknown } | undefined;
    const widgetId = typeof body?.widgetId === 'string' ? body.widgetId : null;
    return widgetId ? `widget:${widgetId}` : `ip:${req.ip ?? 'unknown'}`;
  },
});

export const authRateLimit: RequestHandler = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: env.isTest ? 1_000 : 20,
  handler: rejection('auth'),
});

export const adminRateLimit: RequestHandler = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: env.isTest ? 10_000 : 300,
  handler: rejection('admin'),
});

export const tooManyRequests = (): AppError => AppError.tooManyRequests();
