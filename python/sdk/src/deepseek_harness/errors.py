from __future__ import annotations


class HarnessError(Exception):
    """Base exception for SDK and runtime failures."""


class TransportClosedError(HarnessError):
    """Raised when the runtime subprocess exits or closes stdout."""


class SdkProtocolError(HarnessError):
    """Raised when the runtime sends data outside the SDK protocol."""


class AttemptTimeoutError(HarnessError):
    """Raised when durable terminal proof misses its bounded run deadline."""


class RuntimeBindingMismatchError(HarnessError):
    """Raised when a restarted runtime or receipt addresses another store."""

    def __init__(self, expected: object, actual: object) -> None:
        expected_id = getattr(expected, "persistence_instance_id", "unknown")
        actual_id = getattr(actual, "persistence_instance_id", "unknown")
        super().__init__(f"runtime persistence binding changed from {expected_id} to {actual_id}")
        self.expected = expected
        self.actual = actual


class RuntimeGenerationMismatchError(HarnessError):
    """Raised when a fenced dispatch cannot use its captured live subprocess."""

    def __init__(self, expected: str, actual: str | None, *, live: bool) -> None:
        if actual == expected and not live:
            message = "expected DeepSeek Harness runtime process generation is not live"
        else:
            message = "DeepSeek Harness runtime process generation does not match the expected generation"
        super().__init__(message)
        self.expected = expected
        self.actual = actual
        self.live = live


class JsonRpcError(HarnessError):
    """Raised when the runtime returns a JSON-RPC error response."""

    def __init__(self, code: int | None, message: str, data: object | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data
