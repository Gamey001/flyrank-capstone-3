import asyncio

from httpx import AsyncClient

from app.config.settings import settings
from app.db import pool
from tests.conftest import create_widget, register_tenant, valid_submission


class TestCors:
    async def test_preflight_advertises_what_the_widget_uses(self, client: AsyncClient) -> None:
        response = await client.request(
            "OPTIONS",
            "/api/public/submissions",
            headers={
                "origin": "https://a-customer-site.example",
                "access-control-request-method": "POST",
                "access-control-request-headers": "content-type,idempotency-key",
            },
        )
        assert response.status_code == 204
        assert response.headers["access-control-allow-origin"] == "*"
        assert "POST" in response.headers["access-control-allow-methods"]
        assert "idempotency-key" in response.headers["access-control-allow-headers"]
        # Without a max-age the browser re-preflights before every submission.
        assert int(response.headers["access-control-max-age"]) > 0

    async def test_post_allowed_from_an_origin_never_seen(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)

        response = await client.post(
            "/api/public/submissions",
            headers={"origin": "https://some-random-customer.example"},
            json=valid_submission(widget["publicId"]),
        )
        assert response.status_code == 202
        assert response.headers["access-control-allow-origin"] == "*"

    async def test_admin_api_is_restricted_to_configured_origins(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        allowed = await client.get(
            "/api/widgets",
            headers={**tenant.auth, "origin": settings.admin_cors_origins[0]},
        )
        assert allowed.status_code == 200

        refused = await client.get(
            "/api/widgets", headers={**tenant.auth, "origin": "https://evil.example"}
        )
        assert refused.status_code == 403


class TestStoringSubmissions:
    async def test_stores_against_right_widget_and_tenant(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)

        response = await client.post(
            "/api/public/submissions",
            headers={"origin": "http://localhost:5500"},
            json=valid_submission(widget["publicId"], pageUrl="http://localhost:5500/pricing"),
        )
        assert response.status_code == 202
        assert response.json()["ok"] is True
        assert response.headers["cache-control"] == "no-store"

        listed = await client.get("/api/dashboard/submissions", headers=tenant.auth)
        rows = listed.json()["submissions"]
        assert len(rows) == 1
        assert rows[0]["widgetId"] == widget["id"]
        assert rows[0]["tenantId"] == tenant.id
        assert rows[0]["status"] == "stored"
        assert rows[0]["pageUrl"] == "http://localhost:5500/pricing"
        assert rows[0]["data"] == {"email": "visitor@example.com", "consent": True}

    async def test_normalises_what_it_stores(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(
            client,
            tenant,
            fields=[
                {"name": "email", "label": "Email", "type": "email", "required": True},
                {"name": "note", "label": "Note", "type": "textarea"},
            ],
        )

        await client.post(
            "/api/public/submissions",
            json={
                "widgetId": widget["publicId"],
                "data": {"email": "  Visitor@EXAMPLE.com  ", "note": "  hi  "},
            },
        )

        rows = (await client.get("/api/dashboard/submissions", headers=tenant.auth)).json()[
            "submissions"
        ]
        assert rows[0]["data"] == {"email": "visitor@example.com", "note": "hi"}
        assert rows[0]["email"] == "visitor@example.com"


class TestBoundaryValidation:
    async def test_malformed_json_is_400(self, client: AsyncClient) -> None:
        response = await client.post(
            "/api/public/submissions",
            headers={"content-type": "application/json"},
            content='{"widgetId": ',
        )
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "bad_request"
        assert "requestId" in response.json()["error"]

    async def test_oversized_payload_is_413(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)

        response = await client.post(
            "/api/public/submissions",
            headers={"content-type": "application/json"},
            json={
                "widgetId": widget["publicId"],
                "data": {
                    "email": "v@example.com",
                    "consent": True,
                    "note": "x" * settings.SUBMISSION_BODY_LIMIT_BYTES,
                },
            },
        )
        assert response.status_code == 413
        assert response.json()["error"]["code"] == "payload_too_large"

    async def test_rejects_undeclared_fields(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)

        response = await client.post(
            "/api/public/submissions",
            json=valid_submission(
                widget["publicId"],
                data={"email": "v@example.com", "consent": True, "is_admin": "yes"},
            ),
        )
        assert response.status_code == 422
        assert "unrecognized key" in response.json()["error"]["details"][0]["message"].lower()

    async def test_reports_every_invalid_field_at_once(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)

        response = await client.post(
            "/api/public/submissions",
            json={"widgetId": widget["publicId"], "data": {"email": "nope", "consent": False}},
        )
        assert response.status_code == 422
        details = response.json()["error"]["details"]
        assert {"path": "email", "message": "Must be a valid email address"} in details
        assert {"path": "consent", "message": "I agree is required"} in details

    async def test_unknown_widget_is_404(self, client: AsyncClient) -> None:
        response = await client.post(
            "/api/public/submissions", json=valid_submission("doesnotexist1234")
        )
        assert response.status_code == 404

    async def test_unparseable_widget_id_rejected_before_any_query(
        self, client: AsyncClient
    ) -> None:
        response = await client.post("/api/public/submissions", json=valid_submission("!!"))
        assert response.status_code == 422

    async def test_enforces_origin_allow_list(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant, allowedOrigins=["https://acme.example"])

        refused = await client.post(
            "/api/public/submissions",
            headers={"origin": "https://not-acme.example"},
            json=valid_submission(widget["publicId"]),
        )
        assert refused.status_code == 403

        allowed = await client.post(
            "/api/public/submissions",
            headers={"origin": "https://acme.example"},
            json=valid_submission(widget["publicId"]),
        )
        assert allowed.status_code == 202


class TestSpamControls:
    async def test_filled_honeypot_is_dropped_silently(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)

        response = await client.post(
            "/api/public/submissions",
            json=valid_submission(
                widget["publicId"],
                data={
                    "email": "bot@spam.test",
                    "consent": True,
                    "company_website": "http://spam.example",
                },
            ),
        )
        # A bot must not be able to tell it was caught: same status, same shape.
        assert response.status_code == 202
        assert response.json()["ok"] is True

        stored = await client.get("/api/dashboard/submissions?status=stored", headers=tenant.auth)
        assert stored.json()["submissions"] == []

        spam = await client.get("/api/dashboard/submissions?status=spam", headers=tenant.auth)
        rows = spam.json()["submissions"]
        assert len(rows) == 1
        assert rows[0]["spamReason"] == "honeypot_filled"
        assert "company_website" not in rows[0]["data"]

    async def test_flags_a_form_filled_impossibly_fast(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)

        await client.post(
            "/api/public/submissions",
            json=valid_submission(widget["publicId"], elapsedMs=40),
        )
        spam = await client.get("/api/dashboard/submissions?status=spam", headers=tenant.auth)
        assert spam.json()["submissions"][0]["spamReason"] == "submitted_too_fast"

    async def test_lets_a_human_paced_submission_through(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)

        await client.post(
            "/api/public/submissions",
            json=valid_submission(widget["publicId"], elapsedMs=9000),
        )
        stored = await client.get("/api/dashboard/submissions?status=stored", headers=tenant.auth)
        assert len(stored.json()["submissions"]) == 1


class TestIdempotency:
    async def test_retry_with_same_key_stores_one_row(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)

        first = await client.post(
            "/api/public/submissions",
            headers={"idempotency-key": "retry-me-once"},
            json=valid_submission(widget["publicId"]),
        )
        replay = await client.post(
            "/api/public/submissions",
            headers={"idempotency-key": "retry-me-once"},
            json=valid_submission(widget["publicId"]),
        )

        assert first.status_code == 202
        assert replay.status_code == 200
        assert replay.json()["id"] == first.json()["id"]
        assert replay.json()["duplicate"] is True
        assert replay.headers["idempotent-replay"] == "true"

        row = await pool.fetchrow("SELECT count(*) AS count FROM submissions")
        assert row["count"] == 1

    async def test_concurrent_retries_still_store_one_row(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)

        # The unique index is the only thing between this and five duplicate leads.
        responses = await asyncio.gather(
            *(
                client.post(
                    "/api/public/submissions",
                    headers={"idempotency-key": "concurrent-key"},
                    json=valid_submission(widget["publicId"]),
                )
                for _ in range(5)
            )
        )

        assert all(r.status_code in {200, 202} for r in responses)
        assert len({r.json()["id"] for r in responses}) == 1

        row = await pool.fetchrow("SELECT count(*) AS count FROM submissions")
        assert row["count"] == 1

    async def test_different_keys_are_different_submissions(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)

        for key in ("key-a", "key-b"):
            response = await client.post(
                "/api/public/submissions",
                headers={"idempotency-key": key},
                json=valid_submission(widget["publicId"]),
            )
            assert response.status_code == 202

        row = await pool.fetchrow("SELECT count(*) AS count FROM submissions")
        assert row["count"] == 2
