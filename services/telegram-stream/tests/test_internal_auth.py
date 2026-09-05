from __future__ import annotations

import time

from tests.conftest import signed_headers


PROVIDER = "acct-1"
CHANNEL = "1490000000000000001"
MESSAGE = "42"


def _path() -> str:
    return f"/v1/stream?providerId={PROVIDER}&channelId={CHANNEL}&messageId={MESSAGE}&knownSize=10"


def test_missing_signature_header_is_401(client) -> None:
    r = client.get(_path())
    assert r.status_code in (401, 422)


def test_valid_signature_passes(client, secret) -> None:
    headers = signed_headers(method="GET", path="/v1/stream", provider_id=PROVIDER,
                              channel_id=CHANNEL, message_id=MESSAGE, range_header="bytes=0-3", secret=secret)
    r = client.get(_path(), headers={"Range": "bytes=0-3", **headers})
    assert r.status_code == 206


def test_tampered_signature_is_401(client, secret) -> None:
    headers = signed_headers(method="GET", path="/v1/stream", provider_id=PROVIDER,
                              channel_id=CHANNEL, message_id=MESSAGE, range_header=None, secret=secret)
    headers = {**headers, "X-Stream-Signature": "0" * 64}
    r = client.get(_path(), headers=headers)
    assert r.status_code == 401


def test_expired_timestamp_is_401(client, secret) -> None:
    stale_ts = int(time.time()) - 10_000
    headers = signed_headers(method="GET", path="/v1/stream", provider_id=PROVIDER,
                              channel_id=CHANNEL, message_id=MESSAGE, range_header=None,
                              secret=secret, ts=stale_ts)
    r = client.get(_path(), headers=headers)
    assert r.status_code == 401


def test_range_tamper_is_401(client, secret) -> None:
    # Sign for one range, send a different one.
    headers = signed_headers(method="GET", path="/v1/stream", provider_id=PROVIDER,
                              channel_id=CHANNEL, message_id=MESSAGE, range_header="bytes=0-3", secret=secret)
    r = client.get(_path(), headers={"Range": "bytes=4-9", **headers})
    assert r.status_code == 401


def test_missing_identity_field_is_400(client, secret) -> None:
    headers = signed_headers(method="GET", path="/v1/stream", provider_id=PROVIDER,
                              channel_id=CHANNEL, message_id=MESSAGE, range_header=None, secret=secret)
    r = client.get("/v1/stream?channelId=x&messageId=1&knownSize=10", headers=headers)
    assert r.status_code == 400
