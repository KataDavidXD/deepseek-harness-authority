from __future__ import annotations

import math
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, TypeVar

from .client import HarnessClient, HarnessConfig
from .errors import (
    AttemptTimeoutError,
    RuntimeBindingMismatchError,
    RuntimeGenerationMismatchError,
    SdkProtocolError,
)
from .models import (
    AttemptReceipt,
    JsonObject,
    Notification,
    RuntimeBindingEnvelope,
    RuntimeProcessBinding,
    TerminalAttemptReceipt,
)

DEFAULT_ATTEMPT_TIMEOUT_SECONDS = 300.0
DEFAULT_ATTEMPT_POLL_INTERVAL_SECONDS = 1.0
AttemptResultT = TypeVar("AttemptResultT")


@dataclass(slots=True)
class DeepSeekHarnessConfig:
    """Configuration for launching the local DeepSeek Harness SDK runtime.

    The runtime inherits the caller's environment by default, so existing
    DEEPSEEK_API_KEY and DEEPSEEK_BASE_URL settings keep working. Use ``env`` to
    intentionally override or inject variables for a subprocess.
    """

    provider: str = "deepseek-official"
    model: str = "deepseek-v4-flash"
    max_tokens: int | None = None
    cwd: str | None = None
    runtime_cwd: str | None = None
    session_root: str | None = None
    cordis: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    runtime_bin: str | None = None
    launch_args_override: tuple[str, ...] | None = None
    request_timeout_seconds: float | None = None
    shutdown_timeout_seconds: float | None = 1.0
    base_url: str | None = None
    api_key: str | None = None


@dataclass(slots=True)
class RunResult:
    session_id: str
    final_response: str
    finish_reason: str | None
    events: list[JsonObject]
    notifications: list[Notification]
    session_root: str | None = None
    message_id: str | None = None
    attempt_id: str | None = None
    input_sha256: str | None = None
    deduplicated: bool = False
    terminal_event_seq: int | None = None
    turn: int | None = None
    runtime_binding: RuntimeBindingEnvelope | None = None


