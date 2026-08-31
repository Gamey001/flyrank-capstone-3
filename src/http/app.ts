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

// Separate from server.ts so tests can mount the app without binding a port.
export const createApp = (): Express => {
  const app = express();

  // Defaults to 0. Trusting X-Forwarded-For when no proxy strips it lets any
  // client claim any IP and walk straight through the per-IP rate limit.
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.disable('x-powered-by');
  app.set('etag', false); // every route sets its own caching explicitly

  app.use(requestContext);
  app.use(httpLogger);

  app.use(
    helmet({
      // The widget bundle is a cross-origin script by definition, so helmet's
      // default CORP/COEP would stop customer pages loading it.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
      // No HTML document is served, so there is nothing for a CSP to protect.
      contentSecurityPolicy: false,
    }),
  );

  // The limit is enforced during parsing, so an oversized body is rejected
  // rather than buffered; the error handler turns that into a 413.
  app.use(
    express.json({
      limit: env.SUBMISSION_BODY_LIMIT_BYTES,
      type: ['application/json', 'application/*+json'],
    }),
  );

  app.use(healthRoutes);
  app.use(publicRoutes);

  app.use('/api/auth', adminCors, authRoutes);
  app.use('/api/widgets', adminCors, adminRateLimit, widgetsRoutes);
  app.use('/api/dashboard', adminCors, adminRateLimit, dashboardRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
