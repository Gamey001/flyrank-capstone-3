from typing import Any

import asyncpg

from app.db import pool
from app.domain.models import Widget, WidgetDisplay, WidgetField
from app.repositories.mappers import display_to_json, field_to_json, to_widget

_COLUMNS = """id, tenant_id, public_id, name, type, status, title, description, button_text,
              success_message, fields, display, honeypot_field, allowed_origins, webhook_url,
              notify_email, revision, created_at, updated_at"""

# The allow-list that makes the dynamic SET clause below safe: a key absent from
# this map can never reach the SQL.
_UPDATABLE: dict[str, str] = {
    "name": "name",
    "type": "type",
    "status": "status",
    "title": "title",
    "description": "description",
    "button_text": "button_text",
    "success_message": "success_message",
    "fields": "fields",
    "display": "display",
    "honeypot_field": "honeypot_field",
    "allowed_origins": "allowed_origins",
    "webhook_url": "webhook_url",
    "notify_email": "notify_email",
}

_CASTS = {"type": "::widget_type", "status": "::widget_status", "allowed_origins": "::text[]"}


# The enum casts are required: COALESCE with a NULL parameter infers text, which
# Postgres will not implicitly coerce to an enum column.
async def create(
    *,
    tenant_id: str,
    public_id: str,
    name: str,
    type: str,
    title: str,
    fields: list[WidgetField],
    status: str | None = None,
    description: str | None = None,
    button_text: str | None = None,
    success_message: str | None = None,
    display: WidgetDisplay | None = None,
    honeypot_field: str | None = None,
    allowed_origins: list[str] | None = None,
    webhook_url: str | None = None,
    notify_email: str | None = None,
    conn: asyncpg.Connection | None = None,
) -> Widget:
    row = await pool.fetchrow(
        f"""
        INSERT INTO widgets (tenant_id, public_id, name, type, status, title, description,
                             button_text, success_message, fields, display, honeypot_field,
                             allowed_origins, webhook_url, notify_email)
        VALUES ($1::uuid, $2, $3, $4::widget_type, COALESCE($5::widget_status, 'active'), $6, $7,
                COALESCE($8, 'Submit'), COALESCE($9, 'Thanks! We will be in touch.'),
                $10::jsonb, $11::jsonb, COALESCE($12, 'company_website'),
                COALESCE($13::text[], '{{}}'), $14, $15)
        RETURNING {_COLUMNS}
        """,
        tenant_id,
        public_id,
        name,
        type,
        status,
        title,
        description,
        button_text,
        success_message,
        [field_to_json(f) for f in fields],
        display_to_json(display or WidgetDisplay()),
        honeypot_field,
        allowed_origins,
        webhook_url,
        notify_email,
        conn=conn,
    )
    return to_widget(row)


# tenant_id is a required argument on every read below, so a cross-tenant leak
# has to be written deliberately rather than forgotten.
async def find_by_id_for_tenant(
    widget_id: str, tenant_id: str, *, conn: asyncpg.Connection | None = None
) -> Widget | None:
    row = await pool.fetchrow(
        f"""SELECT {_COLUMNS} FROM widgets
            WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL""",
        widget_id,
        tenant_id,
        conn=conn,
    )
    return to_widget(row) if row else None


async def list_for_tenant(
    tenant_id: str, *, limit: int, offset: int, conn: asyncpg.Connection | None = None
) -> tuple[list[Widget], int]:
    rows = await pool.fetch(
        f"""SELECT {_COLUMNS} FROM widgets
            WHERE tenant_id = $1::uuid AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT $2 OFFSET $3""",
        tenant_id,
        limit,
        offset,
        conn=conn,
    )
    total = await pool.fetchrow(
        "SELECT count(*) AS count FROM widgets WHERE tenant_id = $1::uuid AND deleted_at IS NULL",
        tenant_id,
        conn=conn,
    )
    return [to_widget(r) for r in rows], int(total["count"])


# The one unauthenticated read in this repository — named so the absence of a
# tenant check is obvious at the call site.
async def find_active_by_public_id(
    public_id: str, *, conn: asyncpg.Connection | None = None
) -> Widget | None:
    row = await pool.fetchrow(
        f"""SELECT {_COLUMNS} FROM widgets
            WHERE public_id = $1 AND status = 'active' AND deleted_at IS NULL""",
        public_id,
        conn=conn,
    )
    return to_widget(row) if row else None


async def update(
    widget_id: str,
    tenant_id: str,
    patch: dict[str, Any],
    *,
    conn: asyncpg.Connection | None = None,
) -> Widget | None:
    assignments: list[str] = []
    values: list[Any] = []

    for key, column in _UPDATABLE.items():
        if key not in patch:
            continue
        value = patch[key]
        if column == "fields":
            value = [field_to_json(f) for f in value]
        elif column == "display":
            value = display_to_json(value)
        values.append(value)
        cast = "::jsonb" if column in {"fields", "display"} else _CASTS.get(column, "")
        assignments.append(f"{column} = ${len(values)}{cast}")

    if not assignments:
        return await find_by_id_for_tenant(widget_id, tenant_id, conn=conn)

    # The public config ETag is derived from this, so an edit invalidates a
    # browser's cached config instead of being served stale indefinitely.
    assignments.append("revision = revision + 1")
    values.extend([widget_id, tenant_id])

    row = await pool.fetchrow(
        f"""UPDATE widgets SET {", ".join(assignments)}
            WHERE id = ${len(values) - 1}::uuid AND tenant_id = ${len(values)}::uuid
              AND deleted_at IS NULL
            RETURNING {_COLUMNS}""",
        *values,
        conn=conn,
    )
    return to_widget(row) if row else None


# Soft, so deleting a widget does not cascade away the leads it collected.
async def soft_delete(
    widget_id: str, tenant_id: str, *, conn: asyncpg.Connection | None = None
) -> bool:
    result = await pool.execute(
        """UPDATE widgets SET deleted_at = now(), status = 'paused'
           WHERE id = $1::uuid AND tenant_id = $2::uuid AND deleted_at IS NULL""",
        widget_id,
        tenant_id,
        conn=conn,
    )
    return result.endswith("1")
