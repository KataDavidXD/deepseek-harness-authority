from __future__ import annotations

import inspect
import json
import sys
import threading
import time
from pathlib import Path

import pytest
from deepseek_harness import (
    AttemptTimeoutError,
    DeepSeekHarness,
    HarnessClient,
    HarnessConfig,
    JsonRpcError,
    Notification,
    RuntimeBindingEnvelope,
    RuntimeBindingMismatchError,
    RuntimeGenerationMismatchError,
    SdkProtocolError,
    TransportClosedError,
)
from pydantic import ValidationError

INPUT_SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"


def test_runtime_binding_is_frozen_and_rejects_unknown_fields() -> None:
    binding = RuntimeBindingEnvelope.model_validate({
        "protocolVersion": 1,
        "schemaVersion": 2,
        "persistenceInstanceId": "11111111-1111-4111-8111-111111111111",
        "rootConfigSha256": "c" * 64,
    })
    with pytest.raises(ValidationError):
        binding.persistence_instance_id = "22222222-2222-4222-8222-222222222222"
    with pytest.raises(ValidationError):
        RuntimeBindingEnvelope.model_validate({
            **binding.model_dump(by_alias=True),
            "unreviewed": True,
        })


def _binding_runtime(tmp_path: Path) -> tuple[Path, Path, Path, Path]:
    script = tmp_path / "fake_binding_runtime.py"
    binding_file = tmp_path / "binding.txt"
    exit_marker = tmp_path / "first-process-exited"
    init_log = tmp_path / "initialize.log"
    binding_file.write_text("11111111-1111-4111-8111-111111111111\n")
    script.write_text(
        """
import json
import os
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        with open(os.environ["INIT_LOG"], "a") as log:
            log.write("initialize\\n")
        persistence_id = open(os.environ["BINDING_FILE"]).read().strip()
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "serverInfo": {"name": "binding-fake", "version": "1"},
            "runtimeBinding": {"protocolVersion": 1, "schemaVersion": 2,
                               "persistenceInstanceId": persistence_id,
                               "rootConfigSha256": "c" * 64},
        }}), flush=True)
        marker = os.environ["EXIT_MARKER"]
        if not os.path.exists(marker):
            open(marker, "w").write("exited\\n")
            sys.exit(23)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )
    return script, binding_file, exit_marker, init_log


def test_runtime_binding_restarts_same_sdk_and_rejects_another_store(tmp_path: Path) -> None:
    script, binding_file, exit_marker, init_log = _binding_runtime(tmp_path)
    harness = DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
        env={
            "BINDING_FILE": str(binding_file),
            "EXIT_MARKER": str(exit_marker),
            "INIT_LOG": str(init_log),
        },
    )
    try:
        first = harness.get_runtime_binding()
        assert exit_marker.exists()
        time.sleep(0.05)
        assert harness.get_runtime_binding() == first
        assert init_log.read_text().splitlines() == ["initialize", "initialize"]

        harness.client._proc.kill()
        harness.client._proc.wait(timeout=5)
        binding_file.write_text("22222222-2222-4222-8222-222222222222\n")
        with pytest.raises(RuntimeBindingMismatchError):
            harness.get_runtime_binding()
    finally:
        harness.close()


def test_runtime_process_binding_pins_one_live_subprocess(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    method_log = tmp_path / "methods.log"
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
        env={"ATTEMPT_METHOD_LOG": str(method_log), "ATTEMPT_TERMINAL": "1"},
    ) as harness:
        process = harness.get_runtime_process_binding()
        result = harness.run(
            "hello",
            session_id="generation-owner",
            attempt_id="attempt-generation-owner",
            input_sha256=INPUT_SHA256,
            expected_process_generation=process.process_generation,
        )

    assert result.runtime_binding == process.runtime_binding
    assert method_log.read_text().splitlines()[:2] == [
        "initialize",
        "session/attempt.start",
    ]


def test_fenced_generation_rejects_dead_child_without_redispatch(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    method_log = tmp_path / "methods.log"
    harness = DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
        env={"ATTEMPT_METHOD_LOG": str(method_log), "ATTEMPT_TERMINAL": "1"},
    )
    try:
        process = harness.get_runtime_process_binding()
        assert harness.client._proc is not None
        harness.client._proc.kill()
        harness.client._proc.wait(timeout=5)

        with pytest.raises(RuntimeGenerationMismatchError):
            harness.run(
                "must not dispatch",
                session_id="dead-generation",
                attempt_id="attempt-dead-generation",
                input_sha256=INPUT_SHA256,
                expected_process_generation=process.process_generation,
            )

        assert method_log.read_text().splitlines() == ["initialize"]
    finally:
        harness.close()


def test_fenced_generation_rejects_foreign_live_child_without_dispatch(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    method_log = tmp_path / "methods.log"
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
        env={"ATTEMPT_METHOD_LOG": str(method_log), "ATTEMPT_TERMINAL": "1"},
    ) as harness:
        harness.get_runtime_process_binding()
        with pytest.raises(RuntimeGenerationMismatchError):
            harness.run(
                "must not dispatch",
                session_id="foreign-generation",
                attempt_id="attempt-foreign-generation",
                input_sha256=INPUT_SHA256,
                expected_process_generation="foreign-generation-token",
            )

    assert method_log.read_text().splitlines() == ["initialize", "shutdown"]


def test_fenced_cancel_uses_the_captured_live_process_generation(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    method_log = tmp_path / "methods.log"
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
        env={"ATTEMPT_METHOD_LOG": str(method_log), "ATTEMPT_TERMINAL": "1"},
    ) as harness:
        process = harness.get_runtime_process_binding()
        canceled = harness.cancel_attempt(
            session_id="generation-cancel-owner",
            attempt_id="attempt-generation-cancel-owner",
            input_sha256=INPUT_SHA256,
            expected_process_generation=process.process_generation,
        )

    assert canceled.finish_reason["kind"] == "canceled"
    assert method_log.read_text().splitlines() == [
        "initialize",
        "session/attempt.cancel",
        "shutdown",
    ]


def test_fenced_cancel_rejects_dead_child_without_restart_or_cancel_io(
    tmp_path: Path,
) -> None:
    script = _attempt_runtime(tmp_path)
    method_log = tmp_path / "methods.log"
    harness = DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
        env={"ATTEMPT_METHOD_LOG": str(method_log), "ATTEMPT_TERMINAL": "1"},
    )
    try:
        process = harness.get_runtime_process_binding()
        assert harness.client._proc is not None
        harness.client._proc.kill()
        harness.client._proc.wait(timeout=5)

        with pytest.raises(RuntimeGenerationMismatchError):
            harness.cancel_attempt(
                session_id="dead-generation-cancel",
                attempt_id="attempt-dead-generation-cancel",
                input_sha256=INPUT_SHA256,
                expected_process_generation=process.process_generation,
            )

        assert method_log.read_text().splitlines() == ["initialize"]
        assert harness.client.process_generation == process.process_generation
        assert not harness.client.is_running
    finally:
        harness.close()


def test_fenced_cancel_rejects_foreign_live_child_without_cancel_io(
    tmp_path: Path,
) -> None:
    script = _attempt_runtime(tmp_path)
    method_log = tmp_path / "methods.log"
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
        env={"ATTEMPT_METHOD_LOG": str(method_log), "ATTEMPT_TERMINAL": "1"},
    ) as harness:
        harness.get_runtime_process_binding()
        with pytest.raises(RuntimeGenerationMismatchError):
            harness.cancel_attempt(
                session_id="foreign-generation-cancel",
                attempt_id="attempt-foreign-generation-cancel",
                input_sha256=INPUT_SHA256,
                expected_process_generation="foreign-generation-token",
            )

    assert method_log.read_text().splitlines() == ["initialize", "shutdown"]


def _attempt_runtime(tmp_path: Path) -> Path:
    script = tmp_path / "fake_attempt_runtime.py"
    script.write_text(
        """
import json
import os
import sys

attempts = {}
stale_probed = set()
get_counts = {}

def send(frame):
    print(json.dumps(frame), flush=True)

def identity(params, message_id):
    return {
        "sessionId": params["sessionId"],
        "attemptId": "foreign-attempt" if os.environ.get("ATTEMPT_FOREIGN") else params["attemptId"],
        "inputSha256": "f" * 64 if os.environ.get("ATTEMPT_FOREIGN_HASH") else params["inputSha256"],
        "messageId": message_id,
        "runtimeBinding": {"protocolVersion": 1, "schemaVersion": 2,
                           "persistenceInstanceId": "11111111-1111-4111-8111-111111111111",
                           "rootConfigSha256": "c" * 64},
    }

def settle(params, base):
    key = (params["sessionId"], params["attemptId"])
    sid = params["sessionId"]
    send({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": sid, "event": {"type": "assistant/message", "seq": 10, "time": 0, "data": {"turn": 1, "step": 1, "message": {"id": "assistant-1", "role": "assistant", "content": [{"type": "text", "text": "notification text"}], "source": {"kind": "model"}}}}}})
    send({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": sid, "event": {"type": "turn/end", "seq": 11, "time": 0, "data": {"turn": 1, "reason": {"kind": "completed"}}}}})
    terminal_base = dict(base)
    if os.environ.get("ATTEMPT_FOREIGN_MESSAGE"):
        terminal_base["messageId"] = "foreign-message"
    receipt = dict(terminal_base, status="terminal",
                   turn=5 if os.environ.get("ATTEMPT_FOREIGN_TURN") else 1,
                   terminalEventSeq=11, finishReason={"kind": "completed"},
                   finalResponse="receipt answer")
    attempts[key] = receipt
    send({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": sid, "status": "idle"}})

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    params = msg.get("params") or {}
    if os.environ.get("ATTEMPT_METHOD_LOG"):
        with open(os.environ["ATTEMPT_METHOD_LOG"], "a") as method_log:
            method_log.write(method + "\\n")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "serverInfo": {"name": "attempt-fake", "version": "1"},
            "runtimeBinding": {"protocolVersion": 1, "schemaVersion": 2,
                               "persistenceInstanceId": "11111111-1111-4111-8111-111111111111",
                               "rootConfigSha256": "c" * 64},
        }})
    elif method == "session/attempt.start":
        key = (params["sessionId"], params["attemptId"])
        base = identity(params, "message-" + params["attemptId"])
        if os.environ.get("ATTEMPT_NON_OBJECT"):
            send({"jsonrpc": "2.0", "id": msg["id"], "result": []})
        elif os.environ.get("ATTEMPT_BAD_STATUS"):
            send({"jsonrpc": "2.0", "id": msg["id"], "result": {"attempt": dict(base, status="mystery"), "deduplicated": False}})
        elif os.environ.get("ATTEMPT_TERMINAL"):
            receipt = dict(base, status="terminal", turn=7, terminalEventSeq=71,
                           finishReason={"kind": "completed"}, finalResponse="stored answer")
            attempts[key] = receipt
            if os.environ.get("ATTEMPT_TERMINAL_IDLE_BEFORE_RESPONSE"):
                send({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "idle"}})
            send({"jsonrpc": "2.0", "id": msg["id"], "result": {"attempt": receipt, "deduplicated": True}})
        else:
            running_without_notifications = (os.environ.get("ATTEMPT_POLL_TERMINAL")
                                             or os.environ.get("ATTEMPT_PERMANENT_RUNNING"))
            pending = (dict(base, status="running", turn=4)
                       if os.environ.get("ATTEMPT_FOREIGN_TURN") or running_without_notifications
                       else dict(base, status="queued"))
            attempts[key] = pending
            if os.environ.get("ATTEMPT_STALE_IDLE"):
                send({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "idle"}})
            send({"jsonrpc": "2.0", "id": msg["id"], "result": {"attempt": pending, "deduplicated": False}})
            if not os.environ.get("ATTEMPT_STALE_IDLE") and not running_without_notifications:
                settle(params, base)
    elif method == "session/attempt.get":
        if os.environ.get("ATTEMPT_NON_OBJECT"):
            send({"jsonrpc": "2.0", "id": msg["id"], "result": []})
            continue
        key = (params["sessionId"], params["attemptId"])
        observed = attempts.get(key)
        if os.environ.get("ATTEMPT_POLL_TERMINAL") and observed is not None:
            get_counts[key] = get_counts.get(key, 0) + 1
            if get_counts[key] >= 2:
                observed = dict(observed, status="terminal", turn=4, terminalEventSeq=42,
                                finishReason={"kind": "completed"},
                                finalResponse="polled terminal answer")
                attempts[key] = observed
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"attempt": observed}})
        if (os.environ.get("ATTEMPT_STALE_IDLE") and key not in stale_probed
                and observed is not None and observed["status"] == "queued"):
            stale_probed.add(key)
            settle(params, observed)
    elif method == "session/attempt.cancel":
        if os.environ.get("ATTEMPT_NON_OBJECT"):
            send({"jsonrpc": "2.0", "id": msg["id"], "result": []})
            continue
        if os.environ.get("ATTEMPT_CANCEL_ERROR"):
            send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32043, "message": "running attempt is not cancellable"}})
            continue
        key = (params["sessionId"], params["attemptId"])
        prior = attempts.get(key) or identity(params, "message-" + params["attemptId"])
        receipt = dict(prior, status="terminal", terminalEventSeq=99,
                       finishReason={"kind": "canceled"}, finalResponse="")
        attempts[key] = receipt
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"attempt": receipt}})
    elif method == "shutdown":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
        break
