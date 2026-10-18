from __future__ import annotations

import io
import json
import os
import sys
import time
from contextlib import redirect_stdout

import pytest

from app import observability as obs


def _capture_emit(fn, *args, **kwargs) -> dict:
    buf = io.StringIO()
    with redirect_stdout(buf):
        fn(*args, **kwargs)
    line = buf.getvalue().strip().splitlines()[-1]
    return json.loads(line)


def test_redact_known_keys() -> None:
    payload = _capture_emit(obs.emit, "x", session="abc", api_hash="xyz", ok=True)
    assert "session" not in payload
    assert "api_hash" not in payload
    assert payload["ok"] is True
    assert payload["event"] == "x"


def test_redact_long_base64_values() -> None:
    long = "A" * 80
    payload = _capture_emit(obs.emit, "x", value=long)
    assert payload["value"] == "[REDACTED]"


def test_redact_preserves_short_values() -> None:
    payload = _capture_emit(obs.emit, "x", value="abc")
    assert payload["value"] == "abc"


def test_redact_nested_dict() -> None:
    payload = _capture_emit(obs.emit, "x", nested={"session": "a", "ok": 1})
    assert "session" not in payload["nested"]
    assert payload["nested"]["ok"] == 1


def test_redact_list() -> None:
    payload = _capture_emit(obs.emit, "x", values=["a", "session_string" + "Z" * 80])
    assert payload["values"][0] == "a"
    assert payload["values"][1] == "[REDACTED]"


def test_active_streams_counters() -> None:
    obs.ACTIVE_STREAMS = 0
    obs.TOTAL_STREAMS = 0
    obs.inc_active()
    obs.inc_active()
    obs.dec_active()
    assert obs.ACTIVE_STREAMS == 1
    assert obs.TOTAL_STREAMS == 2


def test_ready_reflects_live_counters() -> None:
    """/ready must read the counters at request time, not at import time."""
    from fastapi.testclient import TestClient

    from app.main import create_app

    obs.ACTIVE_STREAMS = 0
    obs.TOTAL_STREAMS = 0
    with TestClient(create_app()) as client:
        obs.inc_active()
        body = client.get("/ready").json()
    assert body["active_streams"] == 1
    assert body["total_streams"] == 1


def test_ready_surfaces_prefetch_flag_and_cdn_counter() -> None:
    """P0 scaffolding must be operator-visible: configured depth + CDN hits."""
    from fastapi.testclient import TestClient

    from app.main import create_app

    obs.TOTAL_CDN_REDIRECTS = 0
    obs.inc_cdn_redirect()
    with TestClient(create_app()) as client:
        body = client.get("/ready").json()
    assert body["total_cdn_redirects"] == 1
    assert body["prefetch_depth_configured"] == 0


def test_startup_log_reports_effective_config() -> None:
    """P1: boot logs the numbers that decide what is on the wire."""
    from fastapi.testclient import TestClient

    from app.main import create_app

    buf = io.StringIO()
    with redirect_stdout(buf):
        with TestClient(create_app()):
            pass
    payloads = [json.loads(line) for line in buf.getvalue().strip().splitlines() if line.strip()]
    startup = next(p for p in payloads if p.get("event") == "startup")
    assert startup["effective_request_size_bytes"] == 512 * 1024
    assert startup["resolver_ttl_seconds"] == 60
    assert startup["prefetch_depth_configured"] == 0


def test_startup_warning_when_chunk_size_is_clamped(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from app.core.config import settings
    from app.main import create_app

    monkeypatch.setattr(settings, "chunk_size_bytes", 9000)
    buf = io.StringIO()
    with redirect_stdout(buf):
        with TestClient(create_app()):
            pass
    payloads = [json.loads(line) for line in buf.getvalue().strip().splitlines() if line.strip()]
    warning = next(p for p in payloads if p.get("event") == "startup_warning")
    assert warning["warning_code"] == "CHUNK_SIZE_CLAMPED"
    assert warning["configured_chunk_size_bytes"] == 9000
    assert warning["effective_request_size_bytes"] == 8192


def test_stream_metrics_finish() -> None:
    m = obs.StreamMetrics(
        request_id="r1",
        provider_id="acct-1",
        channel_id="-1001",
        message_id="42",
        file_size=100,
        range_start=0,
        range_end=99,
        resolve_ms=123,
        dc_id=5,
        iterator="_DirectDownloadIter",
    )
    m.mark_first_byte()
    m.add_chunk(64)
    m.add_chunk(36)
    buf = io.StringIO()
    with redirect_stdout(buf):
        m.finish(206)
    payload = json.loads(buf.getvalue().strip().splitlines()[-1])
    assert payload["event"] == "stream_end"
    assert payload["bytes"] == 100
    assert payload["chunks"] == 2
    assert payload["status"] == 206
    assert payload["cancelled"] is False
    assert payload["resolve_ms"] == 123
    assert payload["dc_id"] == 5
    assert payload["iterator"] == "_DirectDownloadIter"
    assert payload["prefetch_depth"] == 0
