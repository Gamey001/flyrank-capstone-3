import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const { Pool, types } = pg;

// node-postgres hands back BIGINT/NUMERIC as strings to protect precision.
// Every one this app reads is a COUNT(*), which always fits a JS number.
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
  logger.error({ err: error }, 'idle postgres client error');
});

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export const withTransaction = async <T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Swallow a failing ROLLBACK: the original error is the useful one, and a
    // dead connection cannot roll back anyway.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export const closePool = async (): Promise<void> => {
  await pool.end();
};
