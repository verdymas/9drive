from __future__ import annotations


def test_health_returns_ok(client) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "telegram-stream"
    # No secrets must leak from /health.
    forbidden = {"internal_secret", "token", "session", "api_hash", "api_id"}
    assert not (forbidden & set(body.keys()))
