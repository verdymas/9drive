from __future__ import annotations

from tests.conftest import signed_headers


PROVIDER = "acct-1"
CHANNEL = "1490000000000000001"
MESSAGE = "42"


def _stream_path() -> str:
    return f"/v1/stream?providerId={PROVIDER}&channelId={CHANNEL}&messageId={MESSAGE}&knownSize=10"


def test_full_read_returns_200_with_exact_bytes(client, secret) -> None:
    headers = signed_headers(method="GET", path="/v1/stream", provider_id=PROVIDER,
                              channel_id=CHANNEL, message_id=MESSAGE, range_header=None, secret=secret)
    r = client.get(_stream_path(), headers=headers)
    assert r.status_code == 200
    assert r.headers["Accept-Ranges"] == "bytes"
    assert r.headers["Content-Length"] == "10"
    assert "Content-Range" not in r.headers
    assert r.content == bytes(range(10))


def test_first_range_returns_206_with_exact_bytes(client, secret) -> None:
    headers = signed_headers(method="GET", path="/v1/stream", provider_id=PROVIDER,
                              channel_id=CHANNEL, message_id=MESSAGE, range_header="bytes=0-3", secret=secret)
    r = client.get(_stream_path(), headers={"Range": "bytes=0-3", **headers})
    assert r.status_code == 206
    assert r.headers["Content-Range"] == "bytes 0-3/10"
    assert r.headers["Content-Length"] == "4"
    assert r.content == bytes(range(4))


def test_middle_range_returns_206(client, secret) -> None:
    headers = signed_headers(method="GET", path="/v1/stream", provider_id=PROVIDER,
                              channel_id=CHANNEL, message_id=MESSAGE, range_header="bytes=4-7", secret=secret)
    r = client.get(_stream_path(), headers={"Range": "bytes=4-7", **headers})
    assert r.status_code == 206
    assert r.headers["Content-Range"] == "bytes 4-7/10"
    assert r.content == bytes(range(4, 8))


def test_open_ended_range_returns_206_to_eof(client, secret) -> None:
    headers = signed_headers(method="GET", path="/v1/stream", provider_id=PROVIDER,
                              channel_id=CHANNEL, message_id=MESSAGE, range_header="bytes=7-", secret=secret)
    r = client.get(_stream_path(), headers={"Range": "bytes=7-", **headers})
    assert r.status_code == 206
    assert r.headers["Content-Range"] == "bytes 7-9/10"
    assert r.content == bytes(range(7, 10))


def test_suffix_range_returns_last_n_bytes(client, secret) -> None:
    headers = signed_headers(method="GET", path="/v1/stream", provider_id=PROVIDER,
                              channel_id=CHANNEL, message_id=MESSAGE, range_header="bytes=-3", secret=secret)
    r = client.get(_stream_path(), headers={"Range": "bytes=-3", **headers})
    assert r.status_code == 206
    assert r.headers["Content-Range"] == "bytes 7-9/10"
    assert r.content == bytes(range(7, 10))


def test_invalid_range_returns_416_with_content_range(client, secret) -> None:
    headers = signed_headers(method="GET", path="/v1/stream", provider_id=PROVIDER,
                              channel_id=CHANNEL, message_id=MESSAGE, range_header="bytes=100-200", secret=secret)
    r = client.get(_stream_path(), headers={"Range": "bytes=100-200", **headers})
    assert r.status_code == 416
    assert r.headers["Content-Range"] == "bytes */10"
    assert r.json()["error"]["code"] == "RANGE_NOT_SATISFIABLE"


def test_unsatisfiable_start_eq_total_returns_416(client, secret) -> None:
    headers = signed_headers(method="GET", path="/v1/stream", provider_id=PROVIDER,
                              channel_id=CHANNEL, message_id=MESSAGE, range_header="bytes=10-20", secret=secret)
    r = client.get(_stream_path(), headers={"Range": "bytes=10-20", **headers})
    assert r.status_code == 416
    assert r.headers["Content-Range"] == "bytes */10"


def test_malformed_range_header_returns_416(client, secret) -> None:
    headers = signed_headers(method="GET", path="/v1/stream", provider_id=PROVIDER,
                              channel_id=CHANNEL, message_id=MESSAGE, range_header="bytes=foo", secret=secret)
    r = client.get(_stream_path(), headers={"Range": "bytes=foo", **headers})
    assert r.status_code == 416


def test_zero_size_returns_404(client, secret) -> None:
    path = f"/v1/stream?providerId={PROVIDER}&channelId={CHANNEL}&messageId={MESSAGE}&knownSize=0"
    headers = signed_headers(method="GET", path="/v1/stream", provider_id=PROVIDER,
                              channel_id=CHANNEL, message_id=MESSAGE, range_header=None, secret=secret)
    r = client.get(path, headers=headers)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "FILE_NOT_FOUND"
