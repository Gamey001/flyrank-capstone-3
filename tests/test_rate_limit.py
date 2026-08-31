"""The limiters are module-level state built from settings at import, so these
tests swap in tighter ones and restore them afterwards. That keeps the low
limits from leaking into any other test, and lets each scope be exercised
without the other tripping first.

Each test presents its own client IP so they get independent budgets rather than
all exhausting the shared one.
"""

from collections.abc import Iterator

import pytest
from httpx import AsyncClient

from app.http.middleware.rate_limit import FixedWindowLimiter
from app.http.routers import public as public_router
from tests.conftest import create_widget, register_tenant, valid_submission

_visitor = 0


def next_ip() -> str:
    global _visitor
    _visitor += 1
    return f"198.51.100.{_visitor % 250 + 1}"


@pytest.fixture
def tight_ip_limit() -> Iterator[None]:
    original = public_router.ip_limiter
    public_router.ip_limiter = FixedWindowLimiter(limit=5, window_seconds=60)
    yield
    public_router.ip_limiter = original


@pytest.fixture
def tight_widget_limit() -> Iterator[None]:
    original = public_router.widget_limiter
    public_router.widget_limiter = FixedWindowLimiter(limit=3, window_seconds=60)
    yield
    public_router.widget_limiter = original


class TestPerIpRateLimiting:
    async def test_burst_gets_429_and_api_keeps_serving(
        self, client: AsyncClient, tight_ip_limit: None
    ) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)
        ip = next_ip()

        statuses = []
        for i in range(12):
            response = await client.post(
                "/api/public/submissions",
                headers={"x-forwarded-for": ip},
                json=valid_submission(
                    widget["publicId"],
                    data={"email": f"burst{i}@example.com", "consent": True},
                ),
            )
            statuses.append(response.status_code)

        assert statuses[:5] == [202] * 5
        assert statuses[5:] == [429] * 7

        # The point of a limit: a flooding client must not take the API down.
        assert (await client.get("/healthz")).status_code == 200
        assert (
            await client.get(f"/api/public/widgets/{widget['publicId']}/config")
        ).status_code == 200
        assert (await client.get("/api/dashboard/stats", headers=tenant.auth)).status_code == 200

    async def test_a_different_visitor_is_unaffected(
        self, client: AsyncClient, tight_ip_limit: None
    ) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)
        flooder, bystander = next_ip(), next_ip()

        for _ in range(10):
            await client.post(
                "/api/public/submissions",
                headers={"x-forwarded-for": flooder},
                json=valid_submission(widget["publicId"]),
            )

        limited = await client.post(
            "/api/public/submissions",
            headers={"x-forwarded-for": flooder},
            json=valid_submission(widget["publicId"]),
        )
        assert limited.status_code == 429

        # A per-IP limit that punished everyone would be the denial of service it
        # is meant to prevent.
        innocent = await client.post(
            "/api/public/submissions",
            headers={"x-forwarded-for": bystander},
            json=valid_submission(widget["publicId"]),
        )
        assert innocent.status_code == 202

    async def test_tells_a_rejected_client_how_long_to_wait(
        self, client: AsyncClient, tight_ip_limit: None
    ) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)
        ip = next_ip()

        limited = None
        for _ in range(12):
            response = await client.post(
                "/api/public/submissions",
                headers={"x-forwarded-for": ip},
                json=valid_submission(widget["publicId"]),
            )
            if response.status_code == 429:
                limited = response
                break

        assert limited is not None
        assert limited.json()["error"]["code"] == "too_many_requests"
        assert limited.json()["error"]["scope"] == "ip"
        assert limited.json()["error"]["retryAfterSeconds"] > 0
        # draft-7 headers, so a well-behaved client can back off on its own.
        assert "ratelimit" in limited.headers
        assert "retry-after" in limited.headers

    async def test_preflights_do_not_spend_the_budget(
        self, client: AsyncClient, tight_ip_limit: None
    ) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)
        ip = next_ip()

        for _ in range(20):
            response = await client.request(
                "OPTIONS",
                "/api/public/submissions",
                headers={
                    "x-forwarded-for": ip,
                    "origin": "https://customer.example",
                    "access-control-request-method": "POST",
                },
            )
            assert response.status_code == 204

        response = await client.post(
            "/api/public/submissions",
            headers={"x-forwarded-for": ip},
            json=valid_submission(widget["publicId"]),
        )
        assert response.status_code == 202

    async def test_config_endpoint_is_not_rate_limited(
        self, client: AsyncClient, tight_ip_limit: None
    ) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)
        ip = next_ip()

        for _ in range(15):
            response = await client.get(
                f"/api/public/widgets/{widget['publicId']}/config",
                headers={"x-forwarded-for": ip},
            )
            assert response.status_code == 200


class TestPerWidgetRateLimiting:
    async def test_caps_a_distributed_flood_without_touching_another_widget(
        self, client: AsyncClient, tight_widget_limit: None
    ) -> None:
        tenant = await register_tenant(client)
        busy = await create_widget(client, tenant, name="Busy")
        quiet = await create_widget(client, tenant, name="Quiet")

        statuses = []
        for _ in range(6):
            # A different IP each time, so only the per-widget budget can catch this.
            response = await client.post(
                "/api/public/submissions",
                headers={"x-forwarded-for": next_ip()},
                json=valid_submission(busy["publicId"]),
            )
            statuses.append(response.status_code)

        assert statuses[:3] == [202] * 3
        assert all(status == 429 for status in statuses[3:])

        limited = await client.post(
            "/api/public/submissions",
            headers={"x-forwarded-for": next_ip()},
            json=valid_submission(busy["publicId"]),
        )
        assert limited.json()["error"]["scope"] == "widget"

        # One customer's traffic spike must not silence another customer's form.
        other = await client.post(
            "/api/public/submissions",
            headers={"x-forwarded-for": next_ip()},
            json=valid_submission(quiet["publicId"]),
        )
        assert other.status_code == 202