""".strip()
    )
    return script


def test_high_level_sdk_runs_turn_and_collects_final_response(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    env_dump = tmp_path / "env.json"
    init_dump = tmp_path / "init.json"
    script.write_text(
        """
import json
import os
import sys

env_dump = os.environ["ENV_DUMP"]
json.dump({
    "DEEPSEEK_API_KEY": os.environ.get("DEEPSEEK_API_KEY"),
    "DEEPSEEK_BASE_URL": os.environ.get("DEEPSEEK_BASE_URL"),
    "DSH_CWD": os.environ.get("DSH_CWD"),
    "DSH_SESSION_ROOT": os.environ.get("DSH_SESSION_ROOT"),
    "DSH_CORDIS_CONFIG": os.environ.get("DSH_CORDIS_CONFIG"),
}, open(env_dump, "w"))

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        json.dump(msg.get("params"), open(os.environ["INIT_DUMP"], "w"))
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {
                "sessionId": params["sessionId"],
                "event": {
                    "type": "assistant/message",
                    "data": {
                        "message": {
                            "role": "assistant",
                            "content": [{"type": "text", "text": "hello from runtime"}],
                        },
                    },
                },
            },
        }), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {
                "sessionId": params["sessionId"],
                "event": {
                    "type": "turn/end",
                    "data": {"turn": 1, "reason": {"kind": "completed"}},
                },
            },
        }), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {
                "sessionId": params["sessionId"],
                "event": {
                    "type": "turn/end",
                    "data": {"turn": 2, "reason": {"kind": "max-tokens"}},
                },
            },
        }), flush=True)
        print(json.dumps({
            "jsonrpc": "2.0",
            "method": "session.status",
            "params": {"sessionId": params["sessionId"], "status": "idle"},
        }), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(
        model="deepseek-v4-flash",
        max_tokens=4096,
        cwd=str(tmp_path),
        cordis=str(tmp_path / "cordis.yml"),
        session_root=str(tmp_path / "sessions"),
        launch_args_override=(sys.executable, str(script)),
        env={
            "ENV_DUMP": str(env_dump),
            "INIT_DUMP": str(init_dump),
            "DEEPSEEK_API_KEY": "env-key",
            "DEEPSEEK_BASE_URL": "http://127.0.0.1:4321",
        },
    ) as harness:
        result = harness.run("say hello", session_id="main")

    assert result.final_response == "hello from runtime"
    assert result.finish_reason == "max-tokens"
    assert result.events[-1]["type"] == "turn/end"
    dumped_env = json.loads(env_dump.read_text())
    assert dumped_env["DEEPSEEK_API_KEY"] == "env-key"
    assert dumped_env["DEEPSEEK_BASE_URL"] == "http://127.0.0.1:4321"
    assert dumped_env["DSH_CWD"] == str(tmp_path)
    assert dumped_env["DSH_SESSION_ROOT"] == str(tmp_path / "sessions")
    assert dumped_env["DSH_CORDIS_CONFIG"] == str(tmp_path / "cordis.yml")
    assert json.loads(init_dump.read_text()) == {
        "cwd": str(tmp_path),
        "provider": "deepseek-official",
        "model": "deepseek-v4-flash",
        "maxTokens": 4096,
    }


def test_high_level_durable_run_returns_deduplicated_terminal_without_notifications(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        env={"ATTEMPT_TERMINAL": "1"},
    ) as harness:
        result = harness.run(
            "ignored duplicate body",
            session_id="durable-terminal",
            attempt_id="attempt-7",
            input_sha256=INPUT_SHA256,
        )
        observed = harness.get_attempt(
            session_id="durable-terminal",
            attempt_id="attempt-7",
            input_sha256=INPUT_SHA256,
        )
        canceled = harness.start_session("durable-terminal").cancel_attempt(
            attempt_id="attempt-7",
            input_sha256=INPUT_SHA256,
        )

    assert result.session_id == "durable-terminal"
    assert result.message_id == "message-attempt-7"
    assert result.attempt_id == "attempt-7"
    assert result.input_sha256 == INPUT_SHA256
    assert result.deduplicated is True
    assert result.final_response == "stored answer"
    assert result.finish_reason == "completed"
    assert result.terminal_event_seq == 71
    assert result.turn == 7
    assert result.runtime_binding is not None
    assert result.runtime_binding.persistence_instance_id == "11111111-1111-4111-8111-111111111111"
    assert result.events == []
    assert result.notifications == []
    assert observed is not None
    assert observed.message_id == result.message_id
    assert canceled.message_id == result.message_id


def test_high_level_durable_run_waits_for_idle_then_gets_exact_terminal(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    with DeepSeekHarness(launch_args_override=(sys.executable, str(script))) as harness:
        result = harness.run(
            "do it once",
            session_id="durable-queued",
            attempt_id="attempt-8",
            input_sha256=INPUT_SHA256,
        )

    assert result.message_id == "message-attempt-8"
    assert result.attempt_id == "attempt-8"
    assert result.input_sha256 == INPUT_SHA256
    assert result.deduplicated is False
    assert result.final_response == "receipt answer"
    assert result.final_response != "notification text"
    assert result.finish_reason == "completed"
    assert result.terminal_event_seq == 11
    assert result.notifications[-1].payload == {"sessionId": "durable-queued", "status": "idle"}


def test_high_level_durable_run_ignores_stale_idle_until_exact_terminal(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        env={"ATTEMPT_STALE_IDLE": "1"},
    ) as harness:
        result = harness.run(
            "do not settle on stale idle",
            session_id="durable-stale-idle",
            attempt_id="attempt-stale-idle",
            input_sha256=INPUT_SHA256,
        )

    assert result.final_response == "receipt answer"
    assert [
        notification.payload
        for notification in result.notifications
        if notification.method == "session.status"
    ] == [
        {"sessionId": "durable-stale-idle", "status": "idle"},
        {"sessionId": "durable-stale-idle", "status": "idle"},
    ]


def test_high_level_durable_run_polls_to_terminal_without_notifications(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        env={"ATTEMPT_POLL_TERMINAL": "1"},
    ) as harness:
        result = harness.run(
            "owned elsewhere",
            session_id="durable-polled",
            attempt_id="attempt-polled",
            input_sha256=INPUT_SHA256,
            attempt_poll_interval_seconds=0.01,
            attempt_timeout_seconds=0.5,
        )

    assert result.final_response == "polled terminal answer"
    assert result.terminal_event_seq == 42
    assert result.turn == 4
    assert result.events == []
    assert result.notifications == []


def test_high_level_durable_run_times_out_without_canceling_attempt(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    method_log = tmp_path / "attempt-methods.txt"
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        env={
            "ATTEMPT_PERMANENT_RUNNING": "1",
            "ATTEMPT_METHOD_LOG": str(method_log),
        },
    ) as harness:
        with pytest.raises(AttemptTimeoutError):
            harness.run(
                "remain owned",
                session_id="durable-timeout",
                attempt_id="attempt-timeout",
                input_sha256=INPUT_SHA256,
                attempt_poll_interval_seconds=0.01,
                attempt_timeout_seconds=0.08,
            )
        observed = harness.get_attempt(
            session_id="durable-timeout",
            attempt_id="attempt-timeout",
            input_sha256=INPUT_SHA256,
        )

    assert observed is not None
    assert observed.status == "running"
    assert observed.turn == 4

    methods = method_log.read_text().splitlines()
    assert "session/attempt.get" in methods
    assert "session/attempt.cancel" not in methods
    assert "shutdown" in methods


def test_high_level_durable_run_requires_stable_running_turn(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        env={"ATTEMPT_FOREIGN_TURN": "1"},
    ) as harness, pytest.raises(SdkProtocolError, match="changed the owning turn"):
        harness.run(
            "foreign turn proof",
            session_id="durable-turn-owner",
            attempt_id="attempt-turn-owner",
            input_sha256=INPUT_SHA256,
        )


def test_high_level_durable_run_terminal_before_response_needs_no_notifications(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        env={"ATTEMPT_TERMINAL": "1", "ATTEMPT_TERMINAL_IDLE_BEFORE_RESPONSE": "1"},
    ) as harness:
        result = harness.run(
            "already done",
            session_id="durable-terminal-buffered-idle",
            attempt_id="attempt-terminal-buffered-idle",
            input_sha256=INPUT_SHA256,
        )

    assert result.deduplicated is True
    assert result.events == []
    assert result.notifications == []


def test_high_level_durable_run_rejects_foreign_terminal_message(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        env={"ATTEMPT_FOREIGN_MESSAGE": "1"},
    ) as harness, pytest.raises(SdkProtocolError, match="changed the accepted message identity"):
        harness.run(
            "foreign message proof",
            session_id="durable-message-owner",
            attempt_id="attempt-message-owner",
            input_sha256=INPUT_SHA256,
        )


def test_high_level_durable_run_requires_attempt_identity_pair_before_dispatch(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    with DeepSeekHarness(launch_args_override=(sys.executable, str(script))) as harness:
        with pytest.raises(TypeError):
            harness.run("bad", attempt_id="attempt-only")
        with pytest.raises(TypeError):
            harness.run("bad", input_sha256=INPUT_SHA256)


def test_high_level_durable_run_rejects_invalid_polling_bounds_before_dispatch(
    tmp_path: Path,
) -> None:
    script = _attempt_runtime(tmp_path)
    harness = DeepSeekHarness(launch_args_override=(sys.executable, str(script)))
    with pytest.raises(ValueError, match="attempt_timeout_seconds"):
        harness.run(
            "bad timeout",
            attempt_id="attempt-bounds",
            input_sha256=INPUT_SHA256,
            attempt_timeout_seconds=0,
        )
    with pytest.raises(ValueError, match="attempt_poll_interval_seconds"):
        harness.run(
            "bad poll",
            attempt_id="attempt-bounds",
            input_sha256=INPUT_SHA256,
            attempt_poll_interval_seconds=float("nan"),
        )


def test_durable_attempt_low_level_get_cancel_and_identity_validation(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    config = HarnessConfig(launch_args_override=(sys.executable, str(script)))
    with HarnessClient(config) as client:
        client.initialize(provider="deepseek-official", cwd=str(tmp_path), model="dsagent")
        started = client.start_attempt(
            "attempt-client",
            "attempt-9",
            INPUT_SHA256,
            [{"type": "text", "text": "hello"}],
        )
        assert started.attempt.message_id == "message-attempt-9"
        observed = client.get_attempt("attempt-client", "attempt-9", INPUT_SHA256)
        assert observed is not None
        assert observed.message_id == started.attempt.message_id
        assert observed.status == "terminal"
        canceled = client.cancel_attempt("attempt-client", "attempt-9", INPUT_SHA256)
        assert canceled.finish_reason["kind"] == "canceled"

    foreign = HarnessConfig(
        launch_args_override=(sys.executable, str(script)),
        env={"ATTEMPT_TERMINAL": "1", "ATTEMPT_FOREIGN": "1"},
    )
    with HarnessClient(foreign) as client:
        client.initialize(provider="deepseek-official", cwd=str(tmp_path), model="dsagent")
        with pytest.raises(SdkProtocolError, match="identity"):
            client.start_attempt(
                "owned-session",
                "owned-attempt",
                INPUT_SHA256,
                [{"type": "text", "text": "bad proof"}],
            )
        with pytest.raises(SdkProtocolError, match="identity"):
            client.get_attempt("owned-session", "owned-attempt", INPUT_SHA256)
        with pytest.raises(SdkProtocolError, match="identity"):
            client.cancel_attempt("owned-session", "owned-attempt", INPUT_SHA256)

    foreign_hash = HarnessConfig(
        launch_args_override=(sys.executable, str(script)),
        env={"ATTEMPT_TERMINAL": "1", "ATTEMPT_FOREIGN_HASH": "1"},
    )
    with HarnessClient(foreign_hash) as client:
        client.initialize(provider="deepseek-official", cwd=str(tmp_path), model="dsagent")
        with pytest.raises(SdkProtocolError, match="identity"):
            client.start_attempt(
                "owned-session",
                "owned-attempt",
                INPUT_SHA256,
                [{"type": "text", "text": "bad hash proof"}],
            )

    cancel_conflict = HarnessConfig(
        launch_args_override=(sys.executable, str(script)),
        env={"ATTEMPT_CANCEL_ERROR": "1"},
    )
    with HarnessClient(cancel_conflict) as client:
        client.initialize(provider="deepseek-official", cwd=str(tmp_path), model="dsagent")
        with pytest.raises(JsonRpcError) as failure:
            client.cancel_attempt("running-session", "running-attempt", INPUT_SHA256)
        assert failure.value.code == -32043


def test_durable_attempt_rejects_unknown_status(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    config = HarnessConfig(
        launch_args_override=(sys.executable, str(script)),
        env={"ATTEMPT_BAD_STATUS": "1"},
    )
    with HarnessClient(config) as client:
        client.initialize(provider="deepseek-official", cwd=str(tmp_path), model="dsagent")
        with pytest.raises(SdkProtocolError, match="invalid receipt"):
            client.start_attempt(
                "owned-session",
                "owned-attempt",
                INPUT_SHA256,
                [{"type": "text", "text": "bad status"}],
            )


def test_durable_attempt_wraps_non_object_results_as_protocol_errors(tmp_path: Path) -> None:
    script = _attempt_runtime(tmp_path)
    config = HarnessConfig(
        launch_args_override=(sys.executable, str(script)),
        env={"ATTEMPT_NON_OBJECT": "1"},
    )
    with HarnessClient(config) as client:
        client.initialize(provider="deepseek-official", cwd=str(tmp_path), model="dsagent")
        with pytest.raises(SdkProtocolError, match="invalid receipt"):
            client.start_attempt(
                "owned-session",
                "owned-attempt",
                INPUT_SHA256,
                [{"type": "text", "text": "invalid wire"}],
            )
        with pytest.raises(SdkProtocolError, match="invalid receipt"):
            client.get_attempt("owned-session", "owned-attempt", INPUT_SHA256)
        with pytest.raises(SdkProtocolError, match="invalid receipt"):
            client.cancel_attempt("owned-session", "owned-attempt", INPUT_SHA256)


def test_session_run_invokes_notification_callback_before_returning(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "main", "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "main", "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.started", "params": {"parentSessionId": "main", "childSessionId": "child"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "main", "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    seen: list[str] = []
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        session = harness.start_session("main")
        result = session.run(
            "spawn a helper",
            on_notification=lambda notification: seen.append(notification.method),
        )

    assert seen == ["session.event", "session.status", "subagent.started", "session.status"]
    assert result.finish_reason is None


def test_high_level_sdk_rejects_turn_end_without_reason_kind(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "turn/end", "data": {"turn": 1, "reason": {}}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        with pytest.raises(
            SdkProtocolError,
            match=r"turn/end event requires a string data\.reason\.kind",
        ):
            harness.run("reject malformed turn ending", session_id="main")


def test_relative_cwd_is_absolute_in_process_environment_and_wire(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    script = tmp_path / "capture_cwd.py"
    capture = tmp_path / "cwd.json"
    script.write_text(
        """
import json
import os
import sys

for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        json.dump({"process": os.getcwd(), "environment": os.environ.get("DSH_CWD"), "wire": msg["params"]["cwd"]}, open(os.environ["CAPTURE"], "w"))
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )
    monkeypatch.chdir(tmp_path)

    with DeepSeekHarness(
        cwd=".",
        runtime_cwd=".",
        launch_args_override=(sys.executable, str(script)),
        env={"CAPTURE": str(capture)},
    ):
        pass

    expected = str(tmp_path.resolve())
    assert json.loads(capture.read_text()) == {
        "process": expected,
        "environment": expected,
        "wire": expected,
    }


def test_session_run_includes_subagent_finished_for_parent_session(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "main", "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "main", "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.started", "params": {"parentSessionId": "main", "childSessionId": "child"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.finished", "params": {"parentSessionId": "main", "childSessionId": "child", "status": "ok", "stopReason": "completed"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "main", "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        result = harness.run("spawn a helper", session_id="main")

    assert [notification.method for notification in result.notifications] == [
        "session.event",
        "session.status",
        "subagent.started",
        "subagent.finished",
        "session.status",
    ]


def test_session_run_collects_nested_subagent_tree_without_polluting_root_events(
    tmp_path: Path,
) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        root = (msg.get("params") or {})["sessionId"]
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": root, "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": root, "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.started", "params": {"parentSessionId": root, "childSessionId": "child"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "child", "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "child response"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.started", "params": {"parentSessionId": "child", "childSessionId": "grandchild"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "grandchild", "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "grandchild response"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.finished", "params": {"parentSessionId": "child", "childSessionId": "grandchild", "status": "ok"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "subagent.finished", "params": {"parentSessionId": root, "childSessionId": "child", "status": "ok"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": root, "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "root response"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": root, "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    seen: list[str] = []
    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        result = harness.run(
            "delegate recursively",
            session_id="main",
            on_notification=lambda notification: seen.append(notification.method),
        )
        assert harness.client._notifications.qsize() == 0

    assert result.final_response == "root response"
    assert [event["data"]["content"][0]["text"] for event in result.events if event["type"] == "assistant/message"] == ["root response"]
    assert [notification.method for notification in result.notifications] == [
        "session.event",
        "session.status",
        "subagent.started",
        "session.event",
        "subagent.started",
        "session.event",
        "subagent.finished",
        "subagent.finished",
        "session.event",
        "session.status",
    ]
    assert seen == [notification.method for notification in result.notifications]


def test_session_run_ignores_notifications_for_other_sessions(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": "other", "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "wrong session"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": "other", "status": "idle"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "right session"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(
        launch_args_override=(sys.executable, str(script)),
        cwd=str(tmp_path),
    ) as harness:
        result = harness.run("stay in your lane", session_id="main")

    assert result.final_response == "right session"
    assert [notification.payload.get("sessionId") for notification in result.notifications] == ["main"] * 4


def test_high_level_session_run_does_not_accumulate_global_notifications(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": "message-1"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": params["sessionId"], "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "ok"}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": params["sessionId"], "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(launch_args_override=(sys.executable, str(script)), cwd=str(tmp_path)) as harness:
        harness.run("one turn", session_id="main")
        assert harness.client._notifications.qsize() == 0


def test_session_run_waits_for_late_idle_without_replaying_stale_notifications(tmp_path: Path) -> None:
    script = tmp_path / "fake_runtime.py"
    script.write_text(
        """
import json
import sys
import time

turn = 0
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-runtime"}}}), flush=True)
    elif method == "session/prompt":
        turn += 1
        params = msg.get("params") or {}
        session_id = params["sessionId"]
        message_id = f"message-{turn}"
        print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "agent/inbox/spliced", "data": {"target": "next-turn", "start": 0, "inserted": [{"id": message_id}]}}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": session_id, "status": "running"}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": message_id}}), flush=True)
        if turn == 1:
            print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "first"}]}}}}), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": session_id, "status": "idle"}}), flush=True)
        else:
            time.sleep(0.05)
            print(json.dumps({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "assistant/message", "data": {"content": [{"type": "text", "text": "second"}]}}}}), flush=True)
            print(json.dumps({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": session_id, "status": "idle"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with DeepSeekHarness(launch_args_override=(sys.executable, str(script)), cwd=str(tmp_path)) as harness:
        first = harness.run("first turn", session_id="main")
        second = harness.run("second turn", session_id="main")

    assert first.final_response == "first"
    assert second.final_response == "second"
    assert [notification.payload.get("sessionId") for notification in second.notifications] == ["main"] * 4


def test_client_starts_subprocess_sends_requests_and_routes_notifications(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif method == "session/prompt":
        params = msg.get("params") or {}
        print(json.dumps({"jsonrpc": "2.0", "method": "llm/request", "params": {"requestId": "req-1", "sessionId": params["sessionId"], "model": "dsagent", "messages": []}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with HarnessClient(
        HarnessConfig(launch_args_override=(sys.executable, str(script)))
    ) as client:
        init = client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        assert init.serverInfo.name == "fake-dsh"

        client.session_prompt("main", [{"type": "text", "text": "fix it"}])
        notification = client.next_notification()
        assert notification.method == "llm/request"
        assert notification.payload["requestId"] == "req-1"
    assert notification.payload["sessionId"] == "main"


def test_client_keeps_unmatched_notifications_available_globally_while_subscribed() -> None:
    client = HarnessClient()
    with client.subscribe_session_notifications("main"):
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {"sessionId": "other", "event": {"type": "assistant/message"}},
        })

        assert client._notifications.qsize() == 1
        notification = client._notifications.get_nowait()
        assert not isinstance(notification, BaseException)
        assert notification.method == "session.event"
        assert notification.payload["sessionId"] == "other"


def test_session_subscription_keeps_descendant_relationships_across_subscriptions() -> None:
    client = HarnessClient()
    with client.subscribe_session_notifications("main") as first:
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.started",
            "params": {"parentSessionId": "main", "childSessionId": "child"},
        })
        assert first.next().payload["childSessionId"] == "child"

    with client.subscribe_session_notifications("main") as second:
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.started",
            "params": {"parentSessionId": "child", "childSessionId": "grandchild"},
        })
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {"sessionId": "grandchild", "event": {"type": "assistant/message"}},
        })
        assert second.next().payload["childSessionId"] == "grandchild"
        assert second.next().payload["sessionId"] == "grandchild"

    assert client._notifications.qsize() == 0


