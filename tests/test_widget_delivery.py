from httpx import AsyncClient

from app.services import widget_asset
from tests.conftest import create_widget, register_tenant


class TestWidgetManagement:
    async def test_create_returns_paste_ready_snippet(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        response = await client.post(
            "/api/widgets",
            headers=tenant.auth,
            json={
                "name": "Newsletter",
                "type": "signup_form",
                "title": "Join the list",
                "fields": [{"name": "email", "label": "Email", "type": "email", "required": True}],
            },
        )
        assert response.status_code == 201
        widget = response.json()["widget"]

        assert len(widget["publicId"]) == 16
        assert widget["publicId"].isalnum()
        assert widget["embed"]["snippet"] == (
            f'<script src="{widget["embed"]["scriptUrl"]}" async></script>'
        )
        assert (
            f"/embed/{widget_asset.VERSION}/widget.js?id={widget['publicId']}"
            in widget["embed"]["scriptUrl"]
        )

    async def test_rejects_invalid_definition_with_field_paths(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        response = await client.post(
            "/api/widgets",
            headers=tenant.auth,
            json={"name": "", "type": "not_a_type", "title": "x", "fields": []},
        )
        assert response.status_code == 422
        paths = {issue["path"] for issue in response.json()["error"]["details"]}
        assert {"name", "type", "fields"} <= paths

    async def test_rejects_honeypot_colliding_with_real_field(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        response = await client.post(
            "/api/widgets",
            headers=tenant.auth,
            json={
                "name": "Bad",
                "type": "signup_form",
                "title": "Bad",
                "honeypotField": "email",
                "fields": [{"name": "email", "label": "Email", "type": "email", "required": True}],
            },
        )
        assert response.status_code == 422

    async def test_rejects_duplicate_field_names(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        response = await client.post(
            "/api/widgets",
            headers=tenant.auth,
            json={
                "name": "Dup",
                "type": "signup_form",
                "title": "Dup",
                "fields": [
                    {"name": "email", "label": "A", "type": "email"},
                    {"name": "email", "label": "B", "type": "text"},
                ],
            },
        )
        assert response.status_code == 422

    async def test_update_bumps_revision_and_delete_is_soft(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)

        updated = await client.patch(
            f"/api/widgets/{widget['id']}", headers=tenant.auth, json={"title": "New title"}
        )
        assert updated.status_code == 200
        assert updated.json()["widget"]["revision"] == 2
        assert updated.json()["widget"]["title"] == "New title"

        assert (
            await client.delete(f"/api/widgets/{widget['id']}", headers=tenant.auth)
        ).status_code == 204
        assert (
            await client.get(f"/api/widgets/{widget['id']}", headers=tenant.auth)
        ).status_code == 404
        assert (
            await client.get(f"/api/public/widgets/{widget['publicId']}/config")
        ).status_code == 404

    async def test_empty_patch_rejected(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)
        response = await client.patch(f"/api/widgets/{widget['id']}", headers=tenant.auth, json={})
        assert response.status_code == 422


class TestWidgetDelivery:
    async def test_versioned_bundle_is_immutable(self, client: AsyncClient) -> None:
        response = await client.get(f"/embed/{widget_asset.VERSION}/widget.js")
        assert response.status_code == 200
        assert "application/javascript" in response.headers["content-type"]
        assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
        assert response.headers["x-widget-version"] == widget_asset.VERSION
        assert "flyrank" in response.text

    async def test_outdated_version_redirects_preserving_id(self, client: AsyncClient) -> None:
        response = await client.get("/embed/v0000deadbeef/widget.js?id=abc123")
        assert response.status_code == 302
        assert response.headers["location"] == f"{widget_asset.VERSIONED_PATH}?id=abc123"

    async def test_unversioned_bundle_has_short_cache(self, client: AsyncClient) -> None:
        response = await client.get("/widget.js")
        assert response.status_code == 200
        assert (
            response.headers["cache-control"] == "public, max-age=300, stale-while-revalidate=600"
        )

    async def test_config_is_small_cached_and_leaks_nothing(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(
            client,
            tenant,
            webhookUrl="https://example.com/hook",
            notifyEmail="leads@example.test",
        )

        response = await client.get(
            f"/api/public/widgets/{widget['publicId']}/config",
            headers={"origin": "http://localhost:5500"},
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "public, max-age=60, stale-while-revalidate=300"
        assert response.headers["etag"].startswith('"')
        assert response.headers["access-control-allow-origin"] == "*"
        assert response.headers["vary"] == "Origin"

        body = response.json()
        # None of this may reach a page on someone else's website.
        assert "tenantId" not in body
        assert "webhookUrl" not in body
        assert "notifyEmail" not in body
        assert body["honeypotField"] == "company_website"
        assert len(response.text) < 2048

    async def test_conditional_request_returns_304(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)

        first = await client.get(f"/api/public/widgets/{widget['publicId']}/config")
        revalidated = await client.get(
            f"/api/public/widgets/{widget['publicId']}/config",
            headers={"if-none-match": first.headers["etag"]},
        )
        assert revalidated.status_code == 304
        assert revalidated.text == ""

    async def test_etag_changes_when_widget_changes(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)

        before = await client.get(f"/api/public/widgets/{widget['publicId']}/config")
        await client.patch(
            f"/api/widgets/{widget['id']}", headers=tenant.auth, json={"title": "Changed"}
        )
        after = await client.get(f"/api/public/widgets/{widget['publicId']}/config")

        assert after.headers["etag"] != before.headers["etag"]

    async def test_paused_widget_is_not_served(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)
        await client.patch(
            f"/api/widgets/{widget['id']}", headers=tenant.auth, json={"status": "paused"}
        )
        assert (
            await client.get(f"/api/public/widgets/{widget['publicId']}/config")
        ).status_code == 404
