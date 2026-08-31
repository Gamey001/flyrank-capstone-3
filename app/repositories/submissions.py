from datetime import datetime
from typing import Any

import asyncpg

from app.db import pool
from app.domain.models import GeoResult, Submission
from app.repositories.mappers import to_submission

_COLUMNS = """id, widget_id, tenant_id, status, spam_reason, data, email,
              host(ip_address) AS ip_address, user_agent, origin, referer, page_url,
              geo_provider, geo_status, country, country_code, region, city, latitude,
              longitude, idempotency_key, created_at"""


async def create(
    *,
    widget_id: str,
    tenant_id: str,
    status: str,
    data: dict[str, Any],
    geo: GeoResult,
    spam_reason: str | None = None,
    email: str | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
    origin: str | None = None,
    referer: str | None = None,
    page_url: str | None = None,
    idempotency_key: str | None = None,
    conn: asyncpg.Connection | None = None,
) -> Submission:
    row = await pool.fetchrow(
        f"""
        INSERT INTO submissions (widget_id, tenant_id, status, spam_reason, data, email,
                                 ip_address, user_agent, origin, referer, page_url,
                                 geo_provider, geo_status, country, country_code, region,
                                 city, latitude, longitude, idempotency_key)
        VALUES ($1::uuid, $2::uuid, $3::submission_status, $4, $5::jsonb, $6, $7::inet, $8,
                $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
        RETURNING {_COLUMNS}
        """,
        widget_id,
        tenant_id,
        status,
        spam_reason,
        data,
        email,
        ip_address,
        user_agent,
        origin,
        referer,
        page_url,
        geo.provider,
        geo.status,
        geo.country,
        geo.country_code,
        geo.region,
        geo.city,
        geo.latitude,
        geo.longitude,
        idempotency_key,
        conn=conn,
    )
    return to_submission(row)


async def find_by_idempotency_key(
    widget_id: str, idempotency_key: str, *, conn: asyncpg.Connection | None = None
) -> Submission | None:
    row = await pool.fetchrow(
        f"SELECT {_COLUMNS} FROM submissions WHERE widget_id = $1::uuid AND idempotency_key = $2",
        widget_id,
        idempotency_key,
        conn=conn,
    )
    return to_submission(row) if row else None


async def find_by_id_for_tenant(
    submission_id: str, tenant_id: str, *, conn: asyncpg.Connection | None = None
) -> Submission | None:
    row = await pool.fetchrow(
        f"SELECT {_COLUMNS} FROM submissions WHERE id = $1::uuid AND tenant_id = $2::uuid",
        submission_id,
        tenant_id,
        conn=conn,
    )
    return to_submission(row) if row else None


async def list_for_tenant(
    *,
    tenant_id: str,
    limit: int,
    offset: int,
    widget_id: str | None = None,
    status: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    conn: asyncpg.Connection | None = None,
) -> tuple[list[Submission], int]:
    # Always $1, never optional: every caller-supplied filter is appended after
    # the tenant predicate rather than replacing it.
    conditions = ["tenant_id = $1::uuid"]
    values: list[Any] = [tenant_id]

    def add(sql: str, value: Any) -> None:
        values.append(value)
        conditions.append(sql.replace("?", f"${len(values)}"))

    if widget_id:
        add("widget_id = ?::uuid", widget_id)
    if status:
        add("status = ?::submission_status", status)
    if date_from:
        add("created_at >= ?", date_from)
    if date_to:
        add("created_at <= ?", date_to)

    where = " AND ".join(conditions)

    rows = await pool.fetch(
        f"""SELECT {_COLUMNS} FROM submissions WHERE {where}
            ORDER BY created_at DESC, id DESC
            LIMIT ${len(values) + 1} OFFSET ${len(values) + 2}""",
        *values,
        limit,
        offset,
        conn=conn,
    )
    total = await pool.fetchrow(
        f"SELECT count(*) AS count FROM submissions WHERE {where}", *values, conn=conn
    )
    return [to_submission(r) for r in rows], int(total["count"])