def test_subscription_bounded_wait_leaves_no_waiter_and_close_wakes_active_wait() -> None:
    client = HarnessClient()
    subscription = client.subscribe_notifications()

    assert subscription.next_with_timeout(0.001) is None
    client._handle_message({
        "jsonrpc": "2.0",
        "method": "probe",
        "params": {"afterTimeout": True},
    })
    assert subscription.next().payload == {"afterTimeout": True}

    entered = threading.Event()
    failures: list[BaseException] = []

    def wait_boundedly() -> None:
        entered.set()
        try:
            subscription.next_with_timeout(10.0)
        except BaseException as exc:
            failures.append(exc)

    waiter = threading.Thread(target=wait_boundedly)
    waiter.start()
    assert entered.wait(timeout=1.0)
    subscription.close()
    waiter.join(timeout=1.0)

    assert not waiter.is_alive()
    assert len(failures) == 1
    assert isinstance(failures[0], TransportClosedError)


def test_session_subscription_preserves_reused_child_ancestry_after_late_finish() -> None:
    client = HarnessClient()
    old_seen: list[Notification] = []
    new_seen: list[Notification] = []
    with (
        client.subscribe_session_notifications("old-parent") as old_subscription,
        client.subscribe_session_notifications("new-parent") as new_subscription,
    ):
        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.started",
            "params": {"parentSessionId": "old-parent", "childSessionId": "reused-child"},
        })
        old_subscription.drain(old_seen.append)
        new_subscription.drain(new_seen.append)
        assert [notification.method for notification in old_seen] == ["subagent.started"]
        assert new_seen == []

        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.started",
            "params": {"parentSessionId": "new-parent", "childSessionId": "reused-child"},
        })
        old_subscription.drain(old_seen.append)
        new_subscription.drain(new_seen.append)
        assert [notification.method for notification in new_seen] == ["subagent.started"]

        client._handle_message({
            "jsonrpc": "2.0",
            "method": "subagent.finished",
            "params": {"parentSessionId": "old-parent", "childSessionId": "reused-child"},
        })
        old_subscription.drain(old_seen.append)
        new_subscription.drain(new_seen.append)
        assert [notification.method for notification in old_seen] == [
            "subagent.started",
            "subagent.finished",
        ]
        assert [notification.method for notification in new_seen] == ["subagent.started"]

        client._handle_message({
            "jsonrpc": "2.0",
            "method": "session.event",
            "params": {"sessionId": "reused-child", "event": {"type": "assistant/message"}},
        })
        old_subscription.drain(old_seen.append)
        new_subscription.drain(new_seen.append)

    assert [notification.method for notification in old_seen] == [
        "subagent.started",
        "subagent.finished",
    ]
    assert [notification.method for notification in new_seen] == [
        "subagent.started",
        "session.event",
    ]
    assert client._notifications.qsize() == 0


