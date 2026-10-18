/**
 * Types for the TypeScript SDK client: launch options, notification shapes,
 * and owned activity results.
 *
 * @module @deepseek-ai/dsh-sdk-client/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  SessionAttemptFinishReason,
  SessionAttemptQueuedReceipt,
  SessionAttemptRunningReceipt,
  RuntimeBindingEnvelope,
} from '@deepseek-ai/dsh-sdk-protocol'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One server-to-client notification as received off the wire. */
export interface HarnessNotification {
  /** The JSON-RPC notification method name. */
  method: string
  /** The raw params object; see `HarnessSdkNotificationMap` for the shapes per method. */
  params: Record<string, unknown>
}

/** Predicate deciding whether a subscription receives a notification. */
export type NotificationFilter = (notification: HarnessNotification) => boolean

/** Launch and timeout options for {@link HarnessClient}. */
export interface HarnessClientOptions {
  /** The runtime executable (the `dsh-jsonrpc-agent` bin, a packaged exe, or `node`). */
  command: string
  /** Arguments passed to {@link command}. */
  args?: string[]
  /** Working directory for the runtime process itself. */
  cwd?: string
  /**
   * The complete child environment. `undefined` inherits the parent env
   * verbatim; passing an object replaces it entirely, so callers own
   * credential policy (see `scrubbedParentEnv` in `@deepseek-ai/dsh-subprocess`
   * for the shared scrub-then-merge base).
   */
  env?: NodeJS.ProcessEnv
  /** Per-request timeout (ms); `undefined` waits indefinitely (a turn can legitimately run long). */
  requestTimeoutMs?: number
  /** Bound (ms) on the protocol `shutdown` exchange inside `close()` (default 1000). */
  shutdownTimeoutMs?: number
  /** Grace (ms) for the runtime's stdin-EOF quiesce during `close()` (default 6000). */
  disposeEofGraceMs?: number
  /** Termination confirmation window (ms) after SIGTERM/SIGKILL during `close()` (default 3000). */
  disposeGraceMs?: number
}

/** Options for the high-level {@link DeepSeekHarness} wrapper. */
export interface DeepSeekHarnessOptions {
  /** Launch spec for the runtime subprocess (command, args, cwd, env, timeouts). */
  launch: HarnessClientOptions
  /** Workspace cwd recorded on every SDK-created session (default: the launch cwd, else `process.cwd()`). */
  cwd?: string
  /** Provider route for SDK-created agents (default `deepseek-official`). */
  provider?: string
  /** Model for SDK-created agents (default `deepseek-v4-flash`). */
  model?: string
  /** Maximum output tokens for each conversation-model request. */
  maxTokens?: number
}

/** A durable attempt accepted but not yet terminal. */
export type SessionAttemptPendingReceipt = SessionAttemptQueuedReceipt | SessionAttemptRunningReceipt

/** One owned session activity interval, from enqueue receipt through idle. */
export interface RunResult {
  /** The session the activity ran on. */
  sessionId: string
  /** Identity of the accepted prompt message. */
  messageId: string
  /** Durable attempt identity, absent on the legacy receipt-to-idle path. */
  attemptId?: string
  /** Durable input proof, absent on the legacy receipt-to-idle path. */
  inputSha256?: string
  /** Whether durable admission reused an existing attempt; always false on the legacy path. */
  deduplicated: boolean
  /** Concatenated text of the interval's last assistant message (empty when none). */
  finalResponse: string
  /** Terminal durable reason, or the legacy interval's last turn reason when present. */
  finishReason?: SessionAttemptFinishReason
  /** Durable terminal event sequence; absent on the legacy path. */
  terminalEventSeq?: number
  /** Persistence store binding for the durable path; absent on the legacy path. */
  runtimeBinding?: RuntimeBindingEnvelope
  /** Attempt-owning turn when known. */
  turn?: number
  /** Every `session.event` payload for the root session, in wire order. */
  events: SessionEvent[]
  /** Every notification for the root session and discovered descendants, in wire order. */
  notifications: HarnessNotification[]
}

/** Re-exported content-block alias so SDK callers need no extra import. */
export type { ContentBlock }

/** Canonical durable-attempt wire types, re-exported by the SDK facade. */
export type {
  SessionAttemptFinishReason,
  RuntimeBindingEnvelope,
  SessionAttemptIdentity,
  SessionAttemptLookupParams,
  SessionAttemptReceipt,
  SessionAttemptStartParams,
  SessionAttemptStartResult,
  SessionAttemptTerminalReceipt,
} from '@deepseek-ai/dsh-sdk-protocol'
