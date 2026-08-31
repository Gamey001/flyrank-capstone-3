"""The only place that knows Postgres row shapes. Everything above the
repositories works with the models in `app.domain.models`."""

from typing import Any

from app.domain.models import (
    Job,
    Submission,
    Tenant,
    TenantWithSecret,
    Widget,
    WidgetDisplay,
    WidgetField,
)


def to_tenant(row: Any) -> Tenant:
    return Tenant(
        id=str(row["id"]),
        email=row["email"],
        name=row["name"],
        created_at=row["created_at"],
    )


def to_tenant_with_secret(row: Any) -> TenantWithSecret:
    return TenantWithSecret(
        id=str(row["id"]),
        email=row["email"],
        name=row["name"],
        created_at=row["created_at"],
        password_hash=row["password_hash"],
    )


def _to_field(raw: dict[str, Any]) -> WidgetField:
    return WidgetField(
        name=raw["name"],
        label=raw["label"],
        type=raw["type"],
        required=raw.get("required", False),
        placeholder=raw.get("placeholder"),
        options=raw.get("options"),
        max_length=raw.get("maxLength", raw.get("max_length")),
    )


def _to_display(raw: dict[str, Any]) -> WidgetDisplay:
    return WidgetDisplay(
        position=raw.get("position"),
        theme=raw.get("theme"),
        accent_color=raw.get("accentColor", raw.get("accent_color")),
        delay_seconds=raw.get("delaySeconds", raw.get("delay_seconds")),
    )


def to_widget(row: Any) -> Widget:
    return Widget(
        id=str(row["id"]),
        tenant_id=str(row["tenant_id"]),
        public_id=row["public_id"],
        name=row["name"],
        type=row["type"],
        status=row["status"],
        title=row["title"],
        description=row["description"],
        button_text=row["button_text"],
        success_message=row["success_message"],
        fields=[_to_field(f) for f in (row["fields"] or [])],
        display=_to_display(row["display"] or {}),
        honeypot_field=row["honeypot_field"],
        allowed_origins=list(row["allowed_origins"] or []),
        webhook_url=row["webhook_url"],
        notify_email=row["notify_email"],
        revision=row["revision"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def to_submission(row: Any) -> Submission:
    return Submission(
        id=str(row["id"]),
        widget_id=str(row["widget_id"]),
        tenant_id=str(row["tenant_id"]),
        status=row["status"],
        spam_reason=row["spam_reason"],
        data=row["data"] or {},
        email=row["email"],
        ip_address=row["ip_address"],
        user_agent=row["user_agent"],
        origin=row["origin"],
        referer=row["referer"],
        page_url=row["page_url"],
        geo_provider=row["geo_provider"],
        geo_status=row["geo_status"],
        country=row["country"],
        country_code=row["country_code"],
        region=row["region"],
        city=row["city"],
        latitude=row["latitude"],
        longitude=row["longitude"],
        idempotency_key=row["idempotency_key"],
        created_at=row["created_at"],
    )


def to_job(row: Any) -> Job:
    return Job(
        id=str(row["id"]),
        type=row["type"],
        payload=row["payload"] or {},
        status=row["status"],
        attempts=row["attempts"],
        max_attempts=row["max_attempts"],
        run_at=row["run_at"],
        last_error=row["last_error"],
        created_at=row["created_at"],
    )


def field_to_json(field: WidgetField) -> dict[str, Any]:
    """Widget config is served to browsers, where camelCase is the convention —
    and the widget bundle reads `maxLength`. Stored in that shape so the public
    config endpoint is a straight passthrough."""
    out: dict[str, Any] = {
        "name": field.name,
        "label": field.label,
        "type": field.type,
        "required": field.required,
    }
    if field.placeholder is not None:
        out["placeholder"] = field.placeholder
    if field.options is not None:
        out["options"] = field.options
    if field.max_length is not None:
        out["maxLength"] = field.max_length
    return out


def display_to_json(display: WidgetDisplay) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if display.position is not None:
        out["position"] = display.position
    if display.theme is not None:
        out["theme"] = display.theme
    if display.accent_color is not None:
        out["accentColor"] = display.accent_color
    if display.delay_seconds is not None:
        out["delaySeconds"] = display.delay_seconds
    return out
