import { pino } from 'pino';
import { env } from '../config/env.js';

export const logger = pino({
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  base: { service: 'widget-platform' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'password',
      'passwordHash',
      'password_hash',
      '*.password',
      '*.passwordHash',
      'JWT_SECRET',
      'SMTP_PASSWORD',
      'DATABASE_URL',
    ],
    censor: '[redacted]',
  },
  transport:
    env.isProduction || env.isTest
      ? undefined
      : { target: 'pino/file', options: { destination: 1 } },
});

export type Logger = typeof logger;
