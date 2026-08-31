"""Fixed-window rate limiting.

Two limiters run for the public submission endpoint, defending against two
different things: the per-IP limiter stops one machine flooding, and the
per-widget limiter caps a distributed flood against a single customer's form,
which shares no IP for the first limiter to catch.

It is written here rather than pulled from a library because the two scopes key
off different things — the per-IP limit is checked before the body is read, the
per-widget limit after it is parsed — and because the draft-7 headers are part
of the documented contract.

The store is in-memory, which is correct for one instance. Across several
replicas the effective limit multiplies by the replica count.
"""

import time
from dataclasses import dataclass, field


@dataclass
class Decision:
    allowed: bool
    limit: int
    remaining: int
    reset_seconds: int


@dataclass
class FixedWindowLimiter:
    limit: int
    window_seconds: int
    _hits: dict[str, tuple[int, float]] = field(default_factory=dict)

    def check(self, key: str, *, now: float | None = None) -> Decision:
        current = time.monotonic() if now is None else now
        count, window_start = self._hits.get(key, (0, current))

        if current - window_start >= self.window_seconds:
            count, window_start = 0, current

        count += 1
        self._hits[key] = (count, window_start)

        reset = max(0, int(self.window_seconds - (current - window_start)))
        remaining = max(0, self.limit - count)

        # Opportunistic sweep: without it a long-lived process accumulates one
        # entry per IP seen, forever.
        if len(self._hits) > 10_000:
            self._evict_expired(current)

        return Decision(count <= self.limit, self.limit, remaining, reset)

    def _evict_expired(self, now: float) -> None:
        expired = [
            key for key, (_, started) in self._hits.items() if now - started >= self.window_seconds
        ]
        for key in expired:
            del self._hits[key]

    def reset(self) -> None:
        self._hits.clear()


def headers(decision: Decision) -> dict[str, str]:
    """draft-7 RateLimit headers, so a well-behaved client can back off itself."""
    return {
        "ratelimit-policy": f"{decision.limit};w={decision.reset_seconds or 0}",
        "ratelimit": (
            f"limit={decision.limit}, remaining={decision.remaining}, "
            f"reset={decision.reset_seconds}"
        ),
    }
