import asyncpg

from app.db import pool
from app.domain.models import Tenant, TenantWithSecret
from app.repositories.mappers import to_tenant, to_tenant_with_secret

_COLUMNS = "id, email, name, password_hash, created_at"


async def create(
    *, email: str, name: str, password_hash: str, conn: asyncpg.Connection | None = None
) -> Tenant:
    row = await pool.fetchrow(
        f"""INSERT INTO tenants (email, name, password_hash)
            VALUES ($1, $2, $3) RETURNING {_COLUMNS}""",
        email,
        name,
        password_hash,
        conn=conn,
    )
    return to_tenant(row)


async def find_by_email(
    email: str, *, conn: asyncpg.Connection | None = None
) -> TenantWithSecret | None:
    row = await pool.fetchrow(
        f"SELECT {_COLUMNS} FROM tenants WHERE lower(email) = lower($1)", email, conn=conn
    )
    return to_tenant_with_secret(row) if row else None


async def find_by_id(tenant_id: str, *, conn: asyncpg.Connection | None = None) -> Tenant | None:
    row = await pool.fetchrow(
        f"SELECT {_COLUMNS} FROM tenants WHERE id = $1::uuid", tenant_id, conn=conn
    )
    return to_tenant(row) if row else None
