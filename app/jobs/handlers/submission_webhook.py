from typing import Any

import httpx

from app.lib.errors import AppError
from app.repositories import submissions as submissions_repo

WEBHOOK_TIMEOUT_SECONDS = 5.0


# Retried by the worker on failure, so the delivery header carries the
# submission id for a receiver to de-duplicate on.
async def handle(payload: dict[str, Any]) -> None:
    if not isinstance(payload.get("submissionId"), str) or not isinstance(payload.get("url"), str):
        raise AppError.bad_request("submission.webhook job has a malformed payload")

    submission = await submissions_repo.find_by_id_for_tenant(
        payload["submissionId"], payload["tenantId"]
    )
    if submission is None:
        return

    async with httpx.AsyncClient(timeout=WEBHOOK_TIMEOUT_SECONDS) as client:
        response = await client.post(
            payload["url"],
            headers={
                "content-type": "application/json",
                "user-agent": "flyrank-widget-platform/1.0",
                "x-flyrank-event": "submission.created",
                "x-flyrank-delivery": submission.id,
            },
            json={
                "event": "submission.created",
                "submission": {
                    "id": submission.id,
                    "widgetId": submission.widget_id,
                    "createdAt": submission.created_at.isoformat(),
                    "data": submission.data,
                    "geo": {
                        "status": submission.geo_status,
                        "provider": submission.geo_provider,
                        "country": submission.country,
                        "countryCode": submission.country_code,
                        "city": submission.city,
                    },
                },
            },
        )

    if response.status_code >= 400:
        raise RuntimeError(f"webhook {payload['url']} responded {response.status_code}")
