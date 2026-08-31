"""Standalone entrypoint for running the queue as its own process. Set
RUN_WORKER_IN_PROCESS=false on the API when using this, or jobs run twice."""

import asyncio
import contextlib
import signal

from app.db.pool import close_pool, create_pool
from app.jobs.worker import Worker
from app.lib.logging import logger


async def main() -> None:
    await create_pool()
    worker = Worker()
    worker.start()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)

    await stop.wait()
    logger.info("worker shutting down")
    await worker.stop()
    await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
