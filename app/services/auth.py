from datetime import UTC, datetime, timedelta

import jwt

from app.config.settings import settings
from app.domain.models import Tenant
from app.lib.errors import AppError
from app.lib.passwords import hash_password, verify_password
from app.repositories import tenants as tenants_repo

_ISSUER = "flyrank-widget-platform"
_ALGORITHM = "HS256"


def _issue_token(tenant: Tenant) -> str:
    now = datetime.now(UTC)
    return jwt.encode(
        {
            "sub": tenant.id,
            "email": tenant.email,
            "iss": _ISSUER,
            "iat": now,
            "exp": now + timedelta(seconds=settings.JWT_TTL_SECONDS),
        },
        settings.JWT_SECRET,
        algorithm=_ALGORITHM,
    )


async def register(*, email: str, name: str, password: str) -> dict[str, object]:
    if await tenants_repo.find_by_email(email):
        raise AppError.conflict("An account with that email already exists")

    tenant = await tenants_repo.create(
        email=email.lower(), name=name, password_hash=hash_password(password)
    )
    return {
        "tenant": tenant,
        "token": _issue_token(tenant),
        "expiresIn": settings.JWT_TTL_SECONDS,
    }


async def login(*, email: str, password: str) -> dict[str, object]:
    stored = await tenants_repo.find_by_email(email)

    # The discarded hash is deliberate: without it an unknown email returns
    # measurably faster than a wrong password, and login becomes an
    # account-enumeration oracle.
    if stored is None:
        hash_password(password)
        raise AppError.unauthorized("Invalid email or password")

    if not verify_password(password, stored.password_hash):
        raise AppError.unauthorized("Invalid email or password")

    tenant = Tenant(
        id=stored.id, email=stored.email, name=stored.name, created_at=stored.created_at
    )
    return {
        "tenant": tenant,
        "token": _issue_token(tenant),
        "expiresIn": settings.JWT_TTL_SECONDS,
    }


def verify_token(token: str) -> dict[str, str]:
    try:
        # Pinning `algorithms` is what rejects a token signed with "none".
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[_ALGORITHM], issuer=_ISSUER)
    except jwt.ExpiredSignatureError as exc:
        raise AppError.unauthorized("Token expired") from exc
    except jwt.PyJWTError as exc:
        raise AppError.unauthorized("Invalid or malformed token") from exc

    subject = payload.get("sub")
    if not isinstance(subject, str):
        raise AppError.unauthorized("Invalid or malformed token")
    return {"sub": subject, "email": str(payload.get("email", ""))}
