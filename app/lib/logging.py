import logging
import sys
from collections.abc import Mapping, MutableMapping
from typing import Any

import structlog

from app.config.settings import settings

# Anything credential-shaped is replaced before it reaches a transport, even
# when a caller passes a whole request or config object.
_REDACTED_KEYS = frozenset(
    {
        "authorization",
        "cookie",
        "x-api-key",
        "password",
        "password_hash",
        "passwordhash",
        "jwt_secret",
        "smtp_password",
        "database_url",
        "token",
        "access_token",
    }
)


def _redact(_logger: Any, _name: str, event: MutableMapping[str, Any]) -> Mapping[str, Any]:
    def scrub(value: Any, depth: int = 0) -> Any:
        if depth > 4:
            return value
        if isinstance(value, dict):
            return {
                k: ("[redacted]" if k.lower() in _REDACTED_KEYS else scrub(v, depth + 1))
                for k, v in value.items()
            }
        if isinstance(value, list):
            return [scrub(v, depth + 1) for v in value]
        return value

    scrubbed: Mapping[str, Any] = scrub(dict(event))
    return scrubbed


def configure_logging() -> None:
    level = logging.CRITICAL if settings.is_test else getattr(logging, settings.LOG_LEVEL.upper())
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=level)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            _redact,
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str = "widget-platform") -> Any:
    return structlog.get_logger(service=name)


configure_logging()
logger = get_logger()
