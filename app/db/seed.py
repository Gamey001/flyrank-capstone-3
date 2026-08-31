"""Idempotent demo data: re-running reuses the existing rows rather than
duplicating them."""

import asyncio
import json
from pathlib import Path
from typing import Any

from app.config.settings import settings
from app.db.migrate import run_migrations
from app.db.pool import close_pool
from app.domain.models import WidgetDisplay, WidgetField
from app.lib.ids import public_widget_id
from app.lib.passwords import hash_password
from app.repositories import tenants as tenants_repo
from app.repositories import widgets as widgets_repo
from app.services import embed

DEMO_PASSWORD = "demo-password-1234"  # noqa: S105 — local demo data, not a secret


async def _seed_tenant(email: str, name: str) -> Any:
    existing = await tenants_repo.find_by_email(email)
    if existing:
        return existing
    return await tenants_repo.create(
        email=email, name=name, password_hash=hash_password(DEMO_PASSWORD)
    )


async def _seed_widget(tenant_id: str, name: str, **kwargs: Any) -> Any:
    items, _ = await widgets_repo.list_for_tenant(tenant_id, limit=100, offset=0)
    for widget in items:
        if widget.name == name:
            return widget
    return await widgets_repo.create(
        tenant_id=tenant_id, public_id=public_widget_id(), name=name, **kwargs
    )


async def main() -> None:
    await run_migrations()

    acme = await _seed_tenant("owner@acme.test", "Acme Inc.")
    # A second tenant exists so isolation can be demonstrated, not just asserted.
    globex = await _seed_tenant("owner@globex.test", "Globex Corp.")

    newsletter = await _seed_widget(
        acme.id,
        "Acme newsletter signup",
        type="signup_form",
        title="Join the Acme newsletter",
        description="Product news once a month. No spam, unsubscribe any time.",
        button_text="Subscribe",
        success_message="You are on the list — check your inbox.",
        fields=[
            WidgetField(
                name="email",
                label="Email address",
                type="email",
                required=True,
                placeholder="you@example.com",
            ),
            WidgetField(name="first_name", label="First name", type="text", max_length=80),
            WidgetField(
                name="consent", label="I agree to receive emails", type="checkbox", required=True
            ),
        ],
        display=WidgetDisplay(position="inline", theme="light", accent_color="#4f46e5"),
        notify_email="leads@acme.test",
    )

    contact = await _seed_widget(
        acme.id,
        "Acme contact form",
        type="contact_form",
        title="Talk to sales",
        description="Tell us what you need and we will get back within one business day.",
        button_text="Send message",
        fields=[
            WidgetField(name="name", label="Your name", type="text", required=True, max_length=120),
            WidgetField(name="email", label="Work email", type="email", required=True),
            WidgetField(
                name="company_size",
                label="Company size",
                type="select",
                options=["1-10", "11-50", "51-200", "200+"],
            ),
            WidgetField(
                name="message",
                label="How can we help?",
                type="textarea",
                required=True,
                max_length=2000,
            ),
        ],
        display=WidgetDisplay(position="inline", theme="light", accent_color="#0f766e"),
        notify_email="sales@acme.test",
    )

    waitlist = await _seed_widget(
        globex.id,
        "Globex waitlist",
        type="cta_popover",
        title="Get early access",
        description="We are onboarding in batches.",
        button_text="Request access",
        fields=[WidgetField(name="email", label="Email address", type="email", required=True)],
        display=WidgetDisplay(
            position="bottom-right", theme="dark", accent_color="#b45309", delay_seconds=2
        ),
    )

    print(f"""
Seed complete.

  Login (both accounts share this password): {DEMO_PASSWORD}

  Tenant A  owner@acme.test     {acme.id}
    - {newsletter.name}
        public id: {newsletter.public_id}
        snippet:   {embed.for_widget(newsletter.public_id)["snippet"]}
    - {contact.name}
        public id: {contact.public_id}
        snippet:   {embed.for_widget(contact.public_id)["snippet"]}

  Tenant B  owner@globex.test   {globex.id}
    - {waitlist.name}
        public id: {waitlist.public_id}

  Test page: python scripts/serve_customer_site.py   ->   http://localhost:5500
  API base:  {settings.PUBLIC_BASE_URL}
""")

    # Also written to a file so scripts can read the ids without parsing stdout.
    await asyncio.to_thread(
        Path("seed-output.json").write_text,
        json.dumps(
            {
                "password": DEMO_PASSWORD,
                "tenantA": {"email": acme.email, "id": acme.id},
                "tenantB": {"email": globex.email, "id": globex.id},
                "widgets": {
                    "newsletter": {"id": newsletter.id, "publicId": newsletter.public_id},
                    "contact": {"id": contact.id, "publicId": contact.public_id},
                    "globex": {"id": waitlist.id, "publicId": waitlist.public_id},
                },
            },
            indent=2,
        ),
    )


async def _run() -> None:
    try:
        await main()
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(_run())
