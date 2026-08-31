from datetime import datetime
from typing import Any

import asyncpg

from app.db import pool


async def totals(
    tenant_id: str, since: datetime, *, conn: asyncpg.Connection | None = None
) -> dict[str, int]:
    row = await pool.fetchrow(
        """
        SELECT count(*)                                            AS total,
               count(*) FILTER (WHERE status = 'stored')           AS stored,
               count(*) FILTER (WHERE status = 'spam')             AS spam,
               count(*) FILTER (WHERE geo_status = 'enriched')     AS enriched,
               count(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS last_24h
        FROM submissions
        WHERE tenant_id = $1::uuid AND created_at >= $2
        """,
        tenant_id,
        since,
        conn=conn,
    )
    return {k: int(v) for k, v in dict(row).items()}


async def timeseries(
    tenant_id: str,
    *,
    since: datetime,
    granularity: str,
    conn: asyncpg.Connection | None = None,
) -> list[dict[str, Any]]:
    # Interpolated, not parameterised, because date_trunc's unit cannot be a
    # bind parameter. Safe only because this expression yields two literals.
    unit = "hour" if granularity == "hour" else "day"
    rows = await pool.fetch(
        f"""
        SELECT date_trunc('{unit}', created_at)                 AS bucket,
               count(*) FILTER (WHERE status = 'stored')        AS stored,
               count(*) FILTER (WHERE status = 'spam')          AS spam
        FROM submissions
        WHERE tenant_id = $1::uuid AND created_at >= $2
        GROUP BY bucket ORDER BY bucket ASC
        """,
        tenant_id,
        since,
        conn=conn,
    )
    return [
        {
            "bucket": r["bucket"].isoformat().replace("+00:00", "Z"),
            "stored": int(r["stored"]),
            "spam": int(r["spam"]),
        }
        for r in rows
    ]


async def per_widget(
    tenant_id: str, since: datetime, *, conn: asyncpg.Connection | None = None
) -> list[dict[str, Any]]:
    # LEFT JOIN so a widget with no submissions still appears, with zeros.
    rows = await pool.fetch(
        """
        SELECT w.id AS widget_id, w.name AS widget_name, w.public_id,
               count(s.id) FILTER (WHERE s.status = 'stored') AS stored,
               count(s.id) FILTER (WHERE s.status = 'spam')   AS spam,
               max(s.created_at)                              AS last_submission_at
        FROM widgets w
        LEFT JOIN submissions s ON s.widget_id = w.id AND s.created_at >= $2
        WHERE w.tenant_id = $1::uuid AND w.deleted_at IS NULL
        GROUP BY w.id, w.name, w.public_id
        ORDER BY stored DESC, w.created_at DESC
        """,
        tenant_id,
        since,
        conn=conn,
    )
    return [
        {
            "widgetId": str(r["widget_id"]),
            "name": r["widget_name"],
            "publicId": r["public_id"],
            "stored": int(r["stored"]),
            "spam": int(r["spam"]),
            "lastSubmissionAt": r["last_submission_at"],
        }
        for r in rows
    ]


async def geo_breakdown(
    tenant_id: str, *, since: datetime, limit: int, conn: asyncpg.Connection | None = None
) -> list[dict[str, Any]]:
    rows = await pool.fetch(
        """
        SELECT country_code, max(country) AS country, count(*) AS submissions
        FROM submissions
        WHERE tenant_id = $1::uuid AND created_at >= $2 AND status = 'stored'
        GROUP BY country_code
        ORDER BY submissions DESC
        LIMIT $3
        """,
        tenant_id,
        since,
        limit,
        conn=conn,
    )
    return [
        {
            "countryCode": r["country_code"],
            "country": r["country"],
            "submissions": int(r["submissions"]),
        }
        for r in rows
    ]
