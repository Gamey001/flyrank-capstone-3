# syntax=docker/dockerfile:1

FROM python:3.12-slim AS build
WORKDIR /app

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

# Built into a wheel-less venv that the runtime stage copies wholesale, so the
# compilers and build metadata never reach the final image.
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

COPY pyproject.toml README.md ./
COPY app ./app
RUN pip install --no-cache-dir .

# --- runtime ---------------------------------------------------------------
FROM python:3.12-slim AS runtime
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    ENVIRONMENT=production \
    PATH="/opt/venv/bin:$PATH"

# Without an init, SIGTERM never reaches Python and the graceful shutdown in the
# lifespan handler does not run.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/venv /opt/venv
COPY app ./app
COPY pyproject.toml ./

RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/readyz" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "uvicorn app.http.app:app --host 0.0.0.0 --port ${PORT:-3000}"]
