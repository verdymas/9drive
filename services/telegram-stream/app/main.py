"""FastAPI app factory. One place to mount routers + register error handlers."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api import health, stream
from app.core.errors import AppError, register_error_handlers
from app.core.config import settings
from app.observability import emit
from app.telegram.engine import clients, effective_request_size


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Log the config that matters once at boot (numbers only, no secrets) so a
    # misconfigured chunk size can never silently change what is on the wire.
    effective = effective_request_size()
    if effective != settings.chunk_size_bytes:
        emit(
            "startup_warning",
            # `code` is a redaction key; use the error_code convention.
            warning_code="CHUNK_SIZE_CLAMPED",
            configured_chunk_size_bytes=settings.chunk_size_bytes,
            effective_request_size_bytes=effective,
        )
    emit(
        "startup",
        effective_request_size_bytes=effective,
        resolver_ttl_seconds=settings.effective_resolver_ttl_seconds,
        prefetch_depth_configured=settings.effective_prefetch_depth,
    )
    yield
    await clients.shutdown()


def create_app() -> FastAPI:
    app = FastAPI(title="telegram-stream", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.include_router(health.router)
    app.include_router(stream.router)
    register_error_handlers(app)

    # 416 must include Content-Range per RFC 7233; we wire it as a specific handler
    # for the range errors raised inside the stream module.
    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError) -> JSONResponse:
        if exc.code == "RANGE_NOT_SATISFIABLE" and isinstance(exc.details, dict):
            total = int(exc.details.get("total", 0))
            return JSONResponse(
                status_code=416,
                content={"error": {"code": exc.code, "message": exc.message}},
                headers={"Content-Range": f"bytes */{total}"},
            )
        return JSONResponse(status_code=exc.status, content={"error": {"code": exc.code, "message": exc.message}})

    return app