def test_client_contains_notification_filter_failure_to_its_subscription(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif method in {"emit-first", "emit-second"}:
        print(json.dumps({"jsonrpc": "2.0", "method": "tick", "params": {"source": method}}), flush=True)
    elif method == "session/prompt":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"messageId": "message-1"}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    def broken_filter(_notification: object) -> bool:
        raise RuntimeError("bad notification filter")

    with HarnessClient(HarnessConfig(launch_args_override=(sys.executable, str(script)))) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        with (
            client.subscribe_notifications(broken_filter) as broken,
            client.subscribe_notifications(lambda notification: notification.method == "tick") as healthy,
        ):
            client.notify("emit-first")
            with pytest.raises(RuntimeError, match="bad notification filter"):
                broken.next()
            assert healthy.next().payload == {"source": "emit-first"}
            assert client._notifications.qsize() == 0

            client.session_prompt("main", [{"type": "text", "text": "reader still works"}])
            client.notify("emit-second")
            assert healthy.next().payload == {"source": "emit-second"}


def test_client_rejects_unaccepted_session_prompt_response(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif method == "session/prompt":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"accepted": False}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with HarnessClient(HarnessConfig(launch_args_override=(sys.executable, str(script)))) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        with pytest.raises(ValueError):
            client.session_prompt("main", [{"type": "text", "text": "fix it"}])


