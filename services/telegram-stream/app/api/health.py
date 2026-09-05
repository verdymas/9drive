"""Liveness + readiness. No secrets in the response. The values here are deliberately small."""
from __future__ import annotations

from fastapi import APIRouter

# Import the module, not the names: `from ... import ACTIVE_STREAMS` binds the
# int once at import and /ready would report 0 forever.
from app import observability as obs

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
        "active_streams": obs.ACTIVE_STREAMS,
        "total_streams": obs.TOTAL_STREAMS,
        "total_cancellations": obs.TOTAL_CANCELLATIONS,
        "total_file_reference_refreshes": obs.TOTAL_FILE_REFERENCE_REFRESHES,
        "total_flood_waits": obs.TOTAL_FLOOD_WAITS,
    }
