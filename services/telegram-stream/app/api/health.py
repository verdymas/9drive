"""Liveness + readiness. No secrets in the response. The values here are deliberately small."""
from __future__ import annotations

from fastapi import APIRouter

from app.observability import (
    ACTIVE_STREAMS,
    TOTAL_CANCELLATIONS,
    TOTAL_FILE_REFERENCE_REFRESHES,
    TOTAL_FLOOD_WAITS,
    TOTAL_STREAMS,
)

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, object]:
    # Liveness: the process is up. Readiness is implied by being able to
    # answer /health; we do not probe Telegram here.
    return {
        "status": "ok",
        "service": "telegram-stream",
    }


@router.get("/ready")
async def ready() -> dict[str, object]:
    return {
        "status": "ok",
        "active_streams": ACTIVE_STREAMS,
        "total_streams": TOTAL_STREAMS,
        "total_cancellations": TOTAL_CANCELLATIONS,
        "total_file_reference_refreshes": TOTAL_FILE_REFERENCE_REFRESHES,
        "total_flood_waits": TOTAL_FLOOD_WAITS,
    }
