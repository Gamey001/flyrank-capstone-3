import { Router, type Request, type Response } from 'express';
import { env } from '../../config/env.js';
import { submissionsService } from '../../services/submissions.service.js';
import { widgetsService } from '../../services/widgets.service.js';
import { widgetAsset } from '../../services/widget-asset.service.js';
import { publicCors } from '../middleware/cors.js';
import { submissionIpRateLimit, submissionWidgetRateLimit } from '../middleware/rate-limit.js';
import { validate } from '../middleware/validate.js';
import { publicWidgetIdParam, submissionSchema } from '../validators/submission.validators.js';

export const publicRoutes = Router();

// Before everything else: a request that will be rejected still needs a correct
// preflight, or the browser reports a CORS error instead of the real 4xx.
publicRoutes.use(publicCors);

const CONFIG_MAX_AGE_SECONDS = 60;
const BUNDLE_MAX_AGE_SECONDS = 31_536_000; // one year

const clientIp = (req: Request): string | null => req.ip ?? req.socket.remoteAddress ?? null;

const header = (req: Request, name: string, maxLength = 512): string | null => {
  const value = req.header(name);
  return value ? value.slice(0, maxLength) : null;
};

// Safe to cache for a year because the version in the path is a hash of the
// file: changed code necessarily lands at a different URL.
publicRoutes.get('/embed/:version/widget.js', (req, res) => {
  if (req.params.version !== widgetAsset.version) {
    // Redirect rather than 404, so a customer who cached the snippet itself
    // keeps working across a release.
    res.setHeader('cache-control', 'public, max-age=300');
    res.redirect(302, `${widgetAsset.versionedPath}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
    return;
  }
  sendBundle(res, `public, max-age=${BUNDLE_MAX_AGE_SECONDS}, immutable`);
});

// Same bytes, short cache: unlike the versioned path, this URL's content
// changes on release.
publicRoutes.get('/widget.js', (_req, res) => {
  sendBundle(res, 'public, max-age=300, stale-while-revalidate=600');
});

function sendBundle(res: Response, cacheControl: string): void {
  res.setHeader('content-type', 'application/javascript; charset=utf-8');
  res.setHeader('cache-control', cacheControl);
  res.setHeader('etag', widgetAsset.etag);
  res.setHeader('x-widget-version', widgetAsset.version);
  res.send(widgetAsset.source);
}

publicRoutes.get(
  '/api/public/widgets/:publicId/config',
  validate('params', publicWidgetIdParam),
  async (req, res) => {
    const { config, etag } = await widgetsService.publicConfig(req.params.publicId as string);

    res.setHeader('cache-control', `public, max-age=${CONFIG_MAX_AGE_SECONDS}, stale-while-revalidate=300`);
    res.setHeader('etag', etag);
    // The CORS response headers vary with Origin, so caches must key on it.
    res.setHeader('vary', 'Origin');

    if (req.header('if-none-match') === etag) {
      res.status(304).end();
      return;
    }
    res.json(config);
  },
);

// Middleware order is the design: cheap in-memory rate limits, then schema
// validation, and only then anything touching the database or a third party —
// so a flood is rejected before it becomes expensive.
publicRoutes.post(
  '/api/public/submissions',
  submissionIpRateLimit,
  submissionWidgetRateLimit,
  validate('body', submissionSchema),
  async (req, res) => {
    const idempotencyKey = header(req, 'idempotency-key', 200);

    const result = await submissionsService.submit({
      widgetPublicId: req.body.widgetId,
      data: req.body.data,
      elapsedMs: req.body.elapsedMs,
      pageUrl: req.body.pageUrl,
      idempotencyKey,
      context: {
        ip: clientIp(req),
        userAgent: header(req, 'user-agent', 512),
        origin: header(req, 'origin', 255),
        referer: header(req, 'referer', 2048),
      },
    });

    res.setHeader('cache-control', 'no-store');

    if (result.status === 'duplicate') {
      res.setHeader('idempotent-replay', 'true');
      res.status(200).json({
        ok: true,
        id: result.submission?.id ?? null,
        message: result.message,
        duplicate: true,
      });
      return;
    }

    // 202, not 201: the row is committed but its email and webhook are only
    // queued. Spam reaches here too, with an identical status and shape — a bot
    // that can detect it was filtered is a bot that can iterate.
    res.status(202).json({
      ok: true,
      id: result.submission?.id ?? null,
      message: result.message,
    });
  },
);

publicRoutes.get('/api/public/version', (_req, res) => {
  res.setHeader('cache-control', 'public, max-age=60');
  res.json({
    widgetVersion: widgetAsset.version,
    bundlePath: widgetAsset.versionedPath,
    bundleBytes: widgetAsset.byteLength,
    baseUrl: env.PUBLIC_BASE_URL,
  });
});
