/**
 * Named wire types for the DeepSeek Harness SDK runtime protocol: the six
 * request/result pairs and the four server-to-client notification payloads
 * exchanged over the newline-delimited JSON-RPC stdio transport. The server
 * plugin (`@deepseek-ai/dsh-sdk-jsonrpc-server`) and SDK clients share these shapes;
 * `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'

/** Runtime-binding wire protocol understood by this SDK generation. */
export const RUNTIME_BINDING_PROTOCOL_VERSION = 1

/** Shape version of {@link RuntimeBindingEnvelope}. */
export const RUNTIME_BINDING_SCHEMA_VERSION = 2

/**
 * Path-free proof that initialize and durable receipts address one logical
 * persistence store under a compatible wire/schema contract.
 */
export interface RuntimeBindingEnvelope {
  /** Runtime-binding protocol generation. */
  readonly protocolVersion: typeof RUNTIME_BINDING_PROTOCOL_VERSION
  /** Envelope schema generation. */
  readonly schemaVersion: typeof RUNTIME_BINDING_SCHEMA_VERSION
  /** Restart-stable UUID owned by the persistence store, never its path. */
  readonly persistenceInstanceId: string
  /** SHA-256 of the exact root Cordis bytes mounted by this runtime process. */
  readonly rootConfigSha256: string
}

/** Parameters for the process-wide SDK handshake. */
export interface InitializeParams {
  /** Working directory recorded on every SDK-created session's header. */
  cwd: string
  /** Provider route every SDK-created agent runs on. */
  provider: string
  /** Model name every SDK-created agent runs on (the server may mount a fallback adapter; see `HarnessSdkJsonRpcServer.initialize`). */
  model: string
  /** Optional positive output-token cap inherited by SDK-created agents and their in-process descendants. */
  maxTokens?: number
}

/** Wire-stable server identity returned by initialization. */
export interface InitializeResult {
  /** Wire-stable server identity (`deepseek-harness-sdk-runtime`) and version. */
  serverInfo: { name: string; version: string }
  /** Present when the configured persistence backend supports durable identity. */
  runtimeBinding?: RuntimeBindingEnvelope
}

/** One user turn on one SDK session. */
export interface SessionPromptParams {
  /** The SDK-side session id; an unknown id lazily creates the agent+session pair. */
  sessionId: string
  /** The prompt content blocks, sent verbatim as the user message. */
  contentBlocks: ContentBlock[]
}

/** Durable enqueue receipt for one prompt. */
export interface SessionPromptResult {
  /** Identity of the queued user message. */
  messageId: string
}

/** Maximum wire length of one durable SDK attempt id. */
export const SESSION_ATTEMPT_ID_MAX_LENGTH = 128

/** Caller-supplied identity used to fence one durable SDK attempt. */
export interface SessionAttemptLookupParams {
  /** Session that owns the attempt. */
  sessionId: string
  /** Safe opaque id, unique within the session and bounded by {@link SESSION_ATTEMPT_ID_MAX_LENGTH}. */
  attemptId: string
  /** Lowercase hexadecimal SHA-256 of the caller's complete execution input. */
  inputSha256: string
}

/** Parameters that durably admit one idempotent SDK attempt. */
export interface SessionAttemptStartParams extends SessionAttemptLookupParams {
  /** Exact prompt content persisted with the attempt and compared on every retry. */
  contentBlocks: ContentBlock[]
}

/** Stable identity returned on every durable attempt receipt. */
export interface SessionAttemptIdentity extends SessionAttemptLookupParams {
  /** Deterministic user-message id derived from the session and attempt ids. */
  messageId: string
  /** Store identity that owns this durable receipt. */
  runtimeBinding: RuntimeBindingEnvelope
}

/** A durable attempt that remains in the agent's pending inbox. */
export interface SessionAttemptQueuedReceipt extends SessionAttemptIdentity {
  status: 'queued'
}

