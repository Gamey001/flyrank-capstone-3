import hashlib
from typing import Any

from app.domain.models import Widget
from app.lib.errors import AppError
from app.lib.ids import public_widget_id
from app.repositories import widgets as widgets_repo
from app.repositories.mappers import display_to_json, field_to_json
from app.services import embed


def _with_embed(widget: Widget) -> dict[str, Any]:
    payload = widget.model_dump(by_alias=True)
    payload["embed"] = embed.for_widget(widget.public_id)
    return payload


async def create(tenant_id: str, data: dict[str, Any]) -> dict[str, Any]:
    widget = await widgets_repo.create(tenant_id=tenant_id, public_id=public_widget_id(), **data)
    return _with_embed(widget)


async def list_widgets(tenant_id: str, *, limit: int, offset: int) -> tuple[list[Any], int]:
    items, total = await widgets_repo.list_for_tenant(tenant_id, limit=limit, offset=offset)
    return [_with_embed(w) for w in items], total


async def get(tenant_id: str, widget_id: str) -> dict[str, Any]:
    widget = await widgets_repo.find_by_id_for_tenant(widget_id, tenant_id)
    # 404 rather than 403 for another tenant's widget: a 403 confirms the id
    # exists. Same reasoning throughout this service.
    if widget is None:
        raise AppError.not_found("Widget not found")
    return _with_embed(widget)


async def update(tenant_id: str, widget_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    widget = await widgets_repo.update(widget_id, tenant_id, patch)
    if widget is None:
        raise AppError.not_found("Widget not found")
    return _with_embed(widget)


async def remove(tenant_id: str, widget_id: str) -> None:
    if not await widgets_repo.soft_delete(widget_id, tenant_id):
        raise AppError.not_found("Widget not found")


async def get_embed(tenant_id: str, widget_id: str) -> dict[str, Any]:
    widget = await get(tenant_id, widget_id)
    return widget["embed"]  # type: ignore[no-any-return]


# A projection, not the row: this is downloaded by every visitor to a customer
# site, so tenant_id, webhook_url and notify_email must never appear in it.
async def public_config(public_id: str) -> tuple[dict[str, Any], str]:
    widget = await widgets_repo.find_active_by_public_id(public_id)
    if widget is None:
        raise AppError.not_found("Widget not found or inactive")

    config = {
        "id": widget.public_id,
        "type": widget.type,
        "title": widget.title,
        "description": widget.description,
        "buttonText": widget.button_text,
        "successMessage": widget.success_message,
        "fields": [field_to_json(f) for f in widget.fields],
        "display": display_to_json(widget.display),
        "honeypotField": widget.honeypot_field,
        "revision": widget.revision,
    }

    # revision and updated_at together cover every way the config can change.
    seed = f"{widget.public_id}:{widget.revision}:{widget.updated_at.isoformat()}"
    etag = f'"{hashlib.sha1(seed.encode()).hexdigest()[:16]}"'  # noqa: S324 — cache key, not a MAC
    return config, etag
