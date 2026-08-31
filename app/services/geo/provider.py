from typing import Protocol, TypedDict


class GeoLookup(TypedDict, total=False):
    country: str | None
    country_code: str | None
    region: str | None
    city: str | None
    latitude: float | None
    longitude: float | None


class GeoProvider(Protocol):
    name: str

    # Raising is the contract for "unavailable": the chain catches it and moves
    # on to the next provider.
    async def lookup(self, ip: str, timeout_ms: int) -> GeoLookup: ...
