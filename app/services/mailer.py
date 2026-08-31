from typing import Protocol

import aiosmtplib

from app.config.settings import settings
from app.lib.logging import logger


class Mailer(Protocol):
    kind: str

    async def send(self, *, to: str, subject: str, text: str) -> None: ...


class LogMailer:
    kind = "log"

    async def send(self, *, to: str, subject: str, text: str) -> None:
        logger.info("[email] delivered to log", to=to, subject=subject, body=text)


class FailingMailer:
    """A demo switch, not a fallback: it exists so a broken side effect can be
    demonstrated without editing code. Never configure it outside a demo."""

    kind = "fail"

    async def send(self, *, to: str, subject: str, text: str) -> None:
        raise RuntimeError("EMAIL_TRANSPORT=fail: simulated mail provider outage")


class SmtpMailer:
    kind = "smtp"

    async def send(self, *, to: str, subject: str, text: str) -> None:
        message = f"From: {settings.EMAIL_FROM}\r\nTo: {to}\r\nSubject: {subject}\r\n\r\n{text}"
        await aiosmtplib.send(
            message,
            sender=settings.EMAIL_FROM,
            recipients=[to],
            hostname=settings.SMTP_HOST,
            port=settings.SMTP_PORT,
            username=settings.SMTP_USER or None,
            password=settings.SMTP_PASSWORD or None,
        )


def _build() -> Mailer:
    if settings.EMAIL_TRANSPORT == "smtp":
        return SmtpMailer()
    if settings.EMAIL_TRANSPORT == "fail":
        return FailingMailer()
    return LogMailer()


mailer: Mailer = _build()