def test_client_routes_bridge_requests_and_sends_responses(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": "bridge-req-1", "method": "llm.request", "params": {"requestId": "req-1", "sessionId": "main", "model": "dsagent", "messages": []}}), flush=True)
    elif "id" in msg and "method" not in msg:
        print(json.dumps({"jsonrpc": "2.0", "method": "response/seen", "params": {"result": msg.get("result")}}), flush=True)
    elif method == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with HarnessClient(
        HarnessConfig(launch_args_override=(sys.executable, str(script)))
    ) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")

        request = client.next_request()
        assert request.id == "bridge-req-1"
        assert request.method == "llm.request"
        assert request.payload["requestId"] == "req-1"

        client.respond(request.id, {"content_blocks": [{"type": "text", "text": "done"}]})
        notification = client.next_notification()
        assert notification.method == "response/seen"
        assert notification.payload["result"]["content_blocks"][0]["text"] == "done"


def test_client_ignores_non_json_stdout_lines(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

print("node warning: experimental loader", flush=True)
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    with HarnessClient(
        HarnessConfig(launch_args_override=(sys.executable, str(script)))
    ) as client:
        init = client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        assert init.serverInfo.name == "fake-dsh"


def test_client_request_times_out_when_bridge_does_not_respond(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import sys
import time

print("bridge is still starting", file=sys.stderr, flush=True)
time.sleep(60)
""".strip()
    )

    with HarnessClient(
        HarnessConfig(
            launch_args_override=(sys.executable, str(script)),
            request_timeout_seconds=0.5,
        )
    ) as client:
        start = time.monotonic()
        try:
            client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        except TimeoutError as exc:
            assert time.monotonic() - start < 2
            assert "bridge is still starting" in str(exc)
        else:
            raise AssertionError("initialize should time out")


def test_client_close_times_out_when_shutdown_does_not_respond(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import signal
import sys
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)

for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        time.sleep(60)
""".strip()
    )

    client = HarnessClient(
        HarnessConfig(
            launch_args_override=(sys.executable, str(script)),
            shutdown_timeout_seconds=0.1,
        )
    )
    client.start()
    proc = client._proc
    assert proc is not None
    client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
    start = time.monotonic()
    client.close()
    assert time.monotonic() - start < 2
    assert proc.poll() is not None
    assert client._proc is None


def test_initialize_failure_reaps_started_runtime(tmp_path: Path) -> None:
    script = tmp_path / "rejecting_runtime.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32000, "message": "bad initialize"}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    client = HarnessClient(HarnessConfig(launch_args_override=(sys.executable, str(script))))
    client.start()
    proc = client._proc
    assert proc is not None

    with pytest.raises(Exception, match="bad initialize"):
        client.initialize(provider="deepseek-official", cwd=".", model="dsagent")

    assert proc.wait(timeout=1) is not None
    assert client._proc is None


def test_public_signatures_omit_unsupported_wire_parameters() -> None:
    from deepseek_harness import DeepSeekHarnessConfig, Session

    assert "session_root" not in inspect.signature(HarnessClient.initialize).parameters
    assert "system_prompt" not in inspect.signature(HarnessClient.initialize).parameters
    assert "profile" not in inspect.signature(HarnessClient.session_prompt).parameters
    assert "profile" not in inspect.signature(DeepSeekHarness.run).parameters
    assert "profile" not in inspect.signature(Session.run).parameters
    assert "system_prompt" not in DeepSeekHarnessConfig.__dataclass_fields__
    assert "max_tokens" in DeepSeekHarnessConfig.__dataclass_fields__
    assert "max_tokens" in inspect.signature(HarnessClient.initialize).parameters
    assert "client_name" not in HarnessConfig.__dataclass_fields__
    assert "client_version" not in HarnessConfig.__dataclass_fields__


def test_client_close_is_idempotent_before_and_after_start(tmp_path: Path) -> None:
    HarnessClient().close()

    script = tmp_path / "fake_bridge.py"
    script.write_text(
        """
import json
import sys

for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )

    client = HarnessClient(HarnessConfig(launch_args_override=(sys.executable, str(script))))
    client.start()
    client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
    client.close()
    client.close()


def test_runtime_closed_error_includes_stderr_tail(tmp_path: Path) -> None:
    script = tmp_path / "crashing_runtime.py"
    script.write_text(
        """
import sys

print("fatal bridge exploded", file=sys.stderr, flush=True)
sys.exit(42)
""".strip()
    )

    with HarnessClient(
        HarnessConfig(
            launch_args_override=(sys.executable, str(script)),
            request_timeout_seconds=2,
        )
    ) as client:
        with pytest.raises(Exception, match="fatal bridge exploded"):
            client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")


def test_client_serializes_concurrent_writes(tmp_path: Path) -> None:
    script = tmp_path / "fake_bridge.py"
    output = tmp_path / "seen.jsonl"
    script.write_text(
        """
import json
import os
import sys

with open(os.environ["SEEN"], "w") as seen:
    for line in sys.stdin:
        seen.write(line)
        seen.flush()
        msg = json.loads(line)
        if "id" in msg and msg.get("method") == "initialize":
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "fake-dsh"}}}), flush=True)
        elif "id" in msg and msg.get("method") == "shutdown":
            print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
            break
