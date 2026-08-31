import uvicorn

from app.config.settings import settings
from app.http.app import app

__all__ = ["app"]

if __name__ == "__main__":
    uvicorn.run(
        "app.http.app:app",
        host="0.0.0.0",  # noqa: S104 — containers must bind all interfaces
        port=settings.PORT,
        reload=not settings.is_production,
    )
