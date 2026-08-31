from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.lib.errors import AppError
from app.lib.logging import logger


def _body(
    code: str, message: str, request_id: str | None, details: Any = None
) -> dict[str, dict[str, Any]]:
    error: dict[str, Any] = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    if request_id:
        error["requestId"] = request_id
    return {"error": error}


def _request_id(request: Request) -> str | None:
    value = getattr(request.state, "request_id", None)
    return str(value) if value else None


def _issue_path(loc: tuple[Any, ...]) -> str:
    # Drop the "body"/"query" prefix FastAPI prepends, so the path a client sees
    # matches the field name they sent.
    parts = [str(p) for p in loc if p not in {"body", "query", "path"}]
    return ".".join(parts)


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        request_id = _request_id(request)
        if exc.status >= 500:
            logger.error(
                "request failed",
                err=exc.message,
                request_id=request_id,
                path=request.url.path,
                method=request.method,
            )
        else:
            logger.debug(
                "request rejected",
                code=exc.code,
                status=exc.status,
                request_id=request_id,
                path=request.url.path,
            )
        # A 5xx message stays in the log; the client gets a request id to quote.
        message = exc.message if exc.expose else "Internal server error"
        return JSONResponse(
            status_code=exc.status,
            content=_body(exc.code, message, request_id, exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        details = [
            {
                "path": _issue_path(issue["loc"]),
                "message": issue["msg"].removeprefix("Value error, "),
            }
            for issue in exc.errors()
        ]
        # A body that is not JSON at all is a 400, not a schema failure.
        if any(issue["type"] == "json_invalid" for issue in exc.errors()):
            return JSONResponse(
                status_code=status.HTTP_400_BAD_REQUEST,
                content=_body(
                    "bad_request", "Request body is not valid JSON", _request_id(request)
                ),
            )
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content=_body(
                "unprocessable_entity", "Some fields are invalid", _request_id(request), details
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        codes = {
            400: "bad_request",
            401: "unauthorized",
            403: "forbidden",
            404: "not_found",
            405: "method_not_allowed",
            413: "payload_too_large",
            429: "too_many_requests",
        }
        code = codes.get(exc.status_code, "error")
        return JSONResponse(
            status_code=exc.status_code,
            content=_body(code, str(exc.detail), _request_id(request)),
            headers=getattr(exc, "headers", None),
        )

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        request_id = _request_id(request)
        logger.error(
            "unhandled exception",
            err=str(exc),
            err_type=type(exc).__name__,
            request_id=request_id,
            path=request.url.path,
            exc_info=exc,
        )
        return JSONResponse(
            status_code=500,
            content=_body("internal_error", "Internal server error", request_id),
        )