""".strip()
    )

    with HarnessClient(
        HarnessConfig(
            launch_args_override=(sys.executable, str(script)),
            env={"SEEN": str(output)},
        )
    ) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="dsagent")
        threads = [
            threading.Thread(target=client.notify, args=(f"notice-{index}", {"index": index}))
            for index in range(50)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    for line in output.read_text().splitlines():
        json.loads(line)


def _install_fake_bundled_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    """Install a fake runtime package that records config and serves lifecycle calls.

    Returns the fake bundled default config path.
    """
    runtime = tmp_path / "dsh-jsonrpc-agent"
    runtime.write_text(
        """#!/usr/bin/env python3
import json
import os
import sys

json.dump({"DSH_CORDIS_CONFIG": os.environ.get("DSH_CORDIS_CONFIG")}, open(os.environ["ENV_DUMP"], "w"))
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {"serverInfo": {"name": "bundled-runtime"}}}), flush=True)
    elif msg.get("method") == "shutdown":
        print(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {}}), flush=True)
        break
""".strip()
    )
    runtime.chmod(0o755)

    default_config = tmp_path / "default-cordis.yml"
    module_dir = tmp_path / "deepseek_harness_runtime"
    module_dir.mkdir()
    (module_dir / "__init__.py").write_text(
        f"""
