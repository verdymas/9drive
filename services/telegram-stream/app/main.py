"""FastAPI app factory. One place to mount routers + register error handlers."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api import health, stream
from app.core.errors import AppError, register_error_handlers
from app.core.config import settings
from app.telegram.engine import clients


@asynccontextmanager
async def lifespan(_: FastAPI):
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
