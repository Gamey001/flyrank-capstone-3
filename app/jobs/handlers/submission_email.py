from typing import Any

from app.lib.errors import AppError
from app.repositories import submissions as submissions_repo
from app.services import mailer as mailer_module


async def handle(payload: dict[str, Any]) -> None:
    if not isinstance(payload.get("submissionId"), str) or not isinstance(payload.get("to"), str):
        raise AppError.bad_request("submission.notify_email job has a malformed payload")

    submission = await submissions_repo.find_by_id_for_tenant(
        payload["submissionId"], payload["tenantId"]
    )
    # The row is gone (widget or tenant deleted). Retrying cannot bring it back,
    # so this is done rather than failed.
    if submission is None:
        return

    lines = [f"  {key}: {value}" for key, value in submission.data.items()]
    location = (
        f"{submission.city}, {submission.country or submission.country_code or 'unknown'}"
        if submission.city
        else (submission.country or "unknown")
    )

    await mailer_module.mailer.send(
        to=payload["to"],
        subject=f'New submission on "{payload["widgetName"]}"',
        text="\n".join(
            [
                f'A new submission arrived on your widget "{payload["widgetName"]}".',
                "",
                *lines,
                "",
                f"Location: {location} "
                f"(source: {submission.geo_provider or 'none'}/{submission.geo_status})",
                f"Page:     {submission.page_url or 'unknown'}",
                f"Received: {submission.created_at.isoformat()}",
                f"Id:       {submission.id}",
            ]
        ),
    )
