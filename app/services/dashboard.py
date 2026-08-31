import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

from app.domain.models import Submission
from app.lib.errors import AppError
from app.repositories import stats as stats_repo
from app.repositories import submissions as submissions_repo
from app.repositories import widgets as widgets_repo


async def list_submissions(
    tenant_id: str,
    *,
    limit: int,
    offset: int,
    widget_id: str | None = None,
    status: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
) -> tuple[list[Submission], int]:
    # Checked before the query as well as inside it: filtering by another
    # tenant's widget must 404, not return a plausible empty page.
    if widget_id and not await widgets_repo.find_by_id_for_tenant(widget_id, tenant_id):
        raise AppError.not_found("Widget not found")

    return await submissions_repo.list_for_tenant(
        tenant_id=tenant_id,
        limit=limit,
        offset=offset,
        widget_id=widget_id,
        status=status,
        date_from=date_from,
        date_to=date_to,
    )


async def get_submission(tenant_id: str, submission_id: str) -> Submission:
    submission = await submissions_repo.find_by_id_for_tenant(submission_id, tenant_id)
    if submission is None:
        raise AppError.not_found("Submission not found")
    return submission


async def stats(tenant_id: str, *, days: int, granularity: str) -> dict[str, Any]:
    since = datetime.now(UTC) - timedelta(days=days)

    totals, series, per_widget, geo = await asyncio.gather(
        stats_repo.totals(tenant_id, since),
        stats_repo.timeseries(tenant_id, since=since, granularity=granularity),
        stats_repo.per_widget(tenant_id, since),
        stats_repo.geo_breakdown(tenant_id, since=since, limit=20),
    )

    return {
        "window": {
            "since": since.isoformat().replace("+00:00", "Z"),
            "days": days,
            "granularity": granularity,
        },
        "totals": {
            "submissions": totals["total"],
            "stored": totals["stored"],
            "spam": totals["spam"],
            "enriched": totals["enriched"],
            "last24h": totals["last_24h"],
        },
        "timeseries": series,
        "widgets": per_widget,
        "geo": geo,
    }
