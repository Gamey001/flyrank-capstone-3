from fastapi import APIRouter, Request, Response

from app.config.settings import settings
from app.http.dependencies import ClientIp, TenantId
from app.http.middleware.rate_limit import FixedWindowLimiter, headers
from app.http.schemas import LoginRequest, RegisterRequest
from app.lib.errors import AppError
from app.services import auth as auth_service

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Login and register are the endpoints worth brute-forcing, so they get their
# own tighter budget than the rest of the authenticated API.
_limiter = FixedWindowLimiter(limit=1_000 if settings.is_test else 20, window_seconds=15 * 60)


def _guard(ip: str | None, response: Response) -> None:
    decision = _limiter.check(f"auth:{ip or 'unknown'}")
    for key, value in headers(decision).items():
        response.headers[key] = value
    if not decision.allowed:
        raise AppError.too_many_requests("Too many attempts. Please try again later.")


@router.post("/register", status_code=201)
async def register(payload: RegisterRequest, ip: ClientIp, response: Response) -> dict[str, object]:
    _guard(ip, response)
    return await auth_service.register(
        email=payload.email, name=payload.name, password=payload.password
    )


@router.post("/login")
async def login(payload: LoginRequest, ip: ClientIp, response: Response) -> dict[str, object]:
    _guard(ip, response)
    return await auth_service.login(email=payload.email, password=payload.password)


@router.get("/me")
async def me(tenant_id: TenantId, request: Request) -> dict[str, object]:
    from app.repositories import tenants as tenants_repo

    tenant = await tenants_repo.find_by_id(tenant_id)
    if tenant is None:
        raise AppError.unauthorized("Account no longer exists")
    return {"tenant": tenant}
