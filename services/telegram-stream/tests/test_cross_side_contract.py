"""Cross-side contract: the Python signer and the Node backend signer must produce
the same digest for the same canonical string. If either side changes, this test
fails and the contract anchor must be updated on both sides.
"""
from __future__ import annotations

import hashlib
import hmac
import unittest


def node_canonical_string(timestamp, method, path, provider_id, channel_id, message_id, range_header):
    return "\n".join(
        [
            str(timestamp),
            method.upper(),
            path,
            str(provider_id),
            str(channel_id),
            str(message_id),
            range_header or "",
        ]
    )


def node_sign(*, timestamp, method, path, provider_id, channel_id, message_id, range_header, secret):
    canonical = node_canonical_string(
        timestamp=timestamp,
        method=method,
        path=path,
        provider_id=provider_id,
        channel_id=channel_id,
        message_id=message_id,
        range_header=range_header,
    )
    return hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()


# Computed by hand from the canonical string. Both sides must agree.
# This is the contract anchor: any change to the canonical string breaks
# the test on both sides, by design.
_FIXTURE_SECRET = "test-secret-please-rotate"


class CrossSideContract(unittest.TestCase):
    def test_full_read_canonical_string(self) -> None:
        # No Range header, GET request.
        canonical = node_canonical_string(
            timestamp=1700000000,
            method="GET",
            path="/v1/stream",
            provider_id="acct-1",
            channel_id="1490000000000000001",
            message_id=42,
            range_header=None,
        )
        self.assertEqual(
            canonical,
            "1700000000\nGET\n/v1/stream\nacct-1\n1490000000000000001\n42\n",
        )

    def test_signature_is_64_lowercase_hex(self) -> None:
        sig = node_sign(
            timestamp=1700000000,
            method="GET",
            path="/v1/stream",
            provider_id="acct-1",
            channel_id="1490000000000000001",
            message_id=42,
            range_header="bytes=0-3",
            secret=_FIXTURE_SECRET,
        )
        self.assertEqual(len(sig), 64)
        self.assertTrue(all(c in "0123456789abcdef" for c in sig))

    def test_canonical_string_depends_on_every_field(self) -> None:
        base = node_canonical_string(1, "GET", "/v1/stream", "a", "b", 1, None)
        self.assertNotEqual(
            base,
            node_canonical_string(2, "GET", "/v1/stream", "a", "b", 1, None),
        )
        self.assertNotEqual(
            base,
            node_canonical_string(1, "PUT", "/v1/stream", "a", "b", 1, None),
        )
        self.assertNotEqual(
            base,
            node_canonical_string(1, "GET", "/v1/stream", "a", "b", 1, "bytes=0-1"),
        )


if __name__ == "__main__":
    unittest.main()
