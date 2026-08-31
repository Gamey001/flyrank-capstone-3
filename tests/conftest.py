"""Shared fixtures.

These run against the real Postgres from docker-compose: unique indexes,
transactions and tenant filters are the behaviours under test, and none of them
exist in a mock.
"""

import os
from collections.abc import AsyncIterator
from typing import Any

# Set before app modules import: settings, the limiters and the mailer are all
# built at import time.
os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("LOG_LEVEL", "critical")
os.environ.setdefault("GEO_PROVIDERS", "mock-a,mock-b")
os.environ.setdefault("EMAIL_TRANSPORT", "log")
os.environ.setdefault("RUN_WORKER_IN_PROCESS", "false")
# Effectively off: every test shares one client IP, so real limits would make
# unrelated tests fail each other. The rate-limit tests set their own.
os.environ.setdefault("RATE_LIMIT_IP_MAX", "100000")
os.environ.setdefault("RATE_LIMIT_WIDGET_MAX", "100000")
# Lets a test present its own client IP, so the rate-limit tests get
# independent budgets instead of all sharing one.
os.environ.setdefault("TRUST_PROXY_HOPS", "1")

import pytest
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from app.db import pool
from app.db.migrate import run_migrations
from app.http.app import create_app
from app.http.routers import public as public_router

_SEQUENCE = 0


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(scope="session")
async def app() -> AsyncIterator[Any]:
    application = create_app()
    async with LifespanManager(application, startup_timeout=60):
        yield application


@pytest.fixture
async def client(app: Any) -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as http:
        yield http


@pytest.fixture(autouse=True)
async def reset_state(app: Any) -> AsyncIterator[None]:
    # CASCADE from tenants reaches widgets and submissions; jobs stand alone.
    await pool.execute("TRUNCATE tenants, jobs RESTART IDENTITY CASCADE")
    public_router.reset_limiters()
    yield


@pytest.fixture(scope="session", autouse=True)
async def _migrate() -> None:
    await pool.create_pool()
    await run_migrations()


class Tenant:
    def __init__(self, token: str, tenant_id: str, email: str) -> None:
        self.token = token
        self.id = tenant_id
        self.email = email

    @property
    def auth(self) -> dict[str, str]:
        return {"authorization": f"Bearer {self.token}"}


async def register_tenant(client: AsyncClient, name: str = "Test Co") -> Tenant:
    global _SEQUENCE
    _SEQUENCE += 1
    email = f"tenant-{_SEQUENCE}-{id(client)}@example.test"
    response = await client.post(
        "/api/auth/register",
        json={"email": email, "name": name, "password": "a-sufficiently-long-password"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    return Tenant(body["token"], body["tenant"]["id"], email)


def widget_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": "Newsletter",
        "type": "signup_form",
        "title": "Join the list",
        "fields": [
            {"name": "email", "label": "Email", "type": "email", "required": True},
            {"name": "consent", "label": "I agree", "type": "checkbox", "required": True},
        ],
    }
    payload.update(overrides)
    return payload


async def create_widget(client: AsyncClient, tenant: Tenant, **overrides: Any) -> dict[str, Any]:
    response = await client.post(
        "/api/widgets", headers=tenant.auth, json=widget_payload(**overrides)
    )
    assert response.status_code == 201, response.text
    return response.json()["widget"]  # type: ignore[no-any-return]


def valid_submission(public_id: str, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "widgetId": public_id,
        "data": {"email": "visitor@example.com", "consent": True},
    }
    payload.update(overrides)
    return payload
