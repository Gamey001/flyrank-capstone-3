from typing import Any

import asyncpg

from app.db.pool import transaction
from app.domain.models import GeoResult, Submission, Widget
from app.jobs import types as job_types
from app.lib.errors import AppError
from app.lib.logging import logger
from app.repositories import jobs as jobs_repo
from app.repositories import submissions as submissions_repo
from app.repositories import widgets as widgets_repo
from app.services import spam
from app.services.field_validation import validate_submission
from app.services.geo.enrichment import enrich_with_geo

_UNIQUE_VIOLATION = "23505"


def _origin_matches(allowed: list[str], origin: str | None) -> bool:
    # An empty list means any origin — the normal case for a widget meant to be
    # pasted anywhere. A non-empty list is an explicit lock-down.
    if not allowed:
        return True
    if not origin:
        return False
    return any(entry == "*" or entry.lower() == origin.lower() for entry in allowed)


def _email_from(widget: Widget, data: dict[str, Any]) -> str | None:
    field = next((f for f in widget.fields if f.type == "email"), None)
    if field is None:
        return None
    value = data.get(field.name)
    return value if isinstance(value, str) and value else None


async def require_active_widget(public_id: str) -> Widget:
    widget = await widgets_repo.find_active_by_public_id(public_id)
    if widget is None:
        raise AppError.not_found("Widget not found or inactive")
    return widget


async def submit(
    *,
    widget_public_id: str,
    data: dict[str, Any],
    elapsed_ms: int | None = None,
    page_url: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
    origin: str | None = None,
    referer: str | None = None,
    idempotency_key: str | None = None,
) -> dict[str, Any]:
    widget = await require_active_widget(widget_public_id)

    if not _origin_matches(widget.allowed_origins, origin):
        raise AppError.forbidden("This widget does not accept submissions from that origin")

    if idempotency_key:
        existing = await submissions_repo.find_by_idempotency_key(widget.id, idempotency_key)
        if existing is not None:
            return {
                "status": "duplicate",
                "submission": existing,
                "message": widget.success_message,
            }

    outcome = validate_submission(widget, data)
    if not outcome.ok:
        raise AppError.unprocessable(
            "Some fields are invalid",
            [{"path": issue.path, "message": issue.message} for issue in outcome.issues],
        )

    verdict = spam.check(
        widget=widget, data=outcome.data, elapsed_ms=elapsed_ms, user_agent=user_agent
    )

    clean = {k: v for k, v in outcome.data.items() if k != widget.honeypot_field}

    context = {
        "ip": ip,
        "user_agent": user_agent,
        "origin": origin,
        "referer": referer,
        "page_url": page_url,
        "idempotency_key": idempotency_key,
    }

    # Stored rather than dropped, and the caller returns the same 202 a human
    # gets: a bot that can detect it was filtered is a bot that can iterate.
    if verdict.is_spam:
        logger.info(
            "submission classified as spam", widget_id=widget.id, reason=verdict.reason, ip=ip
        )
        await store(
            widget,
            clean,
            context,
            GeoResult(provider="none", status="skipped"),
            verdict.reason or "spam",
        )
        return {"status": "accepted", "submission": None, "message": widget.success_message}

    # enrich_with_geo never raises, so nothing here can stop the row being written.
    geo = await enrich_with_geo(ip)

    submission = await store(widget, clean, context, geo, None)
    return {"status": "accepted", "submission": submission, "message": widget.success_message}


# Side effects are enqueued here, never invoked. That is what makes a failing
# email or webhook harmless: this path only writes rows.
async def store(
    widget: Widget,
    data: dict[str, Any],
    context: dict[str, Any],
    geo: GeoResult,
    spam_reason: str | None,
) -> Submission:
    try:
        async with transaction() as conn:
            submission = await submissions_repo.create(
                widget_id=widget.id,
                tenant_id=widget.tenant_id,
                status="spam" if spam_reason else "stored",
                spam_reason=spam_reason,
                data=data,
                email=_email_from(widget, data),
                ip_address=context["ip"],
                user_agent=context["user_agent"],
                origin=context["origin"],
                referer=context["referer"],
                page_url=context["page_url"],
                geo=geo,
                idempotency_key=context["idempotency_key"],
                conn=conn,
            )

            if not spam_reason:
                if widget.notify_email:
                    await jobs_repo.enqueue(
                        type=job_types.SUBMISSION_EMAIL,
                        payload={
                            "submissionId": submission.id,
                            "widgetId": widget.id,
                            "tenantId": widget.tenant_id,
                            "to": widget.notify_email,
                            "widgetName": widget.name,
                        },
                        conn=conn,
                    )
                if widget.webhook_url:
                    await jobs_repo.enqueue(
                        type=job_types.SUBMISSION_WEBHOOK,
                        payload={
                            "submissionId": submission.id,
                            "widgetId": widget.id,
                            "tenantId": widget.tenant_id,
                            "url": widget.webhook_url,
                        },
                        conn=conn,
                    )

            return submission

    except asyncpg.UniqueViolationError:
        # Two requests raced on the same idempotency key and the unique index
        # rejected the loser. Return what the winner stored.
        key = context["idempotency_key"]
        if key:
            existing = await submissions_repo.find_by_idempotency_key(widget.id, key)
            if existing is not None:
                return existing
        raise
