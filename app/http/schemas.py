import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.http.types import Email

# This name becomes an HTML input name, a JSON key and a dashboard column
# header, so it is restricted to what is safe in all three.
_FIELD_NAME = re.compile(r"^[a-z][a-z0-9_]*$", re.I)
_HEX_COLOUR = re.compile(r"^#(?:[0-9a-f]{3}|[0-9a-f]{6})$", re.I)
_ORIGIN = re.compile(r"^https?://[^/]+$", re.I)
_PUBLIC_ID = re.compile(r"^[a-z0-9]+$", re.I)


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# --- auth ------------------------------------------------------------------


class RegisterRequest(Strict):
    email: Email
    name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=12, max_length=200)


class LoginRequest(Strict):
    email: Email
    password: str = Field(min_length=1, max_length=200)


# --- widgets ---------------------------------------------------------------


class WidgetFieldIn(Strict):
    name: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    type: Literal["text", "email", "tel", "textarea", "select", "checkbox"]
    required: bool = False
    placeholder: str | None = Field(default=None, max_length=160)
    options: list[str] | None = Field(default=None, max_length=50)
    maxLength: int | None = Field(default=None, ge=1, le=5000)  # noqa: N815 — public JSON shape

    @field_validator("name")
    @classmethod
    def _valid_name(cls, value: str) -> str:
        if not _FIELD_NAME.match(value):
            raise ValueError(
                "Field names must start with a letter and contain only letters, digits and _"
            )
        return value

    @model_validator(mode="after")
    def _select_needs_options(self) -> "WidgetFieldIn":
        if self.type == "select" and not self.options:
            raise ValueError("A select field needs at least one option")
        return self


class WidgetDisplayIn(Strict):
    position: Literal["inline", "bottom-right", "bottom-left"] | None = None
    theme: Literal["light", "dark"] | None = None
    accentColor: str | None = None  # noqa: N815 — public JSON shape
    delaySeconds: int | None = Field(default=None, ge=0, le=120)  # noqa: N815

    @field_validator("accentColor")
    @classmethod
    def _valid_colour(cls, value: str | None) -> str | None:
        if value is not None and not _HEX_COLOUR.match(value):
            raise ValueError("accentColor must be a hex colour like #4f46e5")
        return value


def _validate_origins(value: list[str] | None) -> list[str] | None:
    if value is None:
        return None
    for entry in value:
        if entry != "*" and not _ORIGIN.match(entry):
            raise ValueError(
                "Each origin must be a scheme + host + optional port, with no path "
                "(e.g. https://example.com)"
            )
    return value


def _validate_http_url(value: str | None) -> str | None:
    # The server fetches this URL, so other schemes would let a tenant point it
    # at something it should not reach.
    if value is not None and not re.match(r"^https?://", value, re.I):
        raise ValueError("Must be an http(s) URL")
    return value


class WidgetCreate(Strict):
    name: str = Field(min_length=1, max_length=120)
    type: Literal["signup_form", "contact_form", "cta_popover"]
    title: str = Field(min_length=1, max_length=160)
    fields: list[WidgetFieldIn] = Field(min_length=1, max_length=25)
    status: Literal["active", "paused"] | None = None
    description: str | None = Field(default=None, max_length=500)
    buttonText: str | None = Field(default=None, min_length=1, max_length=60)  # noqa: N815
    successMessage: str | None = Field(default=None, min_length=1, max_length=300)  # noqa: N815
    display: WidgetDisplayIn | None = None
    honeypotField: str | None = Field(default=None, max_length=64)  # noqa: N815
    allowedOrigins: list[str] | None = Field(default=None, max_length=50)  # noqa: N815
    webhookUrl: str | None = Field(default=None, max_length=2048)  # noqa: N815
    notifyEmail: Email | None = None  # noqa: N815

    _check_origins = field_validator("allowedOrigins")(
        classmethod(lambda cls, v: _validate_origins(v))
    )
    _check_url = field_validator("webhookUrl")(classmethod(lambda cls, v: _validate_http_url(v)))

    @model_validator(mode="after")
    def _cross_field(self) -> "WidgetCreate":
        names = [f.name for f in self.fields]
        if len(set(names)) != len(names):
            raise ValueError("Field names must be unique")
        # A honeypot sharing a real field's name would be stripped before
        # storage, silently discarding the visitor's answer.
        if (self.honeypotField or "company_website") in names:
            raise ValueError("The honeypot field name must not collide with a real field")
        return self


class WidgetUpdate(Strict):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    type: Literal["signup_form", "contact_form", "cta_popover"] | None = None
    title: str | None = Field(default=None, min_length=1, max_length=160)
    fields: list[WidgetFieldIn] | None = Field(default=None, min_length=1, max_length=25)
    status: Literal["active", "paused"] | None = None
    description: str | None = Field(default=None, max_length=500)
    buttonText: str | None = Field(default=None, min_length=1, max_length=60)  # noqa: N815
    successMessage: str | None = Field(default=None, min_length=1, max_length=300)  # noqa: N815
    display: WidgetDisplayIn | None = None
    honeypotField: str | None = Field(default=None, max_length=64)  # noqa: N815
    allowedOrigins: list[str] | None = Field(default=None, max_length=50)  # noqa: N815
    webhookUrl: str | None = Field(default=None, max_length=2048)  # noqa: N815
    notifyEmail: Email | None = None  # noqa: N815

    _check_origins = field_validator("allowedOrigins")(
        classmethod(lambda cls, v: _validate_origins(v))
    )
    _check_url = field_validator("webhookUrl")(classmethod(lambda cls, v: _validate_http_url(v)))

    @model_validator(mode="after")
    def _cross_field(self) -> "WidgetUpdate":
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to update")
        if self.fields is not None:
            names = [f.name for f in self.fields]
            if len(set(names)) != len(names):
                raise ValueError("Field names must be unique")
            if (self.honeypotField or "company_website") in names:
                raise ValueError("The honeypot field name must not collide with a real field")
        return self


# --- public submission -----------------------------------------------------

SubmissionValue = Annotated[str | bool | int | float, Field(union_mode="left_to_right")]


class SubmissionRequest(Strict):
    """The envelope only. `data`'s contents are validated separately against the
    widget's own field definitions, once the widget has been loaded."""

    widgetId: str = Field(min_length=8, max_length=64)  # noqa: N815
    data: dict[str, SubmissionValue]
    elapsedMs: int | None = Field(default=None, ge=0, le=86_400_000)  # noqa: N815
    pageUrl: str | None = Field(default=None, max_length=2048)  # noqa: N815

    @field_validator("widgetId")
    @classmethod
    def _valid_public_id(cls, value: str) -> str:
        if not _PUBLIC_ID.match(value):
            raise ValueError("widgetId is not a valid public widget id")
        return value

    @field_validator("data")
    @classmethod
    def _bounded(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(value) > 60:
            raise ValueError("Too many fields in the submission")
        for item in value.values():
            if isinstance(item, str) and len(item) > 5000:
                raise ValueError("A field exceeds the maximum length")
        return value
