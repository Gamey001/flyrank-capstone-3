from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

WidgetType = Literal["signup_form", "contact_form", "cta_popover"]
WidgetStatus = Literal["active", "paused"]
SubmissionStatus = Literal["stored", "spam"]
JobStatus = Literal["pending", "running", "succeeded", "failed", "dead"]
FieldType = Literal["text", "email", "tel", "textarea", "select", "checkbox"]
GeoStatus = Literal["enriched", "unavailable", "skipped"]


class ApiModel(BaseModel):
    """Serialises to camelCase, which is the public JSON contract, while the
    Python attributes stay snake_case. `populate_by_name` lets constructors keep
    using the Python names."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Tenant(ApiModel):
    id: str
    email: str
    name: str
    created_at: datetime


class TenantWithSecret(Tenant):
    password_hash: str


class WidgetField(ApiModel):
    name: str
    label: str
    type: FieldType
    required: bool = False
    placeholder: str | None = None
    options: list[str] | None = None
    max_length: int | None = None


class WidgetDisplay(ApiModel):
    position: Literal["inline", "bottom-right", "bottom-left"] | None = None
    theme: Literal["light", "dark"] | None = None
    accent_color: str | None = None
    delay_seconds: int | None = None


class Widget(ApiModel):
    id: str
    tenant_id: str
    public_id: str
    name: str
    type: WidgetType
    status: WidgetStatus
    title: str
    description: str | None
    button_text: str
    success_message: str
    fields: list[WidgetField]
    display: WidgetDisplay
    honeypot_field: str
    allowed_origins: list[str]
    webhook_url: str | None
    notify_email: str | None
    revision: int
    created_at: datetime
    updated_at: datetime


class GeoResult(ApiModel):
    provider: str
    status: GeoStatus
    country: str | None = None
    country_code: str | None = None
    region: str | None = None
    city: str | None = None
    latitude: float | None = None
    longitude: float | None = None


class Submission(ApiModel):
    id: str
    widget_id: str
    tenant_id: str
    status: SubmissionStatus
    spam_reason: str | None
    data: dict[str, Any]
    email: str | None
    ip_address: str | None
    user_agent: str | None
    origin: str | None
    referer: str | None
    page_url: str | None
    geo_provider: str | None
    geo_status: str
    country: str | None
    country_code: str | None
    region: str | None
    city: str | None
    latitude: float | None
    longitude: float | None
    idempotency_key: str | None
    created_at: datetime


class Job(ApiModel):
    id: str
    type: str
    payload: dict[str, Any]
    status: JobStatus
    attempts: int
    max_attempts: int
    run_at: datetime
    last_error: str | None
    created_at: datetime