import sys


def resolve_bundled_launch_args(mode=None):
    return (sys.executable, {str(runtime)!r})


def bundled_default_config_path():
    return {str(default_config)!r}
""".strip()
    )

    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.delitem(sys.modules, "deepseek_harness_runtime", raising=False)
    return default_config


@pytest.mark.parametrize("ambient_config", [None, ""], ids=["unset", "empty-counts-as-absent"])
def test_client_default_launch_uses_bundled_runtime_and_injects_default_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, ambient_config: str | None
) -> None:
    env_dump = tmp_path / "env.json"
    default_config = _install_fake_bundled_runtime(tmp_path, monkeypatch)
    if ambient_config is None:
        monkeypatch.delenv("DSH_CORDIS_CONFIG", raising=False)
    else:
        monkeypatch.setenv("DSH_CORDIS_CONFIG", ambient_config)

    with HarnessClient(HarnessConfig(env={"ENV_DUMP": str(env_dump)})) as client:
        init = client.initialize(provider="deepseek-official", cwd="/workspace", model="deepseek-v4-pro")

    assert init.serverInfo.name == "bundled-runtime"
    assert json.loads(env_dump.read_text())["DSH_CORDIS_CONFIG"] == str(default_config)


def test_client_respects_explicit_config_over_bundled_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_dump = tmp_path / "env.json"
    _install_fake_bundled_runtime(tmp_path, monkeypatch)
    monkeypatch.delenv("DSH_CORDIS_CONFIG", raising=False)

    with HarnessClient(
        HarnessConfig(env={"ENV_DUMP": str(env_dump), "DSH_CORDIS_CONFIG": "./explicit.yml"})
    ) as client:
        client.initialize(provider="deepseek-official", cwd="/workspace", model="deepseek-v4-pro")

    assert json.loads(env_dump.read_text())["DSH_CORDIS_CONFIG"] == "./explicit.yml"


def test_client_reports_missing_bundled_runtime_dependency(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delitem(sys.modules, "deepseek_harness_runtime", raising=False)
    monkeypatch.setattr(sys, "path", [])

    with pytest.raises(FileNotFoundError, match="Install deepseek-harness-runtime-bin"):
        HarnessClient().start()
