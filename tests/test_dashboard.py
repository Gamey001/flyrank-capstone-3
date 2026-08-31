from httpx import AsyncClient

from app.db import pool
from tests.conftest import create_widget, register_tenant, valid_submission


class TestDashboardAggregation:
    async def test_reports_totals_timeseries_per_widget_and_geo(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        newsletter = await create_widget(client, tenant, name="Newsletter")
        contact = await create_widget(client, tenant, name="Contact")

        for i in range(3):
            await client.post(
                "/api/public/submissions",
                json=valid_submission(
                    newsletter["publicId"],
                    data={"email": f"a{i}@example.com", "consent": True},
                ),
            )
        await client.post("/api/public/submissions", json=valid_submission(contact["publicId"]))
        await client.post(
            "/api/public/submissions",
            json=valid_submission(
                newsletter["publicId"],
                data={
                    "email": "bot@spam.test",
                    "consent": True,
                    "company_website": "http://spam.example",
                },
            ),
        )

        # Give two rows a country so the geo breakdown has something to group on.
        await pool.execute(
            """UPDATE submissions
                  SET country = 'Germany', country_code = 'DE',
                      geo_status = 'enriched', geo_provider = 'mock-a'
                WHERE id IN (SELECT id FROM submissions WHERE status = 'stored' LIMIT 2)"""
        )

        response = await client.get("/api/dashboard/stats?days=7", headers=tenant.auth)
        body = response.json()

        assert body["totals"] == {
            "submissions": 5,
            "stored": 4,
            "spam": 1,
            "enriched": 2,
            "last24h": 5,
        }
        assert len(body["timeseries"]) == 1
        assert body["timeseries"][0]["stored"] == 4
        assert body["timeseries"][0]["spam"] == 1

        by_name = {row["name"]: row["stored"] for row in body["widgets"]}
        assert by_name == {"Newsletter": 3, "Contact": 1}

        assert {"countryCode": "DE", "country": "Germany", "submissions": 2} in body["geo"]

    async def test_includes_a_widget_with_no_submissions(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        await create_widget(client, tenant, name="Brand new")

        body = (await client.get("/api/dashboard/stats", headers=tenant.auth)).json()
        assert body["widgets"] == [
            {
                "widgetId": body["widgets"][0]["widgetId"],
                "name": "Brand new",
                "publicId": body["widgets"][0]["publicId"],
                "stored": 0,
                "spam": 0,
                "lastSubmissionAt": None,
            }
        ]

    async def test_supports_hourly_granularity(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)
        await client.post("/api/public/submissions", json=valid_submission(widget["publicId"]))

        body = (
            await client.get("/api/dashboard/stats?days=1&granularity=hour", headers=tenant.auth)
        ).json()
        assert body["window"]["granularity"] == "hour"
        assert len(body["timeseries"]) == 1

    async def test_rejects_nonsense_query_parameters(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        for query in [
            "/api/dashboard/stats?days=0",
            "/api/dashboard/stats?granularity=century",
            "/api/dashboard/submissions?from=2026-02-01&to=2026-01-01",
            "/api/dashboard/submissions?limit=9999",
        ]:
            response = await client.get(query, headers=tenant.auth)
            assert response.status_code == 422, query

    async def test_paginates_and_filters(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)
        for i in range(5):
            await client.post(
                "/api/public/submissions",
                json=valid_submission(
                    widget["publicId"], data={"email": f"p{i}@example.com", "consent": True}
                ),
            )

        page = await client.get("/api/dashboard/submissions?limit=2&offset=0", headers=tenant.auth)
        assert len(page.json()["submissions"]) == 2
        assert page.json()["pagination"] == {"total": 5, "limit": 2, "offset": 0}

        filtered = await client.get(
            f"/api/dashboard/submissions?widgetId={widget['id']}&status=stored",
            headers=tenant.auth,
        )
        assert filtered.json()["pagination"]["total"] == 5

    async def test_never_caches_a_dashboard_response(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        response = await client.get("/api/dashboard/stats", headers=tenant.auth)
        assert response.headers["cache-control"] == "private, no-store"

    async def test_fetches_a_single_submission(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)
        created = await client.post(
            "/api/public/submissions", json=valid_submission(widget["publicId"])
        )

        response = await client.get(
            f"/api/dashboard/submissions/{created.json()['id']}", headers=tenant.auth
        )
        assert response.status_code == 200
        assert response.json()["submission"]["id"] == created.json()["id"]


class TestServiceSurface:
    async def test_liveness_and_readiness(self, client: AsyncClient) -> None:
        assert (await client.get("/healthz")).status_code == 200
        ready = await client.get("/readyz")
        assert ready.status_code == 200
        assert ready.json()["status"] == "ready"
        assert ready.json()["database"] == "ok"

    async def test_unknown_route_is_json_404(self, client: AsyncClient) -> None:
        response = await client.get("/no/such/route")
        assert response.status_code == 404
        assert "application/json" in response.headers["content-type"]
        assert response.json()["error"]["code"] == "not_found"

    async def test_openapi_schema_is_served(self, client: AsyncClient) -> None:
        # FastAPI generates this; the README points evaluators at /docs.
        response = await client.get("/openapi.json")
        assert response.status_code == 200
        paths = response.json()["paths"]
        assert "/api/public/submissions" in paths
        assert "/api/widgets" in paths
