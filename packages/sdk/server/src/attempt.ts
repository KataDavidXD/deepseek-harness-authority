/**
 * Durable SDK-attempt identity, wire validation, and session-log projection.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/attempt
 */

import { createHash } from 'node:crypto'
import {
  MessageId,
  freezeMessage,
  type ContentBlock,
  type MessageSource,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SESSION_ATTEMPT_ID_MAX_LENGTH,
  type RuntimeBindingEnvelope,
  type SessionAttemptLookupParams,
  type SessionAttemptReceipt,
  type SessionAttemptStartParams,
} from '@deepseek-ai/dsh-sdk-protocol'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Ordinary user input carrying an SDK durable-attempt fence. */
    sdkAttempt: {
      kind: 'user'
      attemptId: string
      inputSha256: string
    }
  }
}

/** Internal projection plus the first durably accepted content snapshot. */
export interface AttemptProjection {
  /** Current public receipt. */
  receipt: SessionAttemptReceipt
  /** Exact content admitted by the first inbox insertion. */
  contentBlocks: readonly ContentBlock[]
}

const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:~-]*$/
const INPUT_SHA256_PATTERN = /^[0-9a-f]{64}$/

/** Whether a value is a non-array object suitable for named wire fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reject values JSON cannot reproduce exactly before any agent dispatch. */
function assertJsonValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only finite JSON numbers`)
    return
  }
  if (typeof value !== 'object') throw new TypeError(`${path} must be JSON-serializable`)
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain a cycle`)
  const prototype = Object.getPrototypeOf(value) as unknown
  const array = Array.isArray(value)
  if ((array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype && prototype !== null)) {
    throw new TypeError(`${path} must contain only JSON objects and arrays`)
  }
  ancestors.add(value)
  try {
    const keys = Reflect.ownKeys(value)
    if (array) {
      let indices = 0
      for (const key of keys) {
        if (key === 'length') continue
        if (typeof key !== 'string') throw new TypeError(`${path} must not contain symbol keys`)
        const index = Number(key)
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          throw new TypeError(`${path} arrays must not contain named properties`)
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new TypeError(`${path}[${index}] must be an enumerable data property`)
        }
        assertJsonValue(descriptor.value, `${path}[${index}]`, ancestors)
        indices += 1
      }
      if (indices !== value.length) throw new TypeError(`${path} must not contain sparse arrays`)
      return
    }
    for (const key of keys) {
      if (typeof key !== 'string') throw new TypeError(`${path} must not contain symbol keys`)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${path}.${key} must be an enumerable data property`)
      }
      assertJsonValue(descriptor.value, `${path}.${key}`, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Validate fields shared by start/get/cancel before persistence or dispatch.
 * @param value - untrusted direct-call or JSON-RPC params.
 * @returns a normalized identity lookup.
 */
export function validateAttemptLookupParams(value: unknown): SessionAttemptLookupParams {
  if (!isRecord(value)) throw new TypeError('attempt params must be an object')
  const { sessionId, attemptId, inputSha256 } = value
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('attempt sessionId must be a non-empty string')
  }
  if (typeof attemptId !== 'string'
    || attemptId.length === 0
    || attemptId.length > SESSION_ATTEMPT_ID_MAX_LENGTH
    || !ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw new TypeError(`attemptId must be 1-${SESSION_ATTEMPT_ID_MAX_LENGTH} safe ASCII characters`)
  }
  if (typeof inputSha256 !== 'string' || !INPUT_SHA256_PATTERN.test(inputSha256)) {
    throw new TypeError('inputSha256 must be 64 lowercase hexadecimal characters')
  }
  return { sessionId, attemptId, inputSha256 }
}

/**
 * Validate one durable start request before persistence or agent dispatch.
 * @param value - untrusted direct-call or JSON-RPC params.
 * @returns normalized identity and JSON-safe content blocks.
 */
export function validateAttemptStartParams(value: unknown): SessionAttemptStartParams {
  const lookup = validateAttemptLookupParams(value)
  const contentBlocks = (value as Record<string, unknown>)['contentBlocks']
  if (!Array.isArray(contentBlocks)) throw new TypeError('attempt contentBlocks must be an array')
  assertJsonValue(contentBlocks, 'attempt contentBlocks', new Set())
  for (const [index, block] of contentBlocks.entries()) {
    if (!isRecord(block) || typeof block['type'] !== 'string' || block['type'].length === 0) {
      throw new TypeError(`attempt contentBlocks[${index}] must have a non-empty string type`)
    }
  }
  return { ...lookup, contentBlocks: contentBlocks as ContentBlock[] }
}

/**
 * Deterministically derive the only message id permitted for an attempt.
 * @param sessionId - durable session identity.
 * @param attemptId - caller-owned idempotency identity.
 * @returns namespaced hash-bound message id.
 */
export function attemptMessageId(sessionId: string, attemptId: string): string {
  const digest = createHash('sha256')
    .update('dsh-sdk-attempt\0', 'utf8')
    .update(sessionId, 'utf8')
    .update('\0', 'utf8')
    .update(attemptId, 'utf8')
    .digest('hex')
  return `dsh-sdk-attempt:${digest}`
}

/**
 * Create the exact immutable inbox message for a validated start request.
 * @param params - validated attempt identity and content.
 * @returns frozen user message carrying the attempt source extension.
 */
export function createAttemptMessage(params: SessionAttemptStartParams): UserMessage {
  return freezeMessage({
    id: MessageId(attemptMessageId(params.sessionId, params.attemptId)),
    role: 'user' as const,
    content: params.contentBlocks,
    source: {
      kind: 'user' as const,
      attemptId: params.attemptId,
      inputSha256: params.inputSha256,
    },
  })
}

/** Narrow a merge-extensible message source to the SDK attempt extension. */
function isAttemptSource(source: MessageSource): source is Extract<MessageSource, { attemptId: string }> {
  return source.kind === 'user'
    && 'attemptId' in source
    && typeof source.attemptId === 'string'
    && 'inputSha256' in source
    && typeof source.inputSha256 === 'string'
}

/** Stable JSON representation used only for exact retry-content comparison. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
}

/** Text blocks from the last assistant message in a turn. */
function assistantText(event: Extract<SessionEvent, { type: 'assistant/message' }>): string {
  return event.data.message.content
    .filter((block): block is ContentBlock & { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Fold one immutable session log into the current exact attempt receipt.
 * Identity, hash, content, and single-admission violations fail closed.
 * @param events - complete live or persisted event prefix.
 * @param lookup - exact identity fence to project.
 * @param runtimeBinding - exact persistence and protocol identity echoed in the receipt.
 * @returns attempt content and receipt, or `null` when absent.
 */
export function projectAttempt(
  events: readonly SessionEvent[],
  lookup: SessionAttemptLookupParams,
  runtimeBinding: RuntimeBindingEnvelope,
): AttemptProjection | null {
  const messageId = attemptMessageId(lookup.sessionId, lookup.attemptId)
  const inbox: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  let accepted: UserMessage | undefined
  let acceptedCanonical: string | undefined
  let insertionCount = 0
  let enteredCount = 0
  let currentTurn: number | undefined
  let claimedTurn: number | undefined
  let canceledSeq: number | undefined
  let terminal: { seq: number; reason: Extract<SessionEvent, { type: 'turn/end' }>['data']['reason'] } | undefined
  const assistantByTurn = new Map<number, string>()

  const observe = (message: UserMessage, origin: 'inbox' | 'turn'): void => {
    const source = message.source
    const collides = message.id === messageId
      || (isAttemptSource(source) && source.attemptId === lookup.attemptId)
    if (!collides) return
    if (!isAttemptSource(source)
      || source.attemptId !== lookup.attemptId
      || source.inputSha256 !== lookup.inputSha256
      || message.id !== messageId) {
      throw new Error(`durable attempt identity conflict for "${lookup.attemptId}"`)
    }
    const canonical = canonicalJson(message.content)
    if (acceptedCanonical !== undefined && canonical !== acceptedCanonical) {
      throw new Error(`durable attempt content conflict for "${lookup.attemptId}"`)
    }
    accepted ??= message
    acceptedCanonical ??= canonical
    if (origin === 'inbox') insertionCount += 1
    else enteredCount += 1
  }

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        currentTurn = event.data.turn
        break
      case 'agent/inbox/spliced': {
        const target = event.data.target
        const pending = inbox[target]
        const removed = pending.slice(event.data.start, event.data.start + (event.data.removedCount ?? 0))
        for (const message of event.data.inserted) observe(message, 'inbox')
        pending.splice(event.data.start, event.data.removedCount ?? 0, ...event.data.inserted)
        if (removed.some(message => message.id === messageId)) {
          if (event.data.outcome === 'canceled') canceledSeq = event.seq
          else if (currentTurn !== undefined) claimedTurn = currentTurn
          else throw new Error(`durable attempt "${lookup.attemptId}" was claimed outside a turn`)
        }
        break
      }
      case 'user/message':
        observe(event.data, 'turn')
        if (event.data.id === messageId) {
          if (currentTurn === undefined) throw new Error(`durable attempt "${lookup.attemptId}" entered outside a turn`)
          claimedTurn = currentTurn
        }
        break
      case 'assistant/message':
        assistantByTurn.set(event.data.turn, assistantText(event))
        break
      case 'turn/end':
        if (claimedTurn === event.data.turn) {
          if (terminal !== undefined) throw new Error(`durable attempt "${lookup.attemptId}" has multiple terminal turns`)
          terminal = { seq: event.seq, reason: event.data.reason }
        }
        if (currentTurn === event.data.turn) currentTurn = undefined
        break
      default:
        break
    }
  }

  if (accepted === undefined) return null
  if (insertionCount !== 1 || enteredCount > 1) {
    throw new Error(`durable attempt "${lookup.attemptId}" was admitted more than once`)
  }
  const identity = {
    sessionId: lookup.sessionId,
    attemptId: lookup.attemptId,
    inputSha256: lookup.inputSha256,
    messageId,
    runtimeBinding,
  }
  const contentBlocks = accepted.content
  if (terminal !== undefined) {
    return {
      contentBlocks,
      receipt: {
        ...identity,
        status: 'terminal',
        ...(claimedTurn === undefined ? {} : { turn: claimedTurn }),
        finishReason: terminal.reason,
        terminalEventSeq: terminal.seq,
        finalResponse: claimedTurn === undefined ? '' : (assistantByTurn.get(claimedTurn) ?? ''),
      },
    }
  }
  if (canceledSeq !== undefined) {
    return {
      contentBlocks,
      receipt: {
        ...identity,
        status: 'terminal',
        finishReason: { kind: 'canceled' },
        terminalEventSeq: canceledSeq,
        finalResponse: '',
      },
    }
  }
  if (inbox['next-turn'].some(message => message.id === messageId)
    || inbox['next-step'].some(message => message.id === messageId)) {
    return { contentBlocks, receipt: { ...identity, status: 'queued' } }
  }
  if (claimedTurn !== undefined) {
    return { contentBlocks, receipt: { ...identity, status: 'running', turn: claimedTurn } }
  }
  throw new Error(`durable attempt "${lookup.attemptId}" has no queued, running, or terminal state`)
}

/**
 * Assert that a retry repeats the first durably admitted content exactly.
 * @param projection - first accepted attempt projection.
 * @param params - repeated start request to compare.
 */
export function assertAttemptContent(
  projection: AttemptProjection,
  params: SessionAttemptStartParams,
): void {
  if (canonicalJson(projection.contentBlocks) !== canonicalJson(params.contentBlocks)) {
    throw new Error(`durable attempt content conflict for "${params.attemptId}"`)
  }
}
