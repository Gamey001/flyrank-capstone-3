from typing import Any


class AppError(Exception):
    """One error type crosses every layer boundary.

    Services raise it carrying a status; a single exception handler is the only
    place that turns it into a response, so no layer below `http/` needs to know
    what a status code is.
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details

    @property
    def expose(self) -> bool:
        return self.status < 500

    @classmethod
    def bad_request(cls, message: str, details: Any = None) -> "AppError":
        return cls(400, "bad_request", message, details=details)

    @classmethod
    def unauthorized(cls, message: str = "Authentication required") -> "AppError":
        return cls(401, "unauthorized", message)

    @classmethod
    def forbidden(cls, message: str = "Not allowed") -> "AppError":
        return cls(403, "forbidden", message)

    @classmethod
    def not_found(cls, message: str = "Resource not found") -> "AppError":
        return cls(404, "not_found", message)

    @classmethod
    def conflict(cls, message: str, details: Any = None) -> "AppError":
        return cls(409, "conflict", message, details=details)

    @classmethod
    def payload_too_large(cls, message: str = "Request body too large") -> "AppError":
        return cls(413, "payload_too_large", message)

    @classmethod
    def unprocessable(cls, message: str, details: Any = None) -> "AppError":
        return cls(422, "unprocessable_entity", message, details=details)

    @classmethod
    def too_many_requests(cls, message: str = "Too many requests") -> "AppError":
        return cls(429, "too_many_requests", message)

    @classmethod
    def internal(cls, message: str = "Internal server error") -> "AppError":
        return cls(500, "internal_error", message)
