from typing import Annotated

from fastapi import Depends, Header, Request

from app.lib.errors import AppError
from app.services import auth as auth_service


def client_ip(request: Request) -> str | None:
    """Honours X-Forwarded-For only when TRUST_PROXY_HOPS says a proxy sets it.

    Defaulting to 0 matters: trusting the header when nothing strips it lets any
    client claim any IP and walk straight through the per-IP rate limit.
    """
    from app.config.settings import settings

    if settings.TRUST_PROXY_HOPS > 0:
        # Repeated headers are equivalent to one comma-joined value (RFC 7230),
        # and `.get()` would silently return only the first.
        forwarded = ",".join(request.headers.getlist("x-forwarded-for"))
        hops = [part.strip() for part in forwarded.split(",") if part.strip()]
        if hops:
            # Entries are appended left to right, so with N trusted proxies the
            # client is the Nth from the right.
            index = max(0, len(hops) - settings.TRUST_PROXY_HOPS)
            return hops[index]
    return request.client.host if request.client else None


def require_auth(authorization: Annotated[str | None, Header()] = None) -> str:
    """Returns the tenant id. Every downstream repository call takes it as a
    required argument, which is how isolation is enforced in the query rather
    than in the handler."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise AppError.unauthorized("Missing Bearer token")
    payload = auth_service.verify_token(authorization[7:].strip())
    return payload["sub"]


TenantId = Annotated[str, Depends(require_auth)]
ClientIp = Annotated[str | None, Depends(client_ip)]
