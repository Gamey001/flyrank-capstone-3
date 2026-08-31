"""The fallback chain, proved with stub providers that answer or raise on
command: a test depending on ip-api.com actually being down would be a coin
flip, not a test."""

import asyncio
from typing import Any

from app.lib.net import is_private_ip
from app.services.geo.enrichment import enrich_with_geo
from app.services.geo.provider import GeoLookup

PUBLIC_IP = "8.8.8.8"


class Working:
    def __init__(self, name: str, city: str) -> None:
        self.name = name
        self.city = city
        self.calls = 0

    async def lookup(self, ip: str, timeout_ms: int) -> GeoLookup:
        self.calls += 1
        return GeoLookup(
            country="Testland",
            country_code="TL",
            region="Region",
            city=self.city,
            latitude=1.0,
            longitude=2.0,
        )


class Down:
    def __init__(self, name: str) -> None:
        self.name = name
        self.calls = 0

    async def lookup(self, ip: str, timeout_ms: int) -> GeoLookup:
        self.calls += 1
        raise RuntimeError(f"{self.name} is unreachable")


class Slow:
    def __init__(self, name: str, delay_seconds: float) -> None:
        self.name = name
        self.delay = delay_seconds

    async def lookup(self, ip: str, timeout_ms: int) -> GeoLookup:
        await asyncio.sleep(self.delay)
        return GeoLookup(country="Never", country_code="NV")


class TestFallbackChain:
    async def test_uses_provider_a_and_never_calls_b(self) -> None:
        a, b = Working("a", "Berlin"), Working("b", "Lisbon")
        result = await enrich_with_geo(PUBLIC_IP, providers=[a, b])

        assert result.provider == "a"
        assert result.status == "enriched"
        assert result.city == "Berlin"
        assert b.calls == 0

    async def test_falls_through_when_a_is_down(self) -> None:
        result = await enrich_with_geo(PUBLIC_IP, providers=[Down("a"), Working("b", "Lisbon")])
        assert result.provider == "b"
        assert result.status == "enriched"
        assert result.city == "Lisbon"

    async def test_still_succeeds_when_every_provider_is_down(self) -> None:
        result = await enrich_with_geo(PUBLIC_IP, providers=[Down("a"), Down("b")])
        assert result.status == "unavailable"
        assert result.country is None
        assert result.city is None

    async def test_treats_a_hung_provider_as_down(self) -> None:
        result = await enrich_with_geo(
            PUBLIC_IP, providers=[Slow("a", 5.0), Working("b", "Madrid")], timeout_ms=50
        )
        assert result.provider == "b"
        assert result.status == "enriched"

    async def test_honours_force_down(self) -> None:
        result = await enrich_with_geo(
            PUBLIC_IP,
            providers=[Working("mock-a", "Berlin"), Working("mock-b", "Lisbon")],
            force_down=["mock-a"],
        )
        assert result.provider == "mock-b"
        assert result.city == "Lisbon"

        both = await enrich_with_geo(
            PUBLIC_IP,
            providers=[Working("mock-a", "Berlin"), Working("mock-b", "Lisbon")],
            force_down=["mock-a", "mock-b"],
        )
        assert both.status == "unavailable"

    async def test_skips_addresses_no_provider_could_resolve(self) -> None:
        provider = Working("a", "Nowhere")
        for ip in [
            "127.0.0.1",
            "::1",
            "10.0.0.4",
            "192.168.1.20",
            "172.16.9.9",
            "::ffff:127.0.0.1",
            None,
        ]:
            result = await enrich_with_geo(ip, providers=[provider])
            assert result.status == "skipped", ip
        assert provider.calls == 0

    async def test_never_raises_whatever_a_provider_does(self) -> None:
        class Garbage:
            name = "garbage"

            async def lookup(self, ip: str, timeout_ms: int) -> Any:
                return "not a dict"

        assert (await enrich_with_geo(PUBLIC_IP, providers=[])).status == "unavailable"
        assert (await enrich_with_geo(PUBLIC_IP, providers=[Garbage()])).status == "unavailable"


class TestPrivateAddressDetection:
    def test_classifies_addresses_a_provider_cannot_resolve(self) -> None:
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.20.0.1",
            "192.168.0.1",
            "169.254.1.1",
            "fd00::1",
            "not-an-ip",
            # RFC 5737 documentation ranges have no public location either.
            "203.0.113.42",
            "198.51.100.1",
        ]:
            assert is_private_ip(ip) is True, ip

        for ip in ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "172.32.0.1"]:
            assert is_private_ip(ip) is False, ip
