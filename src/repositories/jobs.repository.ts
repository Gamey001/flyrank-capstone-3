import { pool, type Queryable } from '../db/pool.js';
import type { Job } from '../domain/models.js';
import { toJob, type JobRow } from './rows.js';

const COLUMNS = 'id, type, payload, status, attempts, max_attempts, run_at, last_error, created_at';

export interface EnqueueJobInput {
  type: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
  runAt?: Date;
}

export const jobsRepository = {
  // Callers pass the transaction client that stores the row this job refers to,
  // so the two commit together or not at all.
  async enqueue(input: EnqueueJobInput, db: Queryable = pool): Promise<Job> {
    const { rows } = await db.query<JobRow>(
      `INSERT INTO jobs (type, payload, max_attempts, run_at)
       VALUES ($1, $2::jsonb, COALESCE($3, 5), COALESCE($4, now()))
       RETURNING ${COLUMNS}`,
      [input.type, JSON.stringify(input.payload), input.maxAttempts ?? null, input.runAt ?? null],
    );
    return toJob(rows[0]!);
  },

  // Select and claim in one statement, so there is no window in which a job is
  // selected but not yet marked running. SKIP LOCKED lets concurrent workers
  // take disjoint batches instead of blocking on each other.
  async claimBatch(limit: number, db: Queryable = pool): Promise<Job[]> {
    const { rows } = await db.query<JobRow>(
      `UPDATE jobs
          SET status = 'running', attempts = attempts + 1, locked_at = now()
        WHERE id IN (
          SELECT id FROM jobs
           WHERE status = 'pending' AND run_at <= now()
           ORDER BY run_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
      RETURNING ${COLUMNS}`,
      [limit],
    );
    return rows.map((row) => toJob(row));
  },

  async markSucceeded(id: string, db: Queryable = pool): Promise<void> {
    await db.query(`UPDATE jobs SET status = 'succeeded', locked_at = NULL, last_error = NULL WHERE id = $1`, [id]);
  },

  async markFailed(
    id: string,
    error: string,
    options: { retryInSeconds: number | null },
    db: Queryable = pool,
  ): Promise<void> {
    if (options.retryInSeconds === null) {
      await db.query(`UPDATE jobs SET status = 'dead', locked_at = NULL, last_error = $2 WHERE id = $1`, [
        id,
        error.slice(0, 2000),
      ]);
      return;
    }
    await db.query(
      `UPDATE jobs
          SET status = 'pending', locked_at = NULL, last_error = $2,
              run_at = now() + make_interval(secs => $3)
        WHERE id = $1`,
      [id, error.slice(0, 2000), options.retryInSeconds],
    );
  },

  // Without this, a worker killed mid-job leaves its row claimed forever.
  async requeueStale(olderThanSeconds: number, db: Queryable = pool): Promise<number> {
    const { rowCount } = await db.query(
      `UPDATE jobs
          SET status = 'pending', locked_at = NULL,
              last_error = COALESCE(last_error, 'worker died while running this job')
        WHERE status = 'running'
          AND locked_at < now() - make_interval(secs => $1)`,
      [olderThanSeconds],
    );
    return rowCount ?? 0;
  },

  async counts(db: Queryable = pool): Promise<Record<string, number>> {
    const { rows } = await db.query<{ status: string; count: number }>(
      'SELECT status::text AS status, count(*)::bigint AS count FROM jobs GROUP BY status',
    );
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  },

  async findById(id: string, db: Queryable = pool): Promise<Job | null> {
    const { rows } = await db.query<JobRow>(`SELECT ${COLUMNS} FROM jobs WHERE id = $1`, [id]);
    return rows[0] ? toJob(rows[0]) : null;
  },
};
