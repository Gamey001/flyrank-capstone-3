"""Storing the lead is what must not fail. The email and webhook are allowed to
fail, retry and eventually give up, without the visitor ever knowing."""

from typing import Any

import pytest
from httpx import AsyncClient

from app.db import pool
from app.jobs.worker import Worker
from app.repositories import jobs as jobs_repo
from app.services import mailer as mailer_module
from tests.conftest import create_widget, register_tenant, valid_submission


async def jobs_of(job_type: str) -> list[Any]:
    return await pool.fetch("SELECT * FROM jobs WHERE type = $1 ORDER BY created_at", job_type)


class Recorder:
    """Stands in for the mailer. `failures` controls how many calls raise before
    it starts succeeding."""

    kind = "recorder"

    def __init__(self, failures: int = 0, always_fail: bool = False) -> None:
        self.calls = 0
        self.failures = failures
        self.always_fail = always_fail

    async def send(self, *, to: str, subject: str, text: str) -> None:
        self.calls += 1
        if self.always_fail or self.calls <= self.failures:
            raise RuntimeError("simulated mail provider outage")


@pytest.fixture
def worker() -> Worker:
    return Worker()


class TestSideEffectsAreQueued:
    async def test_commits_submission_and_its_jobs_together(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(
            client,
            tenant,
            notifyEmail="owner@example.test",
            webhookUrl="https://hooks.example/inbox",
        )

        await client.post("/api/public/submissions", json=valid_submission(widget["publicId"]))

        # The row and the work it implies commit together or not at all.
        assert len(await jobs_of("submission.notify_email")) == 1
        assert len(await jobs_of("submission.webhook")) == 1

    async def test_queues_nothing_without_a_notification_configured(
        self, client: AsyncClient
    ) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant)
        await client.post("/api/public/submissions", json=valid_submission(widget["publicId"]))
        assert await jobs_of("submission.notify_email") == []

    async def test_does_not_notify_anyone_about_spam(self, client: AsyncClient) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant, notifyEmail="owner@example.test")

        await client.post(
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
        assert await jobs_of("submission.notify_email") == []


class TestFailingSideEffects:
    async def test_stores_and_succeeds_when_the_mailer_is_down(
        self, client: AsyncClient, worker: Worker, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant, notifyEmail="owner@example.test")

        recorder = Recorder(always_fail=True)
        monkeypatch.setattr(mailer_module, "mailer", recorder)

        response = await client.post(
            "/api/public/submissions", json=valid_submission(widget["publicId"])
        )
        assert response.status_code == 202

        # The visitor already has their answer; this failure happens after it.
        await worker.tick()
        assert recorder.calls == 1

        stored = await client.get("/api/dashboard/submissions", headers=tenant.auth)
        assert len(stored.json()["submissions"]) == 1
        assert stored.json()["submissions"][0]["id"] == response.json()["id"]

        job = (await jobs_of("submission.notify_email"))[0]
        assert job["status"] == "pending"  # scheduled for retry, not lost
        assert job["attempts"] == 1
        assert "simulated mail provider outage" in job["last_error"]

    async def test_stores_and_succeeds_when_the_webhook_is_unreachable(
        self, client: AsyncClient, worker: Worker
    ) -> None:
        tenant = await register_tenant(client)
        # Port 9 (discard) — nothing listens, so the delivery genuinely fails.
        widget = await create_widget(
            client, tenant, webhookUrl="http://127.0.0.1:9/never-listening"
        )

        response = await client.post(
            "/api/public/submissions", json=valid_submission(widget["publicId"])
        )
        assert response.status_code == 202

        await worker.tick()
        job = (await jobs_of("submission.webhook"))[0]
        assert job["attempts"] == 1
        assert job["status"] == "pending"

        stored = await client.get("/api/dashboard/submissions", headers=tenant.auth)
        assert stored.json()["submissions"][0]["id"] == response.json()["id"]


class TestTheWorker:
    async def test_retries_then_marks_dead_and_alerts(
        self, client: AsyncClient, worker: Worker, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant, notifyEmail="owner@example.test")
        monkeypatch.setattr(mailer_module, "mailer", Recorder(always_fail=True))

        await client.post("/api/public/submissions", json=valid_submission(widget["publicId"]))
        queued = (await jobs_of("submission.notify_email"))[0]
        # Lowered so the retry ceiling is reached within a bounded test.
        await pool.execute("UPDATE jobs SET max_attempts = 2 WHERE id = $1", queued["id"])

        await worker.tick()
        job = await jobs_repo.find_by_id(str(queued["id"]))
        assert job is not None
        assert job.status == "pending"
        # Backoff: scheduled in the future rather than retried immediately.
        assert job.run_at.timestamp() > job.created_at.timestamp()

        await pool.execute("UPDATE jobs SET run_at = now() WHERE id = $1", queued["id"])
        await worker.tick()

        job = await jobs_repo.find_by_id(str(queued["id"]))
        assert job is not None
        assert job.status == "dead"
        assert job.attempts == 2
        assert job.last_error is not None
        assert "simulated mail provider outage" in job.last_error

    async def test_marks_succeeded_once_the_handler_stops_failing(
        self, client: AsyncClient, worker: Worker, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        tenant = await register_tenant(client)
        widget = await create_widget(client, tenant, notifyEmail="owner@example.test")
        recorder = Recorder(failures=1)
        monkeypatch.setattr(mailer_module, "mailer", recorder)

        await client.post("/api/public/submissions", json=valid_submission(widget["publicId"]))
        queued = (await jobs_of("submission.notify_email"))[0]

        await worker.tick()
        job = await jobs_repo.find_by_id(str(queued["id"]))
        assert job is not None and job.status == "pending"

        await pool.execute("UPDATE jobs SET run_at = now() WHERE id = $1", queued["id"])
        await worker.tick()

        job = await jobs_repo.find_by_id(str(queued["id"]))
        assert job is not None
        assert job.status == "succeeded"
        assert job.last_error is None
        assert recorder.calls == 2

    async def test_gives_up_immediately_on_an_unknown_job_type(self, worker: Worker) -> None:
        job = await jobs_repo.enqueue(type="nonexistent.type", payload={})
        await worker.tick()

        after = await jobs_repo.find_by_id(job.id)
        assert after is not None
        # A missing handler is a deploy bug: retrying only delays the alert.
        assert after.status == "dead"
        assert after.attempts == 1

    async def test_reclaims_a_job_abandoned_mid_run(self) -> None:
        job = await jobs_repo.enqueue(
            type="submission.notify_email", payload={"submissionId": "x", "to": "y"}
        )
        await pool.execute(
            "UPDATE jobs SET status = 'running', locked_at = now() - interval '10 minutes' "
            "WHERE id = $1::uuid",
            job.id,
        )

        assert await jobs_repo.requeue_stale(120) == 1
        after = await jobs_repo.find_by_id(job.id)
        assert after is not None and after.status == "pending"

    async def test_claims_each_job_exactly_once_under_concurrency(self) -> None:
        for i in range(6):
            await jobs_repo.enqueue(type="submission.notify_email", payload={"n": i})

        # Two workers claiming at once must take disjoint sets, never the same job.
        import asyncio

        first, second = await asyncio.gather(jobs_repo.claim_batch(10), jobs_repo.claim_batch(10))
        ids = [job.id for job in [*first, *second]]
        assert len(set(ids)) == len(ids)
        assert len(ids) == 6
