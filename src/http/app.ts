import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from '../config/env.js';
import { adminCors } from './middleware/cors.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { httpLogger, requestContext } from './middleware/request-context.js';
import { adminRateLimit } from './middleware/rate-limit.js';
import { authRoutes } from './routes/auth.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { healthRoutes } from './routes/health.routes.js';
import { publicRoutes } from './routes/public.routes.js';
import { widgetsRoutes } from './routes/widgets.routes.js';

/**
 * Builds the Express application.
 *
 * Kept separate from `server.ts` so tests can mount it with supertest without
 * binding a port, and so the HTTP layer stays a thin shell over the services.
 */
export const createApp = (): Express => {
  const app = express();

  // Express only honours X-Forwarded-For from hops it is told to trust.
  // Defaulting to 0 matters: trusting a header nobody strips lets any client
  // claim any IP and walk straight through the per-IP rate limit.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.set('etag', false); // caching is set explicitly per route, never guessed

  app.use(requestContext);
  app.use(httpLogger);

  app.use(
    helmet({
      // The widget bundle is a cross-origin script by definition; the default
      // CORP/COEP headers would stop customer pages loading it.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
      // This service returns JSON and one JS file — there is no HTML document
      // for a CSP to protect.
      contentSecurityPolicy: false,
    }),
  );

  // Size limit before parse: an oversized body is rejected by body-parser
  // rather than buffered, and the error handler turns that into a clean 413.
  app.use(
    express.json({
      limit: env.SUBMISSION_BODY_LIMIT_BYTES,
      // A JSON API should not silently accept a body labelled as something else.
      type: ['application/json', 'application/*+json'],
    }),
  );

  app.use(healthRoutes);

  // Public surface: any origin, no credentials, heavily validated.
  app.use(publicRoutes);

  // Authenticated surface: allow-listed origins only.
  app.use('/api/auth', adminCors, authRoutes);
  app.use('/api/widgets', adminCors, adminRateLimit, widgetsRoutes);
  app.use('/api/dashboard', adminCors, adminRateLimit, dashboardRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
