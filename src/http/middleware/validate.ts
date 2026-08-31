import type { RequestHandler } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { AppError } from '../../lib/errors.js';

type Target = 'body' | 'query' | 'params';

// Replaces `req[target]` with the parsed value, so a handler downstream cannot
// reach the unvalidated version by accident.
export const validate =
  (target: Target, schema: ZodTypeAny): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req[target]);

    if (!result.success) {
      next(
        AppError.unprocessable(
          `Invalid request ${target}`,
          result.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        ),
      );
      return;
    }

    if (target === 'query') {
      // req.query is getter-only in Express 5, so the parsed value is stashed
      // alongside it rather than assigned over it.
      Object.defineProperty(req, 'validatedQuery', { value: result.data, writable: true, configurable: true });
    } else {
      req[target] = result.data as never;
    }
    next();
  };

// Reads what `validate('query', …)` stashed, typed by the same schema.
export const validatedQuery = <T extends ZodTypeAny>(req: unknown, _schema: T): z.infer<T> =>
  (req as { validatedQuery: z.infer<T> }).validatedQuery;
