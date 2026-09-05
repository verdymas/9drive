"""Structured errors for telegram-stream. Single error envelope; one place to add codes."""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class AppError(Exception):
    """Raised by handlers/services; mapped to a JSON response with a code + status."""

    def __init__(self, code: str, message: str, status: int, *, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details or {}


def _envelope(error: AppError) -> dict[str, Any]:
    return {
        "error": {
            "code": error.code,
            "message": error.message,
            **({"details": error.details} if error.details else {}),
        }
    }


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        # Redact: never log exc.message with session/api-hash content; we only echo the code.
        return JSONResponse(status_code=exc.status, content=_envelope(exc))
