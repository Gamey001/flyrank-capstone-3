import uuid
from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from app.config.settings import settings
from app.lib.logging import logger

_QUIET_PATHS = {"/healthz", "/readyz"}


class RequestContextMiddleware(BaseHTTPMiddleware):
    """Gives every request an id, echoes it back, and logs the outcome.

    An inbound x-request-id is honoured so a trace survives a proxy hop.
    """

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        incoming = request.headers.get("x-request-id")
        request_id = incoming if incoming and len(incoming) <= 128 else str(uuid.uuid4())
        request.state.request_id = request_id

        response = await call_next(request)
        response.headers["x-request-id"] = request_id

        # Health checks are high-volume and uninteresting; logging them at info
        # drowns everything that matters.
        if request.url.path not in _QUIET_PATHS:
            level = (
                logger.error
                if response.status_code >= 500
                else logger.warning
                if response.status_code >= 400
                else logger.info
            )
            level(
                "request completed",
                method=request.method,
                path=request.url.path,
                status=response.status_code,
                request_id=request_id,
            )
        return response


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    """Rejects an oversized body with a 413 before it is parsed.

    Content-Length is checked first, then the buffered body, so a chunked
    request that declares no length cannot slip past.

    It returns a response rather than raising: Starlette's exception handlers
    sit *inside* the middleware stack, so an exception raised here would escape
    them and surface as a 500 — the exact failure this endpoint must not have.
    """

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        super().__init__(app)
        self.max_bytes = max_bytes

    def _too_large(self, request: Request) -> JSONResponse:
        request_id = getattr(request.state, "request_id", None)
        error: dict[str, object] = {
            "code": "payload_too_large",
            "message": "Request body exceeds the maximum allowed size",
        }
        if request_id:
            error["requestId"] = request_id
        return JSONResponse(status_code=413, content={"error": error})

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        if request.method in {"POST", "PUT", "PATCH"}:
            declared = request.headers.get("content-length")
            if declared is not None and declared.isdigit() and int(declared) > self.max_bytes:
                return self._too_large(request)

            body = await request.body()
            if len(body) > self.max_bytes:
                return self._too_large(request)

        return await call_next(request)


def body_limit_bytes() -> int:
    return settings.SUBMISSION_BODY_LIMIT_BYTES
