from datetime import datetime
from typing import Any

import asyncpg

from app.db import pool
from app.domain.models import Job
from app.repositories.mappers import to_job

_COLUMNS = "id, type, payload, status, attempts, max_attempts, run_at, last_error, created_at"


# Callers pass the transaction connection that stores the row this job refers to,
# so the two commit together or not at all.
async def enqueue(
    *,
    type: str,
    payload: dict[str, Any],
    max_attempts: int | None = None,
    run_at: datetime | None = None,
    conn: asyncpg.Connection | None = None,
) -> Job:
    row = await pool.fetchrow(
        f"""INSERT INTO jobs (type, payload, max_attempts, run_at)
            VALUES ($1, $2::jsonb, COALESCE($3, 5), COALESCE($4, now()))
            RETURNING {_COLUMNS}""",
        type,
        payload,
        max_attempts,
        run_at,
        conn=conn,
    )
    return to_job(row)


# Select and claim in one statement, so there is no window in which a job is
# selected but not yet marked running. SKIP LOCKED lets concurrent workers take
# disjoint batches instead of blocking on each other.
async def claim_batch(limit: int, *, conn: asyncpg.Connection | None = None) -> list[Job]:
    rows = await pool.fetch(
        f"""
        UPDATE jobs
           SET status = 'running', attempts = attempts + 1, locked_at = now()
         WHERE id IN (
           SELECT id FROM jobs
            WHERE status = 'pending' AND run_at <= now()
            ORDER BY run_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
        RETURNING {_COLUMNS}
        """,
        limit,
        conn=conn,
    )
    return [to_job(r) for r in rows]


async def mark_succeeded(job_id: str, *, conn: asyncpg.Connection | None = None) -> None:
    await pool.execute(
        "UPDATE jobs SET status = 'succeeded', locked_at = NULL, last_error = NULL "
        "WHERE id = $1::uuid",
        job_id,
        conn=conn,
    )


async def mark_failed(
    job_id: str,
    error: str,
    *,
    retry_in_seconds: int | None,
    conn: asyncpg.Connection | None = None,
) -> None:
    if retry_in_seconds is None:
        await pool.execute(
            "UPDATE jobs SET status = 'dead', locked_at = NULL, last_error = $2 "
            "WHERE id = $1::uuid",
            job_id,
            error[:2000],
            conn=conn,
        )
        return
    await pool.execute(
        """UPDATE jobs
              SET status = 'pending', locked_at = NULL, last_error = $2,
                  run_at = now() + make_interval(secs => $3)
            WHERE id = $1::uuid""",
        job_id,
        error[:2000],
        float(retry_in_seconds),
        conn=conn,
    )


# Without this, a worker killed mid-job leaves its row claimed forever.
async def requeue_stale(older_than_seconds: int, *, conn: asyncpg.Connection | None = None) -> int:
    result = await pool.execute(
        """UPDATE jobs
              SET status = 'pending', locked_at = NULL,
                  last_error = COALESCE(last_error, 'worker died while running this job')
            WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1)""",
        float(older_than_seconds),
        conn=conn,
    )
    return int(result.rsplit(" ", 1)[-1])


async def counts(*, conn: asyncpg.Connection | None = None) -> dict[str, int]:
    rows = await pool.fetch(
        "SELECT status::text AS status, count(*) AS count FROM jobs GROUP BY status", conn=conn
    )
    return {r["status"]: int(r["count"]) for r in rows}


async def find_by_id(job_id: str, *, conn: asyncpg.Connection | None = None) -> Job | None:
    row = await pool.fetchrow(f"SELECT {_COLUMNS} FROM jobs WHERE id = $1::uuid", job_id, conn=conn)
    return to_job(row) if row else None
