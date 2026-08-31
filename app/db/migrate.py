import asyncio
import hashlib
from pathlib import Path

import asyncpg

from app.db.pool import close_pool, create_pool
from app.lib.logging import logger

MIGRATIONS_DIR = Path(__file__).parent / "migrations"

# Arbitrary, but must be identical across deploys: it is what stops two
# containers booting at once from applying the same migration twice.
ADVISORY_LOCK_KEY = 8_147_226_301


def _checksum(sql: str) -> str:
    return hashlib.sha256(sql.encode()).hexdigest()


async def run_migrations() -> list[str]:
    pool = await create_pool()
    applied: list[str] = []

    async with pool.acquire() as conn:
        await conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                name       text PRIMARY KEY,
                checksum   text        NOT NULL,
                applied_at timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        await conn.execute("SELECT pg_advisory_lock($1)", ADVISORY_LOCK_KEY)
        try:
            rows = await conn.fetch("SELECT name, checksum FROM schema_migrations")
            done = {row["name"]: row["checksum"] for row in rows}

            for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
                sql = path.read_text()
                digest = _checksum(sql)
                previous = done.get(path.name)

                if previous is not None:
                    if previous != digest:
                        raise RuntimeError(
                            f"Migration {path.name} has changed since it was applied. "
                            "Add a new migration instead of editing history."
                        )
                    continue

                try:
                    async with conn.transaction():
                        await conn.execute(sql)
                        await conn.execute(
                            "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
                            path.name,
                            digest,
                        )
                except asyncpg.PostgresError as exc:
                    raise RuntimeError(f"Migration {path.name} failed: {exc}") from exc

                applied.append(path.name)
                logger.info("migration applied", migration=path.name)

            return applied
        finally:
            await conn.execute("SELECT pg_advisory_unlock($1)", ADVISORY_LOCK_KEY)


async def _main() -> None:
    try:
        applied = await run_migrations()
        print(
            f"Applied {len(applied)} migration(s): {', '.join(applied)}"
            if applied
            else "Schema already up to date."
        )
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(_main())
