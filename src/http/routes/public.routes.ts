import { Router, type Request, type Response } from 'express';
import { env } from '../../config/env.js';
import { submissionsService } from '../../services/submissions.service.js';
import { widgetsService } from '../../services/widgets.service.js';
import { widgetAsset } from '../../services/widget-asset.service.js';
import { publicCors } from '../middleware/cors.js';
import { submissionIpRateLimit, submissionWidgetRateLimit } from '../middleware/rate-limit.js';
import { validate } from '../middleware/validate.js';
import { publicWidgetIdParam, submissionSchema } from '../validators/submission.validators.js';

/**
 * Everything on this router is reachable by the entire internet: no auth, any
 * origin, and the caller is assumed hostile until validated.
 */
export const publicRoutes = Router();

// CORS first — a preflight must be answered even for a request that will later
// be rejected, otherwise the browser reports a CORS error instead of the real
// 4xx and the developer on the other side has no idea what went wrong.
publicRoutes.use(publicCors);

const CONFIG_MAX_AGE_SECONDS = 60;
const BUNDLE_MAX_AGE_SECONDS = 31_536_000; // one year

const clientIp = (req: Request): string | null => req.ip ?? req.socket.remoteAddress ?? null;

const header = (req: Request, name: string, maxLength = 512): string | null => {
  const value = req.header(name);
  return value ? value.slice(0, maxLength) : null;
};

/**
 * The versioned widget bundle.
 *
 * The version in the path is a hash of the file, so this response is immutable:
 * a browser or CDN may keep it for a year and can never serve stale code,
 * because changed code lives at a different URL.
 */
publicRoutes.get('/embed/:version/widget.js', (req, res) => {
  if (req.params.version !== widgetAsset.version) {
    // An old or forged version string. Redirect rather than 404 so a customer
    // who cached the snippet itself keeps working after a release.
    res.setHeader('cache-control', 'public, max-age=300');
    res.redirect(302, `${widgetAsset.versionedPath}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
    return;
  }
  sendBundle(res, `public, max-age=${BUNDLE_MAX_AGE_SECONDS}, immutable`);
});

/**
 * Unversioned convenience URL. Same bytes, but only cacheable for five minutes
 * because this path's content *does* change on release.
 */
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

/**
 * Widget configuration for the browser.
 *
 * Short max-age plus an ETag: a config change is picked up within a minute,
 * and the revalidation after that costs a 304 rather than the payload.
 */
publicRoutes.get(
  '/api/public/widgets/:publicId/config',
  validate('params', publicWidgetIdParam),
  async (req, res) => {
    const { config, etag } = await widgetsService.publicConfig(req.params.publicId as string);

    res.setHeader('cache-control', `public, max-age=${CONFIG_MAX_AGE_SECONDS}, stale-while-revalidate=300`);
    res.setHeader('etag', etag);
    // Caches must key on Origin: the CORS response headers vary with it.
    res.setHeader('vary', 'Origin');

    if (req.header('if-none-match') === etag) {
      res.status(304).end();
      return;
    }
    res.json(config);
  },
);

/**
 * The public submission endpoint — the hardened path.
 *
 * Middleware order is the design: parse and size-check, then cheap in-memory
 * rate limits, then schema validation, and only then anything that touches the
 * database or a third party. Work is spent in increasing order of cost, so a
 * flood is rejected before it can be expensive.
 */
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

    // Never cache a submission response, and never let a shared cache hold one.
    res.setHeader('cache-control', 'no-store');

    if (result.status === 'duplicate') {
      // Idempotent replay: same answer, no second row, flagged so a client can
      // tell the difference if it cares.
      res.setHeader('idempotent-replay', 'true');
      res.status(200).json({
        ok: true,
        id: result.submission?.id ?? null,
        message: result.message,
        duplicate: true,
      });
      return;
    }

    // 202: the row is committed, but the email and webhook it triggers have not
    // run yet — they are queued. Saying "created" would overstate it.
    res.status(202).json({
      ok: true,
      // Spam gets the same shape and the same status as a real submission. A
      // bot that can tell it was caught is a bot that can iterate.
      id: result.submission?.id ?? null,
      message: result.message,
    });
  },
);

/** Lets the test page (and a probe) confirm which bundle version is live. */
publicRoutes.get('/api/public/version', (_req, res) => {
  res.setHeader('cache-control', 'public, max-age=60');
  res.json({
    widgetVersion: widgetAsset.version,
    bundlePath: widgetAsset.versionedPath,
    bundleBytes: widgetAsset.byteLength,
    baseUrl: env.PUBLIC_BASE_URL,
  });
});
