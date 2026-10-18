# @deepseek-ai/dsh-sdk-jsonrpc-server

English | [中文](README.zh.md)

The `jsonrpc` plugin serves newline-delimited JSON-RPC over stdio so out-of-process SDK clients can drive harness agents. [`HarnessSdkJsonRpcServer`](src/server.ts) owns the protocol methods and notifications; the transport and the named wire types live in [`dsh-sdk-protocol`](../protocol/README.md), shared with the client SDKs; [`jsonrpc-demo`](../../examples/jsonrpc-demo/README.md) supplies the surrounding `cordis.yml` application.

## Wiring

`inject: ['agents']`. The server gets or creates one agent per `sessionId`. Legacy `session/prompt` works without persistence. Durable attempt lookup requires `sessionPersistence`; start and cancellation additionally require backend ownership support and fail before dispatch when it is absent. It forwards subagent completions only when the service-snapshotted lifecycle `local` flag is true; provider names, child ids, and durable lineage never establish locality. A registered adapter wins, an unowned `deepseek-official` route mounts `dsh-llm-deepseek`, and any other unowned provider fails initialization. Other capabilities come from the surrounding `cordis.yml`.

## Config

`maxTokensAsSuccess` defaults to `false` and affects only the deployment-mapped status on `subagent.finished`; root-session prompts have no prompt-level status. `JsonRpcConfig.input`, `output`, and `exit` are runtime-only transport hooks; production uses process stdio and `process.exit`.

## stdout is the protocol

Stdout carries only JSON-RPC frames. The deployment must not compose a stdout logger; diagnostics belong on stderr.

## Shutdown and exit semantics

The plugin answers `shutdown`, flushes the response, disposes the root context so SDK-owned agents, subscriptions, and persistence reach quiescence, then exits with code 0. EOF and signal exits belong to the app bin, which also disposes the root context. Unloading only this plugin stops serving without exiting the process.

## Wire notes

`initialize.serverInfo.name` is the wire-stable `deepseek-harness-sdk-runtime`. An optional positive `initialize.maxTokens` becomes the request output cap of each SDK-created agent and its in-process descendants; invalid values reject initialization, while omission sends no SDK cap and allows the selected adapter or provider route default to apply. `session/prompt` queues one identified user message and immediately returns `{ messageId }`. For transactional operators, `session/attempt.start` installs a process-local delivery gate before recording the attempt identity with that same inbox message, flushes the queued receipt, then releases and wakes it; neither an idle nor a currently running driver can claim that FIFO ahead of the barrier. A failed flush leaves the exact live item parked so an identical retry can flush, release, and wake it without another insertion. `session/attempt.get` folds either the live log or the physical persisted prefix from `sessionPersistence.readFrom`; `start` resumes a cold queued or running receipt so load commits crash repair before returning a repaired terminal receipt. `session/attempt.cancel` removes only the exact queued message, including its gate, or cancels its active turn with the remaining inbox preserved and wakes that work after the terminal receipt is flushed. Every live receipt is captured before its flush, so a response may be stale but never advertises a later, unpersisted event. Per-session operations are serialized, a resumed durable inbox is woken without reinsertion, and shutdown waits admitted operations. The server streams every durable fact as `session.event` and every whole-agent lifecycle transition as `session.status`. Persistence roots and persona come from `cordis.yml`.

When the configured persistence backend declares ownership support, the server acquires exclusive session ownership before creating, resuming, or waking a persisted SDK session. Legacy prompts retain compatibility with backends that do not support ownership; read-only attempt lookup may inspect their physical log, while start and cancellation reject them. The server retains ownership through agent quiescence, a final flush, and disposal, then releases it. After the loop claims an SDK-attempt message but before model dispatch, `agent/pre-step` asserts ownership and flushes the claimed turn intent; failure or a missing persistence participant prevents the adapter request.

Initialization combines the configured backend's validated canonical lowercase UUIDv4 with app boot's `rootConfigSha256` and returns the schema-2 `runtimeBinding`; every durable attempt receipt carries the same immutable envelope. App boot hashes the exact root Cordis file bytes it mounts from one read, rather than reopening the path for Loader. Its authoritative subtree rejects nested Include identities at the actual Loader pre-apply boundary, freezes the root Include config, and seals child mutation after initial mount. The digest reaches this server through a non-enumerable inherited capability scoped to that subtree; a replacement sibling receives no stale digest and therefore emits no binding. Durable start/get/cancel require both values in addition to their existing persistence/ownership requirements, so a third-party backend or a host that bypasses pinned app boot cannot emit incomplete proof. Legacy prompt initialization remains compatible and omits the optional binding when either capability is absent. The root digest is not a semantic plugin-graph fingerprint and does not cover startup patch arguments, environment-derived expression values, plugin modules, or plugin external state; operators retain authority for any broader deployment manifest.

## Model Experience

### SDK user message

#### What the model sees

For each accepted `session/prompt` or newly admitted `session/attempt.start`, the conversation model receives the caller-supplied `contentBlocks` verbatim as one user message in that SDK session. Attempt identity remains durable source metadata and adds no model-visible prose. This package adds no system-prompt prose or tool schema; those come from the plugins in the surrounding `cordis.yml`.

#### Token effect

Data-dependent user-message tokens enter retained session history and are resent on later turns until another package compacts them. The JSON-RPC frames, session notifications, and server bookkeeping add zero model-context tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **The wire has no per-session close or legacy-prompt cancel method** — identity-fenced cancellation exists only for `session/attempt.*`; SDK-created agents remain live until process shutdown.
- **Legacy prompts still have no per-prompt result** — `session/prompt` keeps its compatibility semantics; transactional clients use attempt receipts instead.
- **stdout purity is deployment-enforced** — a surrounding config can still load a stdout logger and corrupt the JSON-RPC channel; this plugin does not inspect or veto sibling loggers.
- **Automatic adapter mounting is DeepSeek-specific** — `initialize` can reuse any pre-registered model adapter, but its only fallback mounts `dsh-llm-deepseek`.
