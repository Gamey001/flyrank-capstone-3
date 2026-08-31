from typing import Any

from fastapi import APIRouter, Query, Response

from app.http.dependencies import TenantId
from app.http.schemas import WidgetCreate, WidgetUpdate
from app.services import widgets as widgets_service

# The dependency is on the router, not each route, so an endpoint added later is
# protected by default rather than by remembering.
router = APIRouter(prefix="/api/widgets", tags=["widgets"])


def _to_repo_kwargs(payload: WidgetCreate | WidgetUpdate) -> dict[str, Any]:
    """Maps the public camelCase JSON onto the repository's snake_case keyword
    arguments. Only fields the caller actually sent are included, so a PATCH
    cannot silently reset an untouched column."""
    sent = payload.model_dump(exclude_unset=True)
    mapping = {
        "buttonText": "button_text",
        "successMessage": "success_message",
        "honeypotField": "honeypot_field",
        "allowedOrigins": "allowed_origins",
        "webhookUrl": "webhook_url",
        "notifyEmail": "notify_email",
    }
    out: dict[str, Any] = {}
    for key, value in sent.items():
        out[mapping.get(key, key)] = value
    if "fields" in out:
        from app.domain.models import WidgetField

        out["fields"] = [
            WidgetField(
                name=f["name"],
                label=f["label"],
                type=f["type"],
                required=f.get("required", False),
                placeholder=f.get("placeholder"),
                options=f.get("options"),
                max_length=f.get("maxLength"),
            )
            for f in out["fields"]
        ]
    if "display" in out and out["display"] is not None:
        from app.domain.models import WidgetDisplay

        d = out["display"]
        out["display"] = WidgetDisplay(
            position=d.get("position"),
            theme=d.get("theme"),
            accent_color=d.get("accentColor"),
            delay_seconds=d.get("delaySeconds"),
        )
    return out


@router.post("", status_code=201)
async def create(payload: WidgetCreate, tenant_id: TenantId, response: Response) -> dict[str, Any]:
    widget = await widgets_service.create(tenant_id, _to_repo_kwargs(payload))
    response.headers["location"] = f"/api/widgets/{widget['id']}"
    return {"widget": widget}


@router.get("")
async def list_widgets(
    tenant_id: TenantId,
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    items, total = await widgets_service.list_widgets(tenant_id, limit=limit, offset=offset)
    return {"widgets": items, "pagination": {"total": total, "limit": limit, "offset": offset}}


@router.get("/{widget_id}")
async def get(widget_id: str, tenant_id: TenantId) -> dict[str, Any]:
    return {"widget": await widgets_service.get(tenant_id, widget_id)}


@router.patch("/{widget_id}")
async def update(widget_id: str, payload: WidgetUpdate, tenant_id: TenantId) -> dict[str, Any]:
    return {"widget": await widgets_service.update(tenant_id, widget_id, _to_repo_kwargs(payload))}


@router.delete("/{widget_id}", status_code=204)
async def remove(widget_id: str, tenant_id: TenantId) -> Response:
    await widgets_service.remove(tenant_id, widget_id)
    return Response(status_code=204)


@router.get("/{widget_id}/embed")
async def get_embed(widget_id: str, tenant_id: TenantId) -> dict[str, Any]:
    return {"embed": await widgets_service.get_embed(tenant_id, widget_id)}
