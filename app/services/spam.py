import re
from typing import Any, NamedTuple

from app.config.settings import settings
from app.domain.models import Widget


class SpamVerdict(NamedTuple):
    is_spam: bool
    reason: str | None = None


_CLEAN = SpamVerdict(False)

_BOT_USER_AGENTS = re.compile(
    r"(curlbot|python-requests|scrapy|httpclient|bot/|spider|crawler|headlesschrome)", re.I
)
_LINK = re.compile(r"https?://", re.I)


def check(
    *,
    widget: Widget,
    data: dict[str, Any],
    elapsed_ms: int | None = None,
    user_agent: str | None = None,
) -> SpamVerdict:
    # A field the widget renders off-screen: invisible to a person, filled by a
    # form filler that populates every input it finds.
    honeypot = data.get(widget.honeypot_field)
    if isinstance(honeypot, str) and honeypot.strip():
        return SpamVerdict(True, "honeypot_filled")

    if (
        settings.SPAM_MIN_FILL_MS > 0
        and elapsed_ms is not None
        and 0 <= elapsed_ms < settings.SPAM_MIN_FILL_MS
    ):
        return SpamVerdict(True, "submitted_too_fast")

    text = " ".join(
        value
        for key, value in data.items()
        if key != widget.honeypot_field and isinstance(value, str)
    )
    if len(_LINK.findall(text)) >= 3:
        return SpamVerdict(True, "excessive_links")

    if user_agent and _BOT_USER_AGENTS.search(user_agent):
        return SpamVerdict(True, "bot_user_agent")

    return _CLEAN
