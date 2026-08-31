import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`No route for ${req.method} ${req.path}`));
};

const normalise = (error: unknown): AppError => {
  if (error instanceof AppError) return error;

  // A schema that was validated outside a route validator.
  if (error instanceof ZodError) {
    return AppError.unprocessable(
      'Request failed validation',
      error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  const candidate = error as { type?: string; status?: number; statusCode?: number; message?: string };

  // body-parser rejections. Without this branch a body one byte over the limit,
  // or a stray trailing comma, would surface as a 500 — the exact thing
  // acceptance probe 2 checks for.
  if (candidate.type === 'entity.too.large') {
    return AppError.payloadTooLarge('Request body exceeds the maximum allowed size');
  }
  if (candidate.type === 'entity.parse.failed') {
    return AppError.badRequest('Request body is not valid JSON');
  }
  if (candidate.type === 'charset.unsupported' || candidate.type === 'encoding.unsupported') {
    return AppError.badRequest('Unsupported request body encoding');
  }

  const status = candidate.status ?? candidate.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new AppError(status, 'bad_request', candidate.message ?? 'Bad request');
  }

  return AppError.internal('Internal server error', error);
};

/**
 * The single place an error becomes a response.
 *
 * Two rules it exists to enforce: every error answers with the same JSON shape,
 * and a 5xx never echoes an internal message back to the caller — the details
 * go to the log, the client gets the request id to quote.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const appError = normalise(error);
  const requestId = res.getHeader('x-request-id');

  if (appError.status >= 500) {
    logger.error({ err: error, requestId, path: req.path, method: req.method }, 'request failed');
  } else {
    logger.debug(
      { code: appError.code, status: appError.status, requestId, path: req.path },
      'request rejected',
    );
  }

  const body: ErrorBody = {
    error: {
      code: appError.code,
      message: appError.expose ? appError.message : 'Internal server error',
      ...(appError.details !== undefined ? { details: appError.details } : {}),
      ...(typeof requestId === 'string' ? { requestId } : {}),
    },
  };

  // A response can already be streaming (rare, but a partially written body
  // cannot be replaced with JSON) — the only safe move left is to end it.
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(appError.status).json(body);
};
