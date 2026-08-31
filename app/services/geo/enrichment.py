import asyncio
from typing import Any

from app.config.settings import settings
from app.domain.models import GeoResult
from app.lib.logging import logger
from app.lib.net import is_private_ip
from app.services.geo.providers import PROVIDER_REGISTRY


def _no_geo(status: str, provider: str = "none") -> GeoResult:
    return GeoResult(provider=provider, status=status)  # type: ignore[arg-type]


def resolve_provider_chain(names: list[str]) -> list[Any]:
    chain = []
    for name in names:
        provider = PROVIDER_REGISTRY.get(name)
        if provider is None:
            logger.warning("unknown geo provider in GEO_PROVIDERS, skipping", provider=name)
            continue
        chain.append(provider)
    return chain


# Never raises. Every failure mode — provider down, timeout, garbage response,
# nothing configured — resolves to `status: 'unavailable'` so a caller can store
# the submission regardless. Callers rely on this; do not add a raise.
async def enrich_with_geo(
    ip: str | None,
    *,
    providers: list[Any] | None = None,
    force_down: list[str] | None = None,
    timeout_ms: int | None = None,
) -> GeoResult:
    if not ip or is_private_ip(ip):
        return _no_geo("skipped")

    down = set(settings.geo_force_down if force_down is None else force_down)
    deadline_ms = timeout_ms if timeout_ms is not None else settings.GEO_TIMEOUT_MS
    chain = resolve_provider_chain(settings.geo_providers) if providers is None else providers

    if not chain:
        return _no_geo("unavailable")

    failures: list[dict[str, str]] = []

    for provider in chain:
        if provider.name in down:
            failures.append({"provider": provider.name, "error": "forced down via GEO_FORCE_DOWN"})
            continue
        try:
            location = await asyncio.wait_for(
                provider.lookup(ip, deadline_ms), timeout=deadline_ms / 1000
            )
            if failures:
                logger.info(
                    "geo enrichment recovered via fallback provider",
                    provider=provider.name,
                    failures=failures,
                )
            return GeoResult(provider=provider.name, status="enriched", **location)
        except TimeoutError:
            failures.append(
                {"provider": provider.name, "error": f"timed out after {deadline_ms}ms"}
            )
        except Exception as exc:
            failures.append({"provider": provider.name, "error": str(exc)})

    logger.warning(
        "geo enrichment unavailable; storing submission without geo data", failures=failures
    )
    return _no_geo("unavailable")
