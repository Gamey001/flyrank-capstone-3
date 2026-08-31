import time

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.db import pool
from app.repositories import jobs as jobs_repo
from app.services import widget_asset

router = APIRouter(tags=["health"])

_STARTED_AT = time.monotonic()
_NO_STORE = {"cache-control": "no-store"}


# Liveness: deliberately touches no dependency.
@router.get("/healthz")
async def healthz() -> JSONResponse:
    return JSONResponse(
        content={"status": "ok", "uptimeSeconds": round(time.monotonic() - _STARTED_AT)},
        headers=_NO_STORE,
    )


# Readiness: checks the dependency this service cannot work without, so an
# orchestrator stops routing here instead of letting it serve 500s.
@router.get("/readyz")
async def readyz() -> JSONResponse:
    try:
        await pool.fetchrow("SELECT 1")
        jobs = await jobs_repo.counts()
    except Exception as exc:
        return JSONResponse(
            status_code=503,
            content={
                "status": "unavailable",
                "database": "unreachable",
                "reason": str(exc),
            },
            headers=_NO_STORE,
        )
    return JSONResponse(
        content={
            "status": "ready",
            "database": "ok",
            "widgetVersion": widget_asset.VERSION,
            "jobs": jobs,
        },
        headers=_NO_STORE,
    )


# HEAD for monitors, out of the schema so each endpoint is documented once.
for _path, _endpoint in (("/healthz", healthz), ("/readyz", readyz)):
    router.add_api_route(_path, _endpoint, methods=["HEAD"], include_in_schema=False)
