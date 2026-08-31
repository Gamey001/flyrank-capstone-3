from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Query
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse

from app.http.dependencies import TenantId
from app.lib.errors import AppError
from app.services import dashboard as dashboard_service

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

_NO_STORE = {"cache-control": "private, no-store"}


@router.get("/submissions")
async def list_submissions(
    tenant_id: TenantId,
    widgetId: str | None = None,  # noqa: N803 — public query-string shape
    status: Literal["stored", "spam"] | None = None,
    date_from: datetime | None = Query(default=None, alias="from"),
    date_to: datetime | None = Query(default=None, alias="to"),
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> JSONResponse:
    if date_from and date_to and date_from > date_to:
        raise AppError.unprocessable(
            "Invalid request query", [{"path": "from", "message": "`from` must be before `to`"}]
        )

    items, total = await dashboard_service.list_submissions(
        tenant_id,
        limit=limit,
        offset=offset,
        widget_id=widgetId,
        status=status,
        date_from=date_from,
        date_to=date_to,
    )
    return JSONResponse(
        content={
            "submissions": [jsonable_encoder(s.model_dump(by_alias=True)) for s in items],
            "pagination": {"total": total, "limit": limit, "offset": offset},
        },
        headers=_NO_STORE,
    )


@router.get("/submissions/{submission_id}")
async def get_submission(submission_id: str, tenant_id: TenantId) -> JSONResponse:
    submission = await dashboard_service.get_submission(tenant_id, submission_id)
    return JSONResponse(
        content={"submission": jsonable_encoder(submission.model_dump(by_alias=True))},
        headers=_NO_STORE,
    )


@router.get("/stats")
async def stats(
    tenant_id: TenantId,
    days: int = Query(default=30, ge=1, le=365),
    granularity: Literal["day", "hour"] = "day",
) -> JSONResponse:
    payload = await dashboard_service.stats(tenant_id, days=days, granularity=granularity)
    return JSONResponse(content=jsonable_encoder(payload), headers=_NO_STORE)
