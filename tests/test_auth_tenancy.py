from httpx import AsyncClient

from tests.conftest import create_widget, register_tenant, valid_submission


class TestAuthentication:
    async def test_rejects_unauthenticated_request(self, client: AsyncClient) -> None:
        response = await client.get("/api/widgets")
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "unauthorized"

    async def test_rejects_token_signed_with_wrong_secret(self, client: AsyncClient) -> None:
        response = await client.get(
            "/api/widgets", headers={"authorization": "Bearer not.a.real.token"}
        )
        assert response.status_code == 401

    async def test_registers_then_logs_in(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        response = await client.post(
            "/api/auth/login",
            json={"email": tenant.email, "password": "a-sufficiently-long-password"},
        )
        assert response.status_code == 200
        assert isinstance(response.json()["token"], str)
        # The hash must never leave the service.
        assert "scrypt" not in response.text

    async def test_same_answer_for_wrong_password_and_unknown_account(
        self, client: AsyncClient
    ) -> None:
        unknown = await client.post(
            "/api/auth/login",
            json={"email": "nobody@example.test", "password": "a-sufficiently-long-password"},
        )
        tenant = await register_tenant(client)
        wrong = await client.post(
            "/api/auth/login",
            json={"email": tenant.email, "password": "definitely-the-wrong-one"},
        )

        assert unknown.status_code == wrong.status_code == 401
        # Identical, or login becomes an account-enumeration oracle.
        assert unknown.json()["error"]["message"] == wrong.json()["error"]["message"]

    async def test_refuses_duplicate_email(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        response = await client.post(
            "/api/auth/register",
            json={
                "email": tenant.email.upper(),
                "name": "Copy",
                "password": "a-sufficiently-long-password",
            },
        )
        assert response.status_code == 409

    async def test_short_password_rejected(self, client: AsyncClient) -> None:
        response = await client.post(
            "/api/auth/register",
            json={"email": "short@example.test", "name": "S", "password": "tooshort"},
        )
        assert response.status_code == 422


class TestMultiTenantIsolation:
    async def test_hides_another_tenants_widget(self, client: AsyncClient) -> None:
        alice = await register_tenant(client, "Alice Ltd")
        bob = await register_tenant(client, "Bob GmbH")
        widget = await create_widget(client, alice)

        read = await client.get(f"/api/widgets/{widget['id']}", headers=bob.auth)
        assert read.status_code == 404
        assert (
            await client.patch(
                f"/api/widgets/{widget['id']}", headers=bob.auth, json={"title": "taken over"}
            )
        ).status_code == 404
        assert (
            await client.delete(f"/api/widgets/{widget['id']}", headers=bob.auth)
        ).status_code == 404

        owner = await client.get(f"/api/widgets/{widget['id']}", headers=alice.auth)
        assert owner.json()["widget"]["title"] == "Join the list"

    async def test_never_lists_another_tenants_widgets(self, client: AsyncClient) -> None:
        alice = await register_tenant(client)
        bob = await register_tenant(client)
        await create_widget(client, alice)

        response = await client.get("/api/widgets", headers=bob.auth)
        assert response.json()["widgets"] == []
        assert response.json()["pagination"]["total"] == 0

    async def test_never_exposes_another_tenants_submissions(self, client: AsyncClient) -> None:
        alice = await register_tenant(client)
        bob = await register_tenant(client)
        widget = await create_widget(client, alice)

        await client.post("/api/public/submissions", json=valid_submission(widget["publicId"]))

        bobs = await client.get("/api/dashboard/submissions", headers=bob.auth)
        assert bobs.json()["submissions"] == []

        # Filtering explicitly by Alice's widget id must 404, not return an empty
        # page that looks like she has no submissions.
        filtered = await client.get(
            f"/api/dashboard/submissions?widgetId={widget['id']}", headers=bob.auth
        )
        assert filtered.status_code == 404

        alices = await client.get("/api/dashboard/submissions", headers=alice.auth)
        assert len(alices.json()["submissions"]) == 1
