import type { RequestHandler } from 'express';
import { AppError } from '../../lib/errors.js';
import { authService } from '../../services/auth.service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireAuth`. Absent on every public route. */
      tenant?: { id: string; email: string };
    }
  }
}

/**
 * Bearer-token gate for the admin and dashboard APIs.
 *
 * It attaches the tenant id, and every downstream repository call takes that id
 * as a required argument — which is how multi-tenant isolation is enforced in
 * the query rather than in the handler.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.header('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) {
    throw AppError.unauthorized('Missing Bearer token');
  }

  const payload = authService.verifyToken(header.slice(7).trim());
  req.tenant = { id: payload.sub, email: payload.email };
  next();
};

/** Narrows `req.tenant` for handlers that run behind `requireAuth`. */
export const tenantId = (req: { tenant?: { id: string } }): string => {
  if (!req.tenant) throw AppError.unauthorized();
  return req.tenant.id;
};
