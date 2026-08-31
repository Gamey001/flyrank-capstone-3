from functools import lru_cache
from typing import Literal

from pydantic import Field, PostgresDsn
from pydantic_settings import BaseSettings, SettingsConfigDict


def _csv(value: str | list[str]) -> list[str]:
    if isinstance(value, list):
        return value
    return [part.strip() for part in value.split(",") if part.strip()]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=True
    )

    ENVIRONMENT: Literal["development", "test", "production"] = "development"
    LOG_LEVEL: Literal["debug", "info", "warning", "error", "critical"] = "info"

    PORT: int = Field(default=3000, ge=1, le=65535)
    PUBLIC_BASE_URL: str = "http://localhost:3000"
    # Comma-separated in the environment; read through `admin_cors_origins`.
    ADMIN_CORS_ORIGINS: str = "http://localhost:3000"
    # Proxies to trust for X-Forwarded-For. Defaults to 0: trusting the header
    # when no proxy strips it lets any client claim any IP and walk straight
    # through the per-IP rate limit.
    TRUST_PROXY_HOPS: int = Field(default=0, ge=0, le=10)

    DATABASE_URL: PostgresDsn
    TEST_DATABASE_URL: PostgresDsn | None = None
    DATABASE_POOL_MIN: int = Field(default=2, ge=1, le=50)
    DATABASE_POOL_MAX: int = Field(default=10, ge=1, le=100)

    JWT_SECRET: str = Field(min_length=32)
    JWT_TTL_SECONDS: int = Field(default=86_400, ge=60)

    SUBMISSION_BODY_LIMIT_BYTES: int = Field(default=16_384, ge=256, le=1_048_576)
    RATE_LIMIT_IP_WINDOW_SECONDS: int = Field(default=60, ge=1)
    RATE_LIMIT_IP_MAX: int = Field(default=10, ge=1)
    RATE_LIMIT_WIDGET_WINDOW_SECONDS: int = Field(default=60, ge=1)
    RATE_LIMIT_WIDGET_MAX: int = Field(default=60, ge=1)
    SPAM_MIN_FILL_MS: int = Field(default=1200, ge=0)

    GEO_PROVIDERS: str = "ip-api,ipapi-co"
    GEO_TIMEOUT_MS: int = Field(default=1500, ge=100, le=10_000)
    GEO_FORCE_DOWN: str = ""

    JOB_POLL_INTERVAL_MS: int = Field(default=1000, ge=50)
    JOB_MAX_ATTEMPTS: int = Field(default=5, ge=1, le=20)
    JOB_BATCH_SIZE: int = Field(default=10, ge=1, le=100)
    RUN_WORKER_IN_PROCESS: bool = True

    EMAIL_TRANSPORT: Literal["log", "smtp", "fail"] = "log"
    EMAIL_FROM: str = "FlyRank Widgets <no-reply@flyrank.local>"
    SMTP_HOST: str = "localhost"
    SMTP_PORT: int = Field(default=1025, ge=1, le=65535)
    SMTP_USER: str | None = None
    SMTP_PASSWORD: str | None = None

    # Uppercase attributes are the raw environment values; these properties are
    # the parsed form every caller uses.
    @property
    def admin_cors_origins(self) -> list[str]:
        return _csv(self.ADMIN_CORS_ORIGINS)

    @property
    def geo_providers(self) -> list[str]:
        return _csv(self.GEO_PROVIDERS)

    @property
    def geo_force_down(self) -> list[str]:
        return _csv(self.GEO_FORCE_DOWN)

    @property
    def is_test(self) -> bool:
        return self.ENVIRONMENT == "test"

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT == "production"

    @property
    def database_dsn(self) -> str:
        """The DSN actually used. In tests this is TEST_DATABASE_URL, which the
        suite truncates between tests — pointing it at the development database
        would delete seed data."""
        if self.is_test and self.TEST_DATABASE_URL is not None:
            return str(self.TEST_DATABASE_URL)
        return str(self.DATABASE_URL)


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()
