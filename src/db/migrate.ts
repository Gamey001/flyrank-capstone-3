import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, pool } from './pool.js';
import { logger } from '../lib/logger.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// Any Postgres advisory-lock key works as long as every deploy uses the same
// one. It stops two containers booting at once from applying a migration twice.
const ADVISORY_LOCK_KEY = 8_147_226_301;

const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

export const runMigrations = async (): Promise<{ applied: string[] }> => {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((row) => [row.name, row.checksum]));

    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const hash = checksum(sql);
      const previous = done.get(file);

      if (previous !== undefined) {
        // An edited migration means the database and the repo disagree about
        // what the schema is. Fail loudly instead of guessing.
        if (previous !== hash) {
          throw new Error(
            `Migration ${file} has changed since it was applied. Add a new migration instead of editing history.`,
          );
        }
        continue;
      }

      // Each migration is its own transaction: a failure leaves every earlier
      // migration applied and this one fully rolled back.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, hash]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }

      applied.push(file);
      logger.info({ migration: file }, 'migration applied');
    }

    return { applied };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
};

// `npm run migrate` — also runnable as a library from server boot and tests.
const isDirectRun = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  try {
    const { applied } = await runMigrations();
    console.log(applied.length > 0 ? `Applied ${applied.length} migration(s): ${applied.join(', ')}` : 'Schema already up to date.');
    await closePool();
  } catch (error) {
    console.error(`Migration failed: ${(error as Error).message}`);
    await closePool();
    process.exit(1);
  }
}
