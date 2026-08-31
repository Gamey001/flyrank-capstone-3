import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import asyncpg

from app.config.settings import settings
from app.lib.logging import logger

_pool: asyncpg.Pool | None = None


async def _init_connection(conn: asyncpg.Connection) -> None:
    """jsonb in and out as Python objects rather than strings, so no call site
    has to remember to serialise."""
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")
    await conn.set_type_codec("json", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def create_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            dsn=settings.database_dsn,
            min_size=settings.DATABASE_POOL_MIN,
            max_size=settings.DATABASE_POOL_MAX,
            command_timeout=30,
            init=_init_connection,
            server_settings={"application_name": "flyrank-widget-platform"},
        )
        logger.debug("postgres pool created", min=settings.DATABASE_POOL_MIN)
    return _pool


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Database pool is not initialised; call create_pool() first")
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


@asynccontextmanager
async def transaction() -> AsyncIterator[asyncpg.Connection]:
    """Runs a block inside one transaction and always returns the connection to
    the pool. Used wherever a submission and its outbox job must commit together."""
    pool = get_pool()
    async with pool.acquire() as conn, conn.transaction():
        yield conn


@asynccontextmanager
async def connection() -> AsyncIterator[asyncpg.Connection]:
    pool = get_pool()
    async with pool.acquire() as conn:
        yield conn


async def fetch(query: str, *args: Any, conn: asyncpg.Connection | None = None) -> list[Any]:
    if conn is not None:
        return list(await conn.fetch(query, *args))
    async with connection() as c:
        return list(await c.fetch(query, *args))


async def fetchrow(query: str, *args: Any, conn: asyncpg.Connection | None = None) -> Any:
    if conn is not None:
        return await conn.fetchrow(query, *args)
    async with connection() as c:
        return await c.fetchrow(query, *args)


async def execute(query: str, *args: Any, conn: asyncpg.Connection | None = None) -> str:
    if conn is not None:
        return str(await conn.execute(query, *args))
    async with connection() as c:
        return str(await c.execute(query, *args))
