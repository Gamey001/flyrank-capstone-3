from typing import Any

import httpx

from app.services.geo.provider import GeoLookup


class IpApiProvider:
    """ip-api.com — free, no key, 45 requests/minute.

    Answers 200 with `{"status":"fail"}` rather than an HTTP error status, so
    the body has to be inspected and not just the status code.
    """

    name = "ip-api"

    async def lookup(self, ip: str, timeout_ms: int) -> GeoLookup:
        url = (
            f"http://ip-api.com/json/{ip}"
            "?fields=status,message,country,countryCode,regionName,city,lat,lon"
        )
        async with httpx.AsyncClient(timeout=timeout_ms / 1000) as client:
            response = await client.get(url, headers={"accept": "application/json"})
        response.raise_for_status()
        body: dict[str, Any] = response.json()
        if body.get("status") != "success":
            raise RuntimeError(f"ip-api lookup failed: {body.get('message', 'unknown reason')}")
        return GeoLookup(
            country=body.get("country"),
            country_code=body.get("countryCode"),
            region=body.get("regionName"),
            city=body.get("city"),
            latitude=body.get("lat"),
            longitude=body.get("lon"),
        )


class IpapiCoProvider:
    name = "ipapi-co"

    async def lookup(self, ip: str, timeout_ms: int) -> GeoLookup:
        async with httpx.AsyncClient(timeout=timeout_ms / 1000) as client:
            response = await client.get(
                f"https://ipapi.co/{ip}/json/", headers={"accept": "application/json"}
            )
        response.raise_for_status()
        body: dict[str, Any] = response.json()
        if body.get("error"):
            raise RuntimeError(f"ipapi.co lookup failed: {body.get('reason', 'unknown reason')}")
        return GeoLookup(
            country=body.get("country_name"),
            country_code=body.get("country_code"),
            region=body.get("region"),
            city=body.get("city"),
            latitude=body.get("latitude"),
            longitude=body.get("longitude"),
        )


class MockProvider:
    """Deterministic stand-in for the fallback proof: a demonstration that
    depends on a third party actually being down is a coin flip, not a proof."""

    def __init__(self, name: str, location: GeoLookup) -> None:
        self.name = name
        self._location = location

    async def lookup(self, ip: str, timeout_ms: int) -> GeoLookup:
        return self._location


MOCK_A = MockProvider(
    "mock-a",
    GeoLookup(
        country="Germany",
        country_code="DE",
        region="Berlin",
        city="Berlin",
        latitude=52.52,
        longitude=13.405,
    ),
)

MOCK_B = MockProvider(
    "mock-b",
    GeoLookup(
        country="Portugal",
        country_code="PT",
        region="Lisboa",
        city="Lisbon",
        latitude=38.7223,
        longitude=-9.1393,
    ),
)

PROVIDER_REGISTRY: dict[str, Any] = {
    "ip-api": IpApiProvider(),
    "ipapi-co": IpapiCoProvider(),
    "mock-a": MOCK_A,
    "mock-b": MOCK_B,
}
