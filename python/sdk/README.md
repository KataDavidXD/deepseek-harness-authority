# DeepSeek Harness Python SDK

English | [中文](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk/README.zh.md)

Python subprocess SDK for driving DeepSeek Harness over JSON-RPC stdio. The
runtime inherits normal DeepSeek Harness environment variables such as
`DEEPSEEK_BASE_URL` and `DEEPSEEK_API_KEY`, so callers can use real model
endpoints directly or point those variables at a local proxy.

Install the `deepseek-harness-sdk` distribution from PyPI; the import module remains `deepseek_harness`:

```sh
python -m pip install deepseek-harness-sdk
```

Installing `deepseek-harness-sdk` installs the exact same-version `deepseek-harness-runtime-bin` platform wheel. The normal entry point therefore needs no executable argument:

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness() as harness:
    result = harness.run("Say hi.")
```

`DeepSeekHarness` keeps its lazily started runtime subprocess for reuse across calls. If that subprocess dies after initialization, the next operation atomically starts and initializes a replacement on the same SDK object. `get_runtime_binding()` performs that handshake without sending a prompt and returns the immutable, path-free schema-2 envelope; its `root_config_sha256` field aliases wire `rootConfigSha256` and hashes the exact root Cordis file bytes mounted from the runtime's one read. Pinned runtimes reject nested Include identities at Loader's actual pre-apply boundary, freeze the root Include config, and seal its child tree after initial mount. The digest capability is confined to that authoritative subtree, so removing or replacing it cannot give a sibling server the stale binding. The first envelope is pinned across process replacements, and a different store or root digest raises `RuntimeBindingMismatchError`. This digest is not a semantic plugin-graph fingerprint and does not prove startup patch arguments, environment-derived expression values, plugin modules, or plugin external state; an operator that needs a broader fence maintains its own authoritative manifest. Use the harness as a context manager, as above, or call `close()` explicitly when finished.

An operator that validates deployment configuration before first dispatch can call `get_runtime_process_binding()` to capture the store binding and an opaque live-subprocess generation atomically. Passing that generation as `expected_process_generation` to `run()` requires the exact already-running child and pins the whole `Session.run()` to its client; the SDK raises `RuntimeGenerationMismatchError` before `session/attempt.start` if the child died or changed, and never restarts on this fenced path. Unfenced lookup and reconciliation calls retain automatic child restart.

By default, the SDK launches the bundled single-file `dsh-jsonrpc-agent` executable from the `deepseek-harness-runtime-bin` package and injects that package's default configuration (the stdio JSON-RPC server, agent core, preloaded DeepSeek adapter, JSONL session persistence with an explicitly composed semantic checkpoint policy, local bash) via `DSH_CORDIS_CONFIG`. To run a plugin composition of your own, keep the `@deepseek-ai/dsh-sdk-jsonrpc-server` entry in the config and pass the Cordis config path.

```py
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    cordis="examples/jsonrpc-agent/cordis.yml",
) as harness:
    result = harness.run("Make the requested code change.")
```

`provider` selects a provider route registered by the chosen Cordis composition; `model` is the model id resolved by that adapter. `max_tokens` is an optional positive per-request output-token cap for the root agent and its in-process descendants; omission leaves the provider default in control. Compaction summaries keep the separate limit configured by their compaction plugin. The bundled default composition registers `deepseek-official`. A custom composition can mount `llm-pi-ai`, configure provider-specific credentials/endpoints there, and select any provider/model present in pi-ai's installed catalog.

The [Python SDK tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.md) provides an ordered installation and first-run path without the Web UI. The [`jsonrpc-agent` example](https://github.com/deepseek-ai/deepseek-harness/blob/master/examples/jsonrpc-agent/README.md) owns the complete standalone Cordis file used there.

`Session.run()` without an attempt identity retains the compatibility activity interval from its prompt's inbox receipt through the next whole-agent idle. `RunResult` now also carries `message_id` and `deduplicated=False`; `final_response` remains the last committed root-session assistant text in the interval. `finish_reason` is the `kind` of the last root-session `turn/end`, such as `completed`, `max-tokens`, or `error`, and is `None` when no turn ended. Both fields describe the interval rather than an output or ending causally assigned to the prompt.

For restart-safe operator use, supply `attempt_id` and `input_sha256` together:

```py
with DeepSeekHarness() as harness:
    result = harness.run(
        "Apply the requested change.",
        session_id="deployment-owned-session",
        attempt_id="wtb-attempt-17",
        input_sha256="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    )
```

The durable path subscribes before `session/attempt.start`. An already-terminal deduplicated attempt returns immediately without waiting for notifications. For queued/running attempts, exact `session/attempt.get` state is polled every `attempt_poll_interval_seconds` (default 1 second); a root idle notification triggers an immediate extra poll but is never required for progress or treated as outcome proof. Only the exact terminal receipt supplies `final_response`, `finish_reason`, `terminal_event_seq`, and `turn`. `attempt_timeout_seconds` is one overall deadline from start dispatch through polling (default 300 seconds). Expiry raises `AttemptTimeoutError` and never cancels the runtime-owned attempt; callers can subsequently use `get_attempt()` or explicitly `cancel_attempt()`. Missing fields, unknown statuses, or mismatched session/attempt/input identities raise `SdkProtocolError`. `get_attempt()` and `cancel_attempt()` are public on `DeepSeekHarness`, `Session`, and the low-level `HarnessClient`. Older or non-persistent runtimes reject the new methods before dispatch; the SDK never silently falls back to `session_prompt()`.

`HarnessClient` retains discovered subagent ancestry for the lifetime of the runtime process. During each `Session.run()`, `RunResult.notifications` and `on_notification` receive the root session and all known descendant notifications in wire order, including nested subagent lifecycle and session events. `RunResult.events` contains root-session events only, so descendant messages cannot replace the root response. The low-level `session_prompt()` remains the legacy enqueue primitive; `start_attempt()`, `get_attempt()`, and `cancel_attempt()` validate durable receipts and their echoed ownership fields. `NotificationSubscription.next_with_timeout()` provides a bounded wait without leaving a background waiter; closing a subscription wakes an active wait with `TransportClosedError`.

The same behavior can be selected for the runtime subprocess with `DSH_CORDIS_CONFIG`. The injection lives in `HarnessClient.start()`, so the low-level client's default launch gets it too: when the launch resolves to the bundled runtime and neither `cordis` nor a non-empty `DSH_CORDIS_CONFIG` is set (the runtime treats an empty value as absent, and so does the injection check), the bundled default configuration is used; an explicit `runtime_bin`, `bridge_bin`, or `launch_args_override` disables the injection entirely. See the [sdk-runtime README](https://github.com/deepseek-ai/deepseek-harness/blob/master/python/sdk-runtime/README.md) for the runtime carriers (production exe vs dev-only node closure) and how to obtain them.

`cwd` and `runtime_cwd` are resolved to absolute paths before subprocess launch, environment injection, and the wire handshake. The public API exposes only applied options: deployment persona and persistence belong in `cordis.yml`, while `session_root` remains the high-level convenience that sets `DSH_SESSION_ROOT`.
