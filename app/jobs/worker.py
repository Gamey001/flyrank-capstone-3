import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from typing import Any

from app.config.settings import settings
from app.domain.models import Job
from app.jobs import types as job_types
from app.jobs.handlers import submission_email, submission_webhook
from app.lib.logging import logger
from app.repositories import jobs as jobs_repo

Handler = Callable[[dict[str, Any]], Awaitable[None]]

HANDLERS: dict[str, Handler] = {
    job_types.SUBMISSION_EMAIL: submission_email.handle,
    job_types.SUBMISSION_WEBHOOK: submission_webhook.handle,
}

# A job still 'running' after this long belongs to a worker that died.
STALE_JOB_SECONDS = 120


def backoff_seconds(attempts: int) -> int:
    """2s, 4s, 8s, … capped at five minutes."""
    return int(min(2**attempts, 300))


async def run_job(job: Job) -> None:
    handler = HANDLERS.get(job.type)

    if handler is None:
        # A missing handler is a deploy problem, not a transient fault: retrying
        # it would only delay the alert.
        logger.error("no handler registered for job type", job_id=job.id, type=job.type)
        await jobs_repo.mark_failed(
            job.id, f'no handler registered for job type "{job.type}"', retry_in_seconds=None
        )
        return

    try:
        await handler(job.payload)
        await jobs_repo.mark_succeeded(job.id)
        logger.debug("job succeeded", job_id=job.id, type=job.type, attempts=job.attempts)
    except Exception as exc:
        message = str(exc)
        exhausted = job.attempts >= job.max_attempts

        await jobs_repo.mark_failed(
            job.id, message, retry_in_seconds=None if exhausted else backoff_seconds(job.attempts)
        )

        if exhausted:
            # The line an alerting rule matches on in a hosted deployment.
            logger.error(
                "JOB DEAD after exhausting retries — needs manual attention",
                job_id=job.id,
                type=job.type,
                attempts=job.attempts,
                err=message,
                alert="job_dead",
            )
        else:
            logger.warning(
                "job failed, scheduled for retry",
                job_id=job.id,
                type=job.type,
                attempts=job.attempts,
                err=message,
            )


class Worker:
    """Polling worker over the `jobs` table.

    Polling rather than a broker keeps the stack to one dependency, and the queue
    stays transactional with the data it refers to.
    """

    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        # Set while a batch is in flight, so stop() can wait for it rather than
        # cancelling mid-job and orphaning claimed rows.
        self._idle = asyncio.Event()
        self._idle.set()
        self._stopped = False

    async def tick(self) -> int:
        # Ticks must not overlap: a slow batch would otherwise stack them up
        # until the connection pool is exhausted.
        if not self._idle.is_set():
            return 0
        self._idle.clear()
        try:
            requeued = await jobs_repo.requeue_stale(STALE_JOB_SECONDS)
            if requeued:
                logger.warning("requeued stale jobs from a dead worker", requeued=requeued)

            jobs = await jobs_repo.claim_batch(settings.JOB_BATCH_SIZE)
            # Safe as gather rather than gather(return_exceptions=True) because
            # run_job never raises.
            await asyncio.gather(*(run_job(job) for job in jobs))
            return len(jobs)
        except Exception as exc:
            logger.error("job worker tick failed", err=str(exc))
            return 0
        finally:
            self._idle.set()

    async def _loop(self) -> None:
        interval = settings.JOB_POLL_INTERVAL_MS / 1000
        while not self._stopped:
            await self.tick()
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.sleep(interval)

    def start(self) -> None:
        if self._task is not None or self._stopped:
            return
        logger.info(
            "job worker started",
            interval_ms=settings.JOB_POLL_INTERVAL_MS,
            batch=settings.JOB_BATCH_SIZE,
        )
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._stopped = True
        # Wait for an in-flight batch before cancelling, so shutdown never
        # orphans a job this worker has already claimed.
        await self._idle.wait()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None
