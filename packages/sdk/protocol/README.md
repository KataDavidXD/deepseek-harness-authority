# @deepseek-ai/dsh-sdk-protocol

English | [中文](README.zh.md)

The shared wire protocol for the DeepSeek Harness SDK runtime: one newline-delimited JSON-RPC 2.0 transport class plus the named request, result, and notification types both wire ends speak. The package root enumerates the protocol consumer interface; source modules are not exported as deep imports. The server side is the [`dsh-sdk-jsonrpc-server`](../server/README.md) plugin; clients are [`dsh-sdk-client`](../client/README.md) (TypeScript) and the [Python SDK](../../../python/README.md) (which mirrors these shapes but does not import them). A pure library — no plugin, no Config, no registration.

## Transport

`JsonRpcLineTransport` frames JSON-RPC 2.0 over caller-owned byte streams, one compact JSON frame per `\n`-terminated line. Frames with `id` and `method` are requests, `id` alone is a response, `method` alone is a notification; malformed JSON lines are ignored. `start()` attaches stream listeners, `close()` detaches them and rejects pending requests without destroying the streams. Missing request handlers answer `-32601`; handler rejections answer `-32603` with the error message. An error response rejects the pending `request()` with `JsonRpcResponseError`, which preserves the wire `code` and optional `data`. `JsonRpcTransportPeer` is the outbound surface (request/notify) the server class is typed against.

## Wire types

`types.ts` names every payload of the protocol served by `HarnessSdkJsonRpcServer`:

| Direction | Method | Types |
|---|---|---|
| client→server | `initialize` | `InitializeParams` → `InitializeResult` |
| client→server | `session/prompt` | `SessionPromptParams` → `SessionPromptResult` (durable enqueue receipt) |
| client→server | `session/attempt.start` | `SessionAttemptStartParams` → `SessionAttemptStartResult` (durable idempotent admission) |
| client→server | `session/attempt.get` | `SessionAttemptLookupParams` → `SessionAttemptGetResult` |
| client→server | `session/attempt.cancel` | `SessionAttemptLookupParams` → `SessionAttemptCancelResult` |
| client→server | `shutdown` | no params → `{}` |
| server→client | `session.event` | `SessionEventNotification` (every session in the runtime, unfiltered) |
| server→client | `session.status` | `SessionStatusNotification` (whole-agent `running`/`idle` transition) |
| server→client | `subagent.started` | `SubagentStartedNotification` |
| server→client | `subagent.finished` | `SubagentFinishedNotification` (in-process runs only) |

`HarnessSdkRequestMap` and `HarnessSdkNotificationMap` index these by method name. `SessionPromptResult.messageId` identifies the queued `UserMessage`; it does not identify a later assistant message, turn ending, or prompt result. Durable automation uses `session/attempt.start|get|cancel`: `attemptId` is a 1-128 character safe opaque id, `inputSha256` is the caller's lowercase execution-input fence, and the server deterministically derives `messageId` from `sessionId + attemptId`. A retry must repeat both the hash and exact `contentBlocks`; either conflict fails closed. `SessionAttemptReceipt` is `queued | running | terminal`; claimed receipts carry `turn`, and a terminal receipt also carries the exact `finishReason`, establishing event seq, and text from that turn's last assistant message. Clients combine the open-ended `session.event` stream with agent-wide `session.status` only for the legacy prompt surface. `SubagentFinishedNotification.lastAssistantMessage` contains the child's last non-empty assistant message or, when no such message exists, its accumulated assistant text; the field is absent when the child produced neither. `InitializeParams.maxTokens` is an optional positive safe integer that caps each conversation-model output for SDK-created agents and their in-process descendants; omission allows the selected adapter's exact-model default to apply, or otherwise preserves provider behavior. The notification payload types depend on `SessionEvent` (`dsh-session`), `ContentBlock` (`dsh-llm`), and `SubagentStopReason` (`dsh-subagent`) — the protocol streams full session-log envelopes, so the session vocabulary is part of the wire contract. `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`.

When persistence exposes durable instance identity and the SDK server runs inside app boot's authoritative root subtree, `initialize.runtimeBinding` contains the exact immutable `{ protocolVersion: 1, schemaVersion: 2, persistenceInstanceId, rootConfigSha256 }` envelope, and every durable attempt receipt repeats it. The UUID identifies the logical persistence store across process restart without exposing a path. `rootConfigSha256` hashes the exact root Cordis file bytes that the process captured once and mounted without a second path read. Pinned app boot preflights the initial enabled graph, rejects statically named Includes even when disabled, checks actual Include identity before every Loader apply, freezes the root Include config, and seals its child tree after initial mount. The digest capability exists only inside that subtree; removing or replacing it does not let a sibling SDK server reuse the old binding. Clients pin the first envelope and fail closed if a replacement process or receipt names another store or root digest. The digest is not a semantic plugin-graph fingerprint and does not prove startup patch arguments, environment-derived expression values, plugin module bytes, or plugin external state; an operator that needs those inputs fenced must maintain a separate authoritative manifest or digest.

## Model Experience

None, as this package defines the client-facing wire protocol; the model-visible surfaces belong to the runtime plugins composed behind the serving [`dsh-sdk-jsonrpc-server`](../server/README.md) entry.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No protocol-version negotiation** — the handshake carries only `serverInfo.version` (`0.0.1`, unvalidated by clients); pre-release stance, no compatibility promise.
- **No session-close or legacy-prompt cancel method** — `session/attempt.cancel` is identity-fenced, but `session/prompt` remains an unfenced compatibility surface and SDK-created agents live until runtime shutdown.
- **Server→client requests are dead capability** — the transport supports them, but the server never sends one; the Python SDK's responder surface exists for future approval flows.
