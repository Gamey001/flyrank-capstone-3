from typing import Annotated, Any

from fastapi import APIRouter, Header, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from app.config.settings import settings
from app.http.dependencies import ClientIp
from app.http.middleware.rate_limit import FixedWindowLimiter, headers
from app.http.schemas import SubmissionRequest
from app.lib.logging import logger
from app.services import submissions as submissions_service
from app.services import widget_asset
from app.services import widgets as widgets_service

# Everything on this router is reachable by the entire internet: no auth, any
# origin, and the caller is assumed hostile until validated.
router = APIRouter(tags=["public"])

CONFIG_MAX_AGE_SECONDS = 60
BUNDLE_MAX_AGE_SECONDS = 31_536_000  # one year

ip_limiter = FixedWindowLimiter(
    limit=settings.RATE_LIMIT_IP_MAX, window_seconds=settings.RATE_LIMIT_IP_WINDOW_SECONDS
)
widget_limiter = FixedWindowLimiter(
    limit=settings.RATE_LIMIT_WIDGET_MAX, window_seconds=settings.RATE_LIMIT_WIDGET_WINDOW_SECONDS
)


def _limited(scope: str, request_id: str | None, decision: Any) -> JSONResponse:
    return JSONResponse(
        status_code=429,
        content={
            "error": {
                "code": "too_many_requests",
                "message": (
                    "Too many submissions from this source. "
                    "Please slow down and try again shortly."
                ),
                "scope": scope,
                "retryAfterSeconds": decision.reset_seconds,
                "requestId": request_id,
            }
        },
        headers={**headers(decision), "retry-after": str(decision.reset_seconds)},
    )


def _bundle(cache_control: str) -> Response:
    return Response(
        content=widget_asset.SOURCE,
        media_type="application/javascript; charset=utf-8",
        headers={
            "cache-control": cache_control,
            "etag": widget_asset.ETAG,
            "x-widget-version": widget_asset.VERSION,
        },
    )


# Safe to cache for a year because the version in the path is a hash of the
# file: changed code necessarily lands at a different URL.
@router.get("/embed/{version}/widget.js", include_in_schema=False)
async def versioned_bundle(version: str, request: Request) -> Response:
    if version != widget_asset.VERSION:
        # Redirect rather than 404, so a customer who cached the snippet itself
        # keeps working across a release.
        query = f"?{request.url.query}" if request.url.query else ""
        return RedirectResponse(
            url=f"{widget_asset.VERSIONED_PATH}{query}",
            status_code=302,
            headers={"cache-control": "public, max-age=300"},
        )
    return _bundle(f"public, max-age={BUNDLE_MAX_AGE_SECONDS}, immutable")


# Same bytes, short cache: unlike the versioned path, this URL's content changes
# on release.
@router.get("/widget.js", include_in_schema=False)
async def unversioned_bundle() -> Response:
    return _bundle("public, max-age=300, stale-while-revalidate=600")


@router.get("/api/public/widgets/{public_id}/config")
async def widget_config(
    public_id: str,
    if_none_match: Annotated[str | None, Header()] = None,
) -> Response:
    config, etag = await widgets_service.public_config(public_id)

    cache_headers = {
        "cache-control": (f"public, max-age={CONFIG_MAX_AGE_SECONDS}, stale-while-revalidate=300"),
        "etag": etag,
        # The CORS response headers vary with Origin, so caches must key on it.
        "vary": "Origin",
    }

    if if_none_match == etag:
        return Response(status_code=304, headers=cache_headers)
    return JSONResponse(content=config, headers=cache_headers)


# Middleware order is the design: the cheap in-memory rate limit first, then
# schema validation, and only then anything touching the database or a third
# party — so a flood is rejected before it becomes expensive.
@router.post("/api/public/submissions")
async def create_submission(
    payload: SubmissionRequest,
    request: Request,
    ip: ClientIp,
    idempotency_key: Annotated[str | None, Header(alias="idempotency-key")] = None,
) -> Response:
    request_id = getattr(request.state, "request_id", None)

    ip_decision = ip_limiter.check(f"ip:{ip or 'unknown'}")
    if not ip_decision.allowed:
        logger.warning("rate limit exceeded", scope="ip", ip=ip)
        return _limited("ip", request_id, ip_decision)

    widget_decision = widget_limiter.check(f"widget:{payload.widgetId}")
    if not widget_decision.allowed:
        logger.warning("rate limit exceeded", scope="widget", widget=payload.widgetId)
        return _limited("widget", request_id, widget_decision)

    result = await submissions_service.submit(
        widget_public_id=payload.widgetId,
        data=payload.data,
        elapsed_ms=payload.elapsedMs,
        page_url=payload.pageUrl,
        ip=ip,
        user_agent=(request.headers.get("user-agent") or None),
        origin=(request.headers.get("origin") or None),
        referer=(request.headers.get("referer") or None),
        idempotency_key=(idempotency_key[:200] if idempotency_key else None),
    )

    submission = result["submission"]

    if result["status"] == "duplicate":
        return JSONResponse(
            status_code=200,
            content={
                "ok": True,
                "id": submission.id if submission else None,
                "message": result["message"],
                "duplicate": True,
            },
            headers={"cache-control": "no-store", "idempotent-replay": "true"},
        )

    # 202, not 201: the row is committed but its email and webhook are only
    # queued. Spam reaches here too, with an identical status and shape — a bot
    # that can detect it was filtered is a bot that can iterate.
    return JSONResponse(
        status_code=202,
        content={
            "ok": True,
            "id": submission.id if submission else None,
            "message": result["message"],
        },
        headers={"cache-control": "no-store"},
    )


@router.get("/api/public/version")
async def version() -> Response:
    return JSONResponse(
        content={
            "widgetVersion": widget_asset.VERSION,
            "bundlePath": widget_asset.VERSIONED_PATH,
            "bundleBytes": widget_asset.BYTE_LENGTH,
            "baseUrl": settings.PUBLIC_BASE_URL,
        },
        headers={"cache-control": "public, max-age=60"},
    )


# Caches and monitors validate with HEAD, and FastAPI — unlike Express — does
# not derive it from the GET route. Registered out of the schema so the
# generated OpenAPI documents each endpoint once.
for _path, _endpoint in (
    ("/embed/{version}/widget.js", versioned_bundle),
    ("/widget.js", unversioned_bundle),
    ("/api/public/widgets/{public_id}/config", widget_config),
    ("/api/public/version", version),
):
    router.add_api_route(_path, _endpoint, methods=["HEAD"], include_in_schema=False)


def reset_limiters() -> None:
    """Used by the test suite between cases; the limiters are module state."""
    ip_limiter.reset()
    widget_limiter.reset()
