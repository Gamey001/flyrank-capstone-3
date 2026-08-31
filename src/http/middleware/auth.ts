import type { RequestHandler } from 'express';
import { AppError } from '../../lib/errors.js';
import { authService } from '../../services/auth.service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Set by `requireAuth`; absent on every public route.
      tenant?: { id: string; email: string };
    }
  }
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.header('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) {
    throw AppError.unauthorized('Missing Bearer token');
  }

  const payload = authService.verifyToken(header.slice(7).trim());
  req.tenant = { id: payload.sub, email: payload.email };
  next();
};

export const tenantId = (req: { tenant?: { id: string } }): string => {
  if (!req.tenant) throw AppError.unauthorized();
  return req.tenant.id;
};
