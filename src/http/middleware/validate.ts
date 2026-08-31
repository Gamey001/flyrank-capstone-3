import type { RequestHandler } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { AppError } from '../../lib/errors.js';

type Target = 'body' | 'query' | 'params';

/**
 * Validation at the boundary (shared requirement #2).
 *
 * Nothing past this middleware sees raw request data: the parsed, typed value
 * replaces `req[target]`, so a handler cannot accidentally use the unvalidated
 * version. A schema failure is a 422 with per-field messages — never a 500 from
 * something downstream choking on an unexpected shape.
 */
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
      // Express 5 makes req.query a getter-only property, so the parsed value
      // is stashed alongside it rather than assigned over it.
      Object.defineProperty(req, 'validatedQuery', { value: result.data, writable: true, configurable: true });
    } else {
      req[target] = result.data as never;
    }
    next();
  };

/** Reads what `validate('query', …)` parsed, with the schema's own type. */
export const validatedQuery = <T extends ZodTypeAny>(req: unknown, _schema: T): z.infer<T> =>
  (req as { validatedQuery: z.infer<T> }).validatedQuery;
