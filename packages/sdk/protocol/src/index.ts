/**
 * Shared wire protocol for the DeepSeek Harness SDK runtime: the
 * newline-delimited JSON-RPC stdio transport plus the named request, result,
 * and notification types both wire ends speak. The runtime server plugin
 * (`@deepseek-ai/dsh-sdk-jsonrpc-server`) serves this protocol; SDK clients
 * (`@deepseek-ai/dsh-sdk-client`, the Python SDK) drive it.
 *
 * @module @deepseek-ai/dsh-sdk-protocol
 */

export { JsonRpcLineTransport, JsonRpcResponseError } from './transport.ts'
export type { JsonRpcTransportPeer } from './transport.ts'
export type {
  HarnessSdkNotificationMap,
  HarnessSdkRequestMap,
  InitializeParams,
  InitializeResult,
  RuntimeBindingEnvelope,
  SdkRunStatus,
  SessionEventNotification,
  SessionAttemptCancelResult,
  SessionAttemptFinishReason,
  SessionAttemptGetResult,
  SessionAttemptIdentity,
  SessionAttemptLookupParams,
  SessionAttemptQueuedReceipt,
  SessionAttemptReceipt,
  SessionAttemptRunningReceipt,
  SessionAttemptStartParams,
  SessionAttemptStartResult,
  SessionAttemptTerminalReceipt,
  SessionStatusNotification,
  SessionPromptParams,
  SessionPromptResult,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from './types.ts'
export {
  RUNTIME_BINDING_PROTOCOL_VERSION,
  RUNTIME_BINDING_SCHEMA_VERSION,
  SESSION_ATTEMPT_ID_MAX_LENGTH,
} from './types.ts'
