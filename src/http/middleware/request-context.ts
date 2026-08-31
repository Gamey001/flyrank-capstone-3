import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from '../../lib/logger.js';

/**
 * Gives every request an id, echoes it in a header, and puts it on every log
 * line for that request — so an error a customer reports ("requestId abc") can
 * be found in the log without guessing.
 */
export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const requestId = incoming && incoming.length <= 128 ? incoming : randomUUID();
  res.setHeader('x-request-id', requestId);
  next();
};

export const httpLogger = pinoHttp({
  logger,
  genReqId: (_req, res) => String(res.getHeader('x-request-id') ?? randomUUID()),
  // Health checks and the widget bundle are high-volume and uninteresting;
  // logging them at info drowns everything that matters.
  autoLogging: {
    ignore: (req) => req.url === '/healthz' || req.url === '/readyz',
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req: (req) => ({ method: req.method, url: req.url, remoteAddress: req.remoteAddress }),
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