class DeepSeekHarness:
    """Reusable synchronous SDK for running DeepSeek Harness agent turns.

    The runtime subprocess starts lazily and remains owned by this instance
    across calls to :meth:`run`. Use the instance as a context manager, or call
    :meth:`close` explicitly when finished, so the subprocess is always reaped.
    """

    def __init__(self, config: DeepSeekHarnessConfig | None = None, **kwargs: object) -> None:
        if config is not None and kwargs:
            raise TypeError("pass either DeepSeekHarnessConfig or keyword options, not both")
        self.config = config or DeepSeekHarnessConfig(**kwargs)
        cwd = str(Path(self.config.cwd or Path.cwd()).resolve())
        runtime_cwd = str(Path(self.config.runtime_cwd).resolve()) if self.config.runtime_cwd is not None else cwd
        self._cwd = cwd
        env = dict(self.config.env)
        if self.config.session_root is not None:
            env["DSH_SESSION_ROOT"] = self.config.session_root
        if self.config.cordis is not None:
            env["DSH_CORDIS_CONFIG"] = self.config.cordis
        env["DSH_CWD"] = cwd
        if self.config.base_url is not None:
            env["DEEPSEEK_BASE_URL"] = self.config.base_url
        if self.config.api_key is not None:
            env["DEEPSEEK_API_KEY"] = self.config.api_key

        self._client_config = HarnessConfig(
            runtime_bin=self.config.runtime_bin,
            launch_args_override=self.config.launch_args_override,
            cwd=runtime_cwd,
            env=env,
            request_timeout_seconds=self.config.request_timeout_seconds,
            shutdown_timeout_seconds=self.config.shutdown_timeout_seconds,
        )
        self._client = HarnessClient(self._client_config)
        self._initialized = False
        self._closed = False
        self._lifecycle_lock = threading.RLock()
        self._runtime_binding: RuntimeBindingEnvelope | None = None

    def __enter__(self) -> "DeepSeekHarness":
        self.start()
        return self

    def __exit__(self, _exc_type, _exc, _tb) -> None:
        self.close()

    @property
    def client(self) -> HarnessClient:
        return self._client

    def start(self) -> None:
        with self._lifecycle_lock:
            if self._closed:
                raise SdkProtocolError("DeepSeek Harness SDK is closed")
            if self._initialized and self._client.is_running:
                return
            previous = self._client if self._initialized else None
            if previous is not None:
                self._client = HarnessClient(self._client_config)
                self._initialized = False
                previous.close()
            current = self._client
            try:
                current.start()
                initialized = current.initialize(
                    cwd=self._cwd,
                    provider=self.config.provider,
                    model=self.config.model,
                    max_tokens=self.config.max_tokens,
                )
                if initialized.runtime_binding is not None:
                    self._pin_runtime_binding(initialized.runtime_binding)
                self._initialized = True
            except BaseException:
                current.close()
                if not self._closed and self._client is current:
                    self._client = HarnessClient(self._client_config)
                self._initialized = False
                raise

    def get_runtime_binding(self) -> RuntimeBindingEnvelope:
        """Initialize without a prompt and return a detached store binding."""
        self.start()
        if self._runtime_binding is None:
            raise SdkProtocolError("initialize returned no persistence runtime binding")
        return self._runtime_binding.model_copy(deep=True)

    def get_runtime_process_binding(self) -> RuntimeProcessBinding:
        """Initialize and atomically capture the store and live subprocess generation.

        The opaque generation can fence a later :meth:`run` against SDK child
        replacement between configuration validation and attempt admission.

        @returns A detached store binding paired with the current live process generation.
        @raises SdkProtocolError If initialization supplies no persistence binding or exits.
        """
        with self._lifecycle_lock:
            self.start()
            if self._runtime_binding is None:
                raise SdkProtocolError("initialize returned no persistence runtime binding")
            generation = self._client.process_generation
            if generation is None or not self._client.is_running:
                raise SdkProtocolError(
                    "DeepSeek Harness runtime exited before its process binding was captured"
                )
            return RuntimeProcessBinding(
                runtime_binding=self._runtime_binding.model_copy(deep=True),
                process_generation=generation,
            )

    def close(self) -> None:
        with self._lifecycle_lock:
            self._closed = True
            self._client.close()
            self._initialized = False

    def _pin_runtime_binding(self, binding: RuntimeBindingEnvelope) -> None:
        """Preserve the first binding across subprocess generations."""
        if self._runtime_binding is None:
            self._runtime_binding = binding.model_copy(deep=True)
            return
        if self._runtime_binding != binding:
            raise RuntimeBindingMismatchError(self._runtime_binding, binding)

    def start_session(
        self,
        session_id: str | None = None,
        *,
        expected_process_generation: str | None = None,
    ) -> Session:
        """Capture one initialized client for a session operation.

        Supplying ``expected_process_generation`` never starts or replaces a
        subprocess. It requires the exact already-initialized client to remain live.

        @param session_id Optional caller-owned session id.
        @param expected_process_generation Opaque generation captured before dispatch.
        @returns A session pinned to the captured client.
        @raises RuntimeGenerationMismatchError If the fenced subprocess is absent or changed.
        """
        with self._lifecycle_lock:
            if expected_process_generation is None:
                self.start()
            else:
                self._require_expected_process_generation(
                    expected_process_generation,
                )
            return Session(
                self,
                session_id or f"session-{uuid.uuid4().hex}",
                self._client,
                expected_process_generation=expected_process_generation,
            )

    def run(
        self,
        input: str | list[JsonObject],
        *,
        session_id: str | None = None,
        attempt_id: str | None = None,
        input_sha256: str | None = None,
        attempt_timeout_seconds: float = DEFAULT_ATTEMPT_TIMEOUT_SECONDS,
        attempt_poll_interval_seconds: float = DEFAULT_ATTEMPT_POLL_INTERVAL_SECONDS,
        expected_process_generation: str | None = None,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> RunResult:
        durable = _validate_durable_pair(attempt_id, input_sha256)
        if durable:
            _durable_attempt_timing(attempt_timeout_seconds, attempt_poll_interval_seconds)
        return self.start_session(
            session_id,
            expected_process_generation=expected_process_generation,
        ).run(
            input,
            attempt_id=attempt_id,
            input_sha256=input_sha256,
            attempt_timeout_seconds=attempt_timeout_seconds,
            attempt_poll_interval_seconds=attempt_poll_interval_seconds,
            on_notification=on_notification,
        )

    def get_attempt(
        self,
        *,
        session_id: str,
        attempt_id: str,
        input_sha256: str,
    ) -> AttemptReceipt | None:
        """Read one exact durable attempt without creating it."""
        self.start()
        return self._client.get_attempt(session_id, attempt_id, input_sha256)

    def cancel_attempt(
        self,
        *,
        session_id: str,
        attempt_id: str,
        input_sha256: str,
        expected_process_generation: str | None = None,
    ) -> TerminalAttemptReceipt:
        """Cancel one exact durable attempt and return terminal proof.

        Supplying ``expected_process_generation`` never starts or replaces a
        subprocess. The cancellation is rejected unless that exact initialized
        process is still live.
        """
        with self._lifecycle_lock:
            if expected_process_generation is None:
                self.start()
            else:
                self._require_expected_process_generation(
                    expected_process_generation,
                )
            client = self._client
        return client.cancel_attempt(
            session_id,
            attempt_id,
            input_sha256,
            expected_process_generation=expected_process_generation,
        )

    def _require_expected_process_generation(self, expected: str) -> None:
        """Validate a generation fence while the lifecycle lock is held."""
        if not isinstance(expected, str) or not expected:
            raise TypeError("expected_process_generation must be a non-empty string")
        if self._closed:
            raise RuntimeGenerationMismatchError(
                expected,
                self._client.process_generation,
                live=False,
            )
        if not self._initialized:
            raise RuntimeGenerationMismatchError(
                expected,
                self._client.process_generation,
                live=self._client.is_running,
            )
        self._client.require_process_generation(expected)


class Session:
    def __init__(
        self,
        harness: DeepSeekHarness,
        session_id: str,
        client: HarnessClient,
        *,
        expected_process_generation: str | None = None,
    ) -> None:
        self.harness = harness
        self.id = session_id
        self._client = client
        self._expected_process_generation = expected_process_generation

    def run(
        self,
        input: str | list[JsonObject],
        *,
        attempt_id: str | None = None,
        input_sha256: str | None = None,
        attempt_timeout_seconds: float = DEFAULT_ATTEMPT_TIMEOUT_SECONDS,
        attempt_poll_interval_seconds: float = DEFAULT_ATTEMPT_POLL_INTERVAL_SECONDS,
        on_notification: Callable[[Notification], None] | None = None,
    ) -> RunResult:
        durable = _validate_durable_pair(attempt_id, input_sha256)
        attempt_timing = (
            _durable_attempt_timing(attempt_timeout_seconds, attempt_poll_interval_seconds)
            if durable
            else None
        )
        content_blocks = normalize_input(input)
        notifications: list[Notification] = []
        events: list[JsonObject] = []
        client = self._client
        if self._expected_process_generation is not None:
            client.require_process_generation(self._expected_process_generation)

        def collect(notification: Notification) -> None:
            notifications.append(notification)
            if on_notification is not None:
                on_notification(notification)
            if (
                notification.method == "session.event"
                and notification.payload.get("sessionId") == self.id
            ):
                event = notification.payload.get("event")
                if isinstance(event, dict):
                    events.append(event)

        deduplicated = False
        terminal: TerminalAttemptReceipt | None = None
        observed_turn: int | None = None
        with client.subscribe_session_notifications(self.id) as subscription:
            if not durable:
                message_id = client.session_prompt(
                    self.id,
                    content_blocks,
                    notification_subscription=subscription,
                )

                received = False
                while True:
                    notification = subscription.next()
                    if not received:
                        if not _is_inbox_receipt(notification, self.id, message_id):
                            continue
                        received = True
                    collect(notification)
                    if _is_root_idle(notification, self.id):
                        break
            else:
                assert attempt_id is not None and input_sha256 is not None
                assert attempt_timing is not None
                timeout_seconds, poll_interval_seconds = attempt_timing
                deadline = time.monotonic() + timeout_seconds
                started = _attempt_request_before_deadline(
                    self.id,
                    attempt_id,
                    timeout_seconds,
                    deadline,
                    lambda remaining: client.start_attempt(
                        self.id,
                        attempt_id,
                        input_sha256,
                        content_blocks,
                        timeout_seconds=remaining,
                        notification_subscription=subscription,
                    ),
                )
                message_id = started.attempt.message_id
                deduplicated = started.deduplicated
                if isinstance(started.attempt, TerminalAttemptReceipt):
                    terminal = started.attempt
                else:
                    if started.attempt.status == "running":
                        observed_turn = started.attempt.turn
                    next_poll_at = time.monotonic() + poll_interval_seconds
                    while terminal is None:
                        now = time.monotonic()
                        if now >= deadline:
                            raise _attempt_timeout_error(
                                self.id, attempt_id, timeout_seconds
                            )
                        if now >= next_poll_at:
                            settled = _attempt_request_before_deadline(
                                self.id,
                                attempt_id,
                                timeout_seconds,
                                deadline,
                                lambda remaining: client.get_attempt(
                                    self.id,
                                    attempt_id,
                                    input_sha256,
                                    timeout_seconds=remaining,
                                ),
                            )
                            observed_turn, terminal = _validated_attempt_progress(
                                settled, message_id, observed_turn
                            )
                            next_poll_at = time.monotonic() + poll_interval_seconds
                            continue
                        wait_seconds = max(0.0, min(next_poll_at, deadline) - now)
                        notification = subscription.next_with_timeout(wait_seconds)
                        if notification is None:
                            continue
                        collect(notification)
                        if not _is_root_idle(notification, self.id):
                            continue
                        settled = _attempt_request_before_deadline(
                            self.id,
                            attempt_id,
                            timeout_seconds,
                            deadline,
                            lambda remaining: client.get_attempt(
                                self.id,
                                attempt_id,
                                input_sha256,
                                timeout_seconds=remaining,
                            ),
                        )
                        observed_turn, terminal = _validated_attempt_progress(
                            settled, message_id, observed_turn
                        )
                        next_poll_at = time.monotonic() + poll_interval_seconds

        if durable:
            if terminal is None:
                raise SdkProtocolError("durable attempt settled without terminal proof")
            reason_kind = terminal.finish_reason.get("kind")
            if not isinstance(reason_kind, str):
                raise SdkProtocolError("terminal attempt finishReason.kind must be a string")
            return RunResult(
                session_id=self.id,
                final_response=terminal.final_response,
                finish_reason=reason_kind,
                events=events,
                notifications=notifications,
                session_root=self.harness.config.session_root,
                message_id=terminal.message_id,
                attempt_id=attempt_id,
                input_sha256=input_sha256,
                deduplicated=deduplicated,
                terminal_event_seq=terminal.terminal_event_seq,
                turn=terminal.turn,
                runtime_binding=terminal.runtime_binding,
            )

        return RunResult(
            session_id=self.id,
            final_response=final_response(events),
            finish_reason=finish_reason(events),
            events=events,
            notifications=notifications,
            session_root=self.harness.config.session_root,
            message_id=message_id,
        )

    def get_attempt(self, *, attempt_id: str, input_sha256: str) -> AttemptReceipt | None:
        """Read one durable attempt owned by this session."""
        return self.harness.get_attempt(
            session_id=self.id,
            attempt_id=attempt_id,
            input_sha256=input_sha256,
        )

    def cancel_attempt(self, *, attempt_id: str, input_sha256: str) -> TerminalAttemptReceipt:
        """Cancel one durable attempt owned by this session."""
        return self.harness.cancel_attempt(
            session_id=self.id,
            attempt_id=attempt_id,
            input_sha256=input_sha256,
            expected_process_generation=self._expected_process_generation,
        )


def _is_inbox_receipt(notification: Notification, session_id: str, message_id: str) -> bool:
    if notification.method != "session.event" or notification.payload.get("sessionId") != session_id:
        return False
    event = notification.payload.get("event")
    if not isinstance(event, dict) or event.get("type") != "agent/inbox/spliced":
        return False
    data = event.get("data")
    inserted = data.get("inserted") if isinstance(data, dict) else None
    return isinstance(inserted, list) and any(
        isinstance(message, dict) and message.get("id") == message_id for message in inserted
    )


def _is_root_idle(notification: Notification, session_id: str) -> bool:
    return (
        notification.method == "session.status"
        and notification.payload.get("sessionId") == session_id
        and notification.payload.get("status") == "idle"
    )


def _validate_durable_pair(attempt_id: str | None, input_sha256: str | None) -> bool:
    if (attempt_id is None) != (input_sha256 is None):
        raise TypeError("attempt_id and input_sha256 must be supplied together")
    return attempt_id is not None


def _durable_attempt_timing(
    timeout_seconds: float,
    poll_interval_seconds: float,
) -> tuple[float, float]:
    """Validate bounded durable waiting controls before runtime dispatch."""
    for name, value in (
        ("attempt_timeout_seconds", timeout_seconds),
        ("attempt_poll_interval_seconds", poll_interval_seconds),
    ):
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise TypeError(f"{name} must be a finite positive number")
        if not math.isfinite(value) or value <= 0:
            raise ValueError(f"{name} must be a finite positive number")
    return float(timeout_seconds), float(poll_interval_seconds)


def _attempt_request_before_deadline(
    session_id: str,
    attempt_id: str,
    timeout_seconds: float,
    deadline: float,
    request: Callable[[float], AttemptResultT],
) -> AttemptResultT:
    """Execute one exact attempt request inside the single overall deadline."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise _attempt_timeout_error(session_id, attempt_id, timeout_seconds)
    try:
        return request(remaining)
    except TimeoutError as exc:
        raise _attempt_timeout_error(session_id, attempt_id, timeout_seconds) from exc


def _validated_attempt_progress(
    settled: AttemptReceipt | None,
    message_id: str,
    observed_turn: int | None,
) -> tuple[int | None, TerminalAttemptReceipt | None]:
    """Convert one exact receipt into monotonic client-side progress."""
    if settled is None:
        raise SdkProtocolError(
            "session/attempt.get lost an attempt accepted by session/attempt.start"
        )
    if settled.message_id != message_id:
        raise SdkProtocolError("session/attempt.get changed the accepted message identity")
    if isinstance(settled, TerminalAttemptReceipt):
        if observed_turn is not None and settled.turn != observed_turn:
            raise SdkProtocolError("session/attempt.get changed the owning turn")
        return observed_turn, settled
    if settled.status == "queued":
        if observed_turn is not None:
            raise SdkProtocolError("session/attempt.get regressed a running attempt to queued")
        return observed_turn, None
    return _stable_attempt_turn(observed_turn, settled.turn), None


def _attempt_timeout_error(
    session_id: str,
    attempt_id: str,
    timeout_seconds: float,
) -> AttemptTimeoutError:
    """Build the typed timeout without mutating or canceling runtime-owned work."""
    return AttemptTimeoutError(
        f'durable attempt "{attempt_id}" in session "{session_id}" did not become '
        f"terminal within {timeout_seconds:g}s; the SDK did not cancel it, so call "
        "get_attempt() or cancel_attempt() explicitly"
    )


def _stable_attempt_turn(previous: int | None, current: int | None) -> int | None:
    """Keep a claimed turn stable across running receipts before terminal proof."""
    if previous is not None and current is not None and current != previous:
        raise SdkProtocolError("session/attempt.get changed the owning turn")
    return current if current is not None else previous


def normalize_input(input: str | list[JsonObject]) -> list[JsonObject]:
    if isinstance(input, str):
        return [{"type": "text", "text": input}]
    return input


def final_response(events: list[JsonObject]) -> str:
    for event in reversed(events):
        if event.get("type") != "assistant/message":
            continue
        data = event.get("data")
        if not isinstance(data, dict):
            continue
        message = data.get("message")
        content_owner = message if isinstance(message, dict) else data
        content = content_owner.get("content")
        if not isinstance(content, list):
            continue
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
        return "".join(parts)
    return ""


def finish_reason(events: list[JsonObject]) -> str | None:
    """Return the last turn-ending kind.

    The input must contain root-session events from one owned run interval.

    Raises:
        SdkProtocolError: The last ``turn/end`` has no string reason kind.
    """
    for event in reversed(events):
        if event.get("type") != "turn/end":
            continue
        data = event.get("data")
        reason = data.get("reason") if isinstance(data, dict) else None
        kind = reason.get("kind") if isinstance(reason, dict) else None
        if not isinstance(kind, str):
            raise SdkProtocolError("turn/end event requires a string data.reason.kind")
        return kind
    return None
