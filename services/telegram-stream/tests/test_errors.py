from __future__ import annotations

from app.core.errors import AppError


def test_app_error_serializes_to_envelope() -> None:
    e = AppError("X", "msg", 400, details={"a": 1})
    # The shape: just check the fields used by the error handler.
    assert e.code == "X"
    assert e.status == 400
    assert e.details == {"a": 1}