/** A durable attempt claimed by a live or crash-interrupted turn. */
export interface SessionAttemptRunningReceipt extends SessionAttemptIdentity {
  status: 'running'
  /** Turn that claimed the attempt, when the durable log has opened it. */
  turn?: number
}

/** Terminal reason for a claimed turn or an exact queued cancellation. */
export type SessionAttemptFinishReason = TurnEndReason | { kind: 'canceled' }

/** A durable attempt whose exact queued item or owning turn has settled. */
export interface SessionAttemptTerminalReceipt extends SessionAttemptIdentity {
  status: 'terminal'
  /** Turn that claimed the attempt; absent only for cancellation while queued. */
  turn?: number
  /** Exact turn ending, or `canceled` when the queued message was removed before claim. */
  finishReason: SessionAttemptFinishReason
  /** Session-event sequence that established the terminal outcome. */
  terminalEventSeq: number
  /** Text blocks from the attempt turn's last assistant message, joined in order. */
  finalResponse: string
}

/** Current durable state of one exact SDK attempt. */
export type SessionAttemptReceipt =
  | SessionAttemptQueuedReceipt
  | SessionAttemptRunningReceipt
  | SessionAttemptTerminalReceipt

/** Result of idempotently admitting one durable attempt. */
export interface SessionAttemptStartResult {
  /** Current durable receipt after the admission flush barrier. */
  attempt: SessionAttemptReceipt
  /** Whether the same identity and content were already durably admitted. */
  deduplicated: boolean
}

/** Result of looking up one exact durable attempt. */
export interface SessionAttemptGetResult {
  /** Current receipt, or `null` when the session or attempt does not exist. */
  attempt: SessionAttemptReceipt | null
}

/** Result of settling one exact durable attempt by cancellation. */
export interface SessionAttemptCancelResult {
  /** Terminal receipt after cancellation and the persistence flush barrier. */
  attempt: SessionAttemptTerminalReceipt
}

/** Deployment-mapped SDK outcome: `ok` for an accepted result, `error` otherwise. */
export type SdkRunStatus = 'ok' | 'error'

/** `session.event` payload: one session-log event, streamed as it is recorded. */
export interface SessionEventNotification {
  /** Session the event belongs to (every session in the runtime, not only SDK-created ones). */
  sessionId: string
  /** The full session-log event envelope. */
  event: SessionEvent
}

/** Whole-agent lifecycle state for one session. */
export interface SessionStatusNotification {
  /** Session whose live agent changed status. */
  sessionId: string
  /** The whole-agent state after the transition. */
  status: 'idle' | 'running'
}

/** `subagent.started` payload: an in-runtime child session was created. */
export interface SubagentStartedNotification {
  /** The delegating session. */
  parentSessionId: string
  /** The new child session. */
  childSessionId: string
}

/** `subagent.finished` payload: an in-process subagent run ended (remote runs are not reported). */
export interface SubagentFinishedNotification {
  /** Subagent provider name that ran the child. */
  provider: string
  /** The child agent's id (equals {@link childSessionId} for local runs). */
  agentId: string
  /** The delegating session. */
  parentSessionId: string
  /** The child session. */
  childSessionId: string
  /** Deployment-mapped run outcome. */
  status: SdkRunStatus
  /** The provider-reported stop reason. */
  stopReason: SubagentStopReason
  /** The child's selected assistant output; absent when the child produced none. */
  lastAssistantMessage?: ContentBlock[]
}

/** Server-to-client notifications by JSON-RPC method name. */
export interface HarnessSdkNotificationMap {
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
}

/** Client-to-server request methods with their param and result shapes. */
export interface HarnessSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'session/attempt.start': { params: SessionAttemptStartParams; result: SessionAttemptStartResult }
  'session/attempt.get': { params: SessionAttemptLookupParams; result: SessionAttemptGetResult }
  'session/attempt.cancel': { params: SessionAttemptLookupParams; result: SessionAttemptCancelResult }
  'shutdown': { params: undefined; result: Record<string, never> }
}
