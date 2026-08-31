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

  if (error instanceof ZodError) {
    return AppError.unprocessable(
      'Request failed validation',
      error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  const candidate = error as { type?: string; status?: number; statusCode?: number; message?: string };

  // body-parser's typed errors. Without these branches an oversized or
  // malformed body surfaces as a 500 rather than the 413/400 it should be.
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
      // A 5xx message stays in the log; the client gets a request id to quote.
      message: appError.expose ? appError.message : 'Internal server error',
      ...(appError.details !== undefined ? { details: appError.details } : {}),
      ...(typeof requestId === 'string' ? { requestId } : {}),
    },
  };

  // A partially written body cannot be replaced with JSON; ending it is all
  // that is left.
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(appError.status).json(body);
};
