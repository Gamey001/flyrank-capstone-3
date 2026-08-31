import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { Tenant } from '../domain/models.js';
import { AppError } from '../lib/errors.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { tenantsRepository } from '../repositories/tenants.repository.js';

export interface AuthTokenPayload {
  sub: string;
  email: string;
}

export interface AuthResult {
  tenant: Tenant;
  token: string;
  expiresIn: number;
}

const ISSUER = 'flyrank-widget-platform';

const issueToken = (tenant: Tenant): string =>
  jwt.sign({ sub: tenant.id, email: tenant.email }, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_TTL_SECONDS,
    issuer: ISSUER,
  });

export const authService = {
  async register(input: { email: string; name: string; password: string }): Promise<AuthResult> {
    const existing = await tenantsRepository.findByEmail(input.email);
    if (existing) throw AppError.conflict('An account with that email already exists');

    const tenant = await tenantsRepository.create({
      email: input.email.toLowerCase(),
      name: input.name,
      passwordHash: await hashPassword(input.password),
    });

    return { tenant, token: issueToken(tenant), expiresIn: env.JWT_TTL_SECONDS };
  },

  async login(input: { email: string; password: string }): Promise<AuthResult> {
    const tenant = await tenantsRepository.findByEmail(input.email);

    // The discarded hash is deliberate: without it an unknown email returns
    // measurably faster than a wrong password, and login becomes an
    // account-enumeration oracle.
    if (!tenant) {
      await hashPassword(input.password);
      throw AppError.unauthorized('Invalid email or password');
    }

    const valid = await verifyPassword(input.password, tenant.passwordHash);
    if (!valid) throw AppError.unauthorized('Invalid email or password');

    const { passwordHash: _passwordHash, ...safe } = tenant;
    return { tenant: safe, token: issueToken(safe), expiresIn: env.JWT_TTL_SECONDS };
  },

  verifyToken(token: string): AuthTokenPayload {
    try {
      // Pinning `algorithms` is what rejects a token signed with "none".
      const payload = jwt.verify(token, env.JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: ISSUER,
      }) as jwt.JwtPayload;

      if (typeof payload.sub !== 'string') throw new Error('token has no subject');
      return { sub: payload.sub, email: String(payload.email ?? '') };
    } catch (error) {
      throw AppError.unauthorized(
        error instanceof jwt.TokenExpiredError ? 'Token expired' : 'Invalid or malformed token',
      );
    }
  },
};
