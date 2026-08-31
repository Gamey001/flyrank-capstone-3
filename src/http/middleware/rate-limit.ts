import type { Request, RequestHandler, Response } from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

/**
 * Rate limiting for the public submission endpoint.
 *
 * Two independent limiters run in series, because they defend against two
 * different things: the per-IP limiter stops one machine flooding, and the
 * per-widget limiter caps the blast radius of a distributed flood against a
 * single customer's form. Either can trip; neither knows about the other.
 *
 * Both use the in-memory store, which is correct for a single instance. Running
 * several API replicas needs a shared store (Redis) or the effective limit
 * multiplies by the replica count — noted in the README's limitations.
 */

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
  // Preflights carry no payload and are cached by the browser; counting them
  // would spend a visitor's budget before they submitted anything.
  skip: (req) => req.method === 'OPTIONS',
});

export const submissionWidgetRateLimit: RequestHandler = rateLimit({
  ...base,
  windowMs: env.RATE_LIMIT_WIDGET_WINDOW_SECONDS * 1000,
  limit: env.RATE_LIMIT_WIDGET_MAX,
  handler: rejection('widget'),
  skip: (req) => req.method === 'OPTIONS',
  keyGenerator: (req) => {
    const body = req.body as { widgetId?: unknown } | undefined;
    const widgetId = typeof body?.widgetId === 'string' ? body.widgetId : null;
    // An unidentifiable request cannot exhaust a specific widget's budget, so
    // it falls back to the per-IP key and gets rejected by validation anyway.
    return widgetId ? `widget:${widgetId}` : `ip:${req.ip ?? 'unknown'}`;
  },
});

/**
 * A gentler limiter for the authenticated API. Login and register are the
 * endpoints worth brute-forcing, so they get their own tighter budget.
 */
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
