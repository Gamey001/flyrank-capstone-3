"""Validation for the *contents* of a submission.

The envelope (widgetId, data, elapsedMs, pageUrl) is a static shape and is
validated by a Pydantic model. What is inside `data` is not: each tenant defines
their own fields, so the rules come from database rows at request time.

This module walks those definitions explicitly rather than building a Pydantic
model per widget with `create_model`. Two reasons: the error messages are part
of the public API contract and are easier to state directly, and a per-request
generated model would need caching and invalidating on every widget revision.
"""

import re
from typing import Any, NamedTuple

from app.domain.models import Widget, WidgetField

DEFAULT_MAX_FIELD_LENGTH = 2_000
TEXTAREA_MAX_LENGTH = 5_000
EMAIL_MAX_LENGTH = 320

_EMAIL = re.compile(r"^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$")
_TEL = re.compile(r"^[+()\-.\s\d]{5,40}$")


class FieldIssue(NamedTuple):
    path: str
    message: str


class ValidationOutcome(NamedTuple):
    ok: bool
    data: dict[str, Any]
    issues: list[FieldIssue]


def _max_length(field: WidgetField) -> int:
    if field.max_length is not None:
        return field.max_length
    return TEXTAREA_MAX_LENGTH if field.type == "textarea" else DEFAULT_MAX_FIELD_LENGTH


def _validate_one(field: WidgetField, raw: Any) -> tuple[Any, str | None]:
    # An unticked box posts `false`, not nothing, so a required consent checkbox
    # has to demand `true` specifically rather than merely being present.
    if field.type == "checkbox":
        if not isinstance(raw, bool):
            return None, f"{field.label} must be true or false"
        if field.required and raw is not True:
            return None, f"{field.label} is required"
        return raw, None

    if isinstance(raw, bool):
        return None, f"{field.label} must be text"
    if isinstance(raw, int | float):
        raw = str(raw)
    if not isinstance(raw, str):
        return None, f"{field.label} must be text"

    value = raw.strip()

    # Browsers post an untouched input as "", so without this an optional email
    # left blank would fail the email check.
    if value == "":
        if field.required:
            return None, f"{field.label} is required"
        return None, None  # dropped from the stored payload

    if field.type == "select":
        if field.options and value not in field.options:
            return None, f"Must be one of: {', '.join(field.options)}"
        return value, None

    if field.type == "email":
        if len(value) > EMAIL_MAX_LENGTH:
            return None, f"Must be at most {EMAIL_MAX_LENGTH} characters"
        if not _EMAIL.match(value):
            return None, "Must be a valid email address"
        return value.lower(), None

    if field.type == "tel":
        if not _TEL.match(value):
            return None, "Must be a valid phone number"
        return value, None

    limit = _max_length(field)
    if len(value) > limit:
        return None, f"Must be at most {limit} characters"
    return value, None


def validate_submission(widget: Widget, payload: dict[str, Any]) -> ValidationOutcome:
    issues: list[FieldIssue] = []
    clean: dict[str, Any] = {}
    known = {field.name for field in widget.fields} | {widget.honeypot_field}

    # Strict: a payload carrying keys the widget never declared is rejected, not
    # quietly stored. Without this a public endpoint accepts arbitrary JSON.
    unexpected = sorted(set(payload) - known)
    if unexpected:
        quoted = ", ".join(f"'{key}'" for key in unexpected)
        issues.append(FieldIssue("", f"Unrecognized key(s) in object: {quoted}"))

    for field in widget.fields:
        present = field.name in payload
        if not present:
            if field.required:
                issues.append(FieldIssue(field.name, f"{field.label} is required"))
            continue

        value, error = _validate_one(field, payload[field.name])
        if error is not None:
            issues.append(FieldIssue(field.name, error))
        elif value is not None:
            clean[field.name] = value

    # Accepted so a bot can fill it; the caller strips it before storage.
    honeypot = payload.get(widget.honeypot_field)
    if honeypot is not None:
        if not isinstance(honeypot, str) or len(honeypot) > 500:
            issues.append(FieldIssue(widget.honeypot_field, "Invalid value"))
        else:
            clean[widget.honeypot_field] = honeypot

    return ValidationOutcome(not issues, clean, issues)
