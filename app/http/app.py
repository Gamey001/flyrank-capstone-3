from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from app.config.settings import settings
from app.db.migrate import run_migrations
from app.db.pool import close_pool, create_pool
from app.http.errors import register_error_handlers
from app.http.middleware.context import BodySizeLimitMiddleware, RequestContextMiddleware
from app.http.routers import auth, dashboard, health, public, widgets
from app.jobs.worker import Worker
from app.lib.logging import logger
from app.services import widget_asset
from app.services.mailer import mailer

# Public paths are open to every origin — that is the product. An allow-list
# would mean a deploy every time a customer installs the widget on a new domain,
# so they carry no credentials, and per-widget origin rules live in the
# submission service instead.
_PUBLIC_PREFIXES = ("/api/public", "/embed", "/widget.js", "/healthz", "/readyz")

_PUBLIC_CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-expose-headers": (
        "x-request-id, retry-after, ratelimit, ratelimit-policy, idempotent-replay"
    ),
}


class CorsMiddleware(BaseHTTPMiddleware):
    """Both CORS policies, in one place.

    Starlette's CORSMiddleware is global, so it cannot express "open to
    everyone here, allow-listed there" — and mounting it would have it answer
    the public preflights with the admin policy. Two policies, dispatched on
    path:

    * public — any origin, no credentials. That is the product: an allow-list
      would mean a deploy every time a customer installs the widget on a new
      domain. Per-widget origin rules live in the submission service instead.
    * admin  — a named allow-list, credentials on, unknown origins refused.

    Preflights are answered before anything else. A request that will be
    rejected still needs a correct preflight, or the browser reports a CORS
    error instead of the real 4xx and the developer on the other side debugs
    the wrong thing.
    """

    async def dispatch(self, request: Request, call_next):  # type: ignore[no-untyped-def]
        origin = request.headers.get("origin")
        is_public = request.url.path.startswith(_PUBLIC_PREFIXES)
        is_preflight = (
            request.method == "OPTIONS" and "access-control-request-method" in request.headers
        )

        if is_public:
            if is_preflight:
                return Response(status_code=204, headers=_public_preflight_headers())
            response = await call_next(request)
            for key, value in _PUBLIC_CORS_HEADERS.items():
                response.headers[key] = value
            return response

        # Admin surface. A missing Origin means a non-browser client; CORS is a
        # browser mechanism and enforcing it there would protect nothing.
        #
        # Returned, not raised: Starlette's exception handlers sit inside the
        # middleware stack, so an exception raised here escapes them and becomes
        # a 500.
        if origin is not None and origin not in settings.admin_cors_origins:
            request_id = getattr(request.state, "request_id", None)
            error: dict[str, object] = {
                "code": "forbidden",
                "message": f"Origin {origin} is not allowed to call the admin API",
            }
            if request_id:
                error["requestId"] = request_id
            return JSONResponse(status_code=403, content={"error": error})

        if is_preflight:
            return Response(status_code=204, headers=_admin_headers(origin))

        response = await call_next(request)
        for key, value in _admin_headers(origin).items():
            response.headers[key] = value
        return response


def _public_preflight_headers() -> dict[str, str]:
    return {
        **_PUBLIC_CORS_HEADERS,
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,accept,idempotency-key,x-request-id",
        # Without a max-age the browser re-preflights before every submission.
        "access-control-max-age": "86400",
    }


def _admin_headers(origin: str | None) -> dict[str, str]:
    if origin is None:
        return {}
    return {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type,accept,authorization,x-request-id",
        "access-control-expose-headers": "x-request-id",
        "access-control-max-age": "600",
        "vary": "Origin",
    }


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await create_pool()
    applied = await run_migrations()
    if applied:
        logger.info("database migrated", applied=applied)

    worker: Worker | None = None
    if settings.RUN_WORKER_IN_PROCESS:
        worker = Worker()
        worker.start()

    logger.info(
        "widget platform ready",
        port=settings.PORT,
        base_url=settings.PUBLIC_BASE_URL,
        widget_version=widget_asset.VERSION,
        geo_providers=settings.geo_providers,
        email_transport=mailer.kind,
    )

    try:
        yield
    finally:
        if worker is not None:
            await worker.stop()
        await close_pool()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Embeddable Widget & Lead-Capture Platform",
        version="1.0.0",
        description=(
            "Customers define widgets, paste one <script> tag into any website, and every "
            "submission is validated, rate-limited, spam-filtered, enriched and stored."
        ),
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
    )

    register_error_handlers(app)

    # add_middleware prepends, so the last registered runs first. Registering
    # in this order puts the request id outermost (every response carries one,
    # including a CORS rejection), then CORS, then the size limit.
    app.add_middleware(BodySizeLimitMiddleware, max_bytes=settings.SUBMISSION_BODY_LIMIT_BYTES)
    app.add_middleware(CorsMiddleware)
    app.add_middleware(RequestContextMiddleware)

    app.include_router(health.router)
    app.include_router(public.router)
    app.include_router(auth.router)
    app.include_router(widgets.router)
    app.include_router(dashboard.router)

    return app


app = create_app()
