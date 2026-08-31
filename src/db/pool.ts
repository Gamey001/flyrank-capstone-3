import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool, types } = pg;

// node-postgres returns BIGINT/NUMERIC as strings to avoid precision loss.
// Every bigint this app reads is a COUNT(*), which is always safe in a JS
// number, so parse them here instead of at each call site.
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));
types.setTypeParser(types.builtins.NUMERIC, (value) => Number.parseFloat(value));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'flyrank-widget-platform',
});

pool.on('error', (error) => {
  // An idle client died (database restarted, network blip). The pool discards
  // it on its own; surface it so it is not silent.
  logger.error({ err: error }, 'idle postgres client error');
});

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/**
 * Runs `fn` inside a single transaction and always returns the client to the
 * pool. Used wherever a submission and its outbox job must be stored together.
 */
export const withTransaction = async <T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export const closePool = async (): Promise<void> => {
  await pool.end();
};
