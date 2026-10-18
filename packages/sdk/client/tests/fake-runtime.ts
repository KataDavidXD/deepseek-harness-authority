#!/usr/bin/env node
/**
 * Scripted stand-in for the DeepSeek Harness SDK runtime, driven entirely by
 * env vars — no model, no network, no harness imports. Speaks the runtime's
 * newline-delimited JSON-RPC protocol on stdio: answers `initialize`,
 * `session/prompt` (streaming scripted `session.event` notifications, then
 * `session.finished`, then the response), and `shutdown`.
 *
 * Script vocabulary (all optional):
 * - `FAKE_TEXT`: assistant text for each turn (default `hello from fake runtime`).
 * - `FAKE_STATUS`: the `session.finished` status (default `ok`).
 * - `FAKE_REASON_KIND`: the `session.finished` reason kind (default `completed`; `none` omits the reason).
 * - `FAKE_SUBAGENT`: also emit a child session (subagent.started + child event + subagent.finished).
 * - `FAKE_ECHO_CWD`: prefix the assistant text with the process cwd.
 * - `FAKE_ECHO_ENV`: comma-separated env names to echo as `name=value` lines in the assistant text.
 * - `FAKE_MALFORMED`: `initialize` returns `{}` (no serverInfo); `prompt` returns `{}` (no accepted).
 * - `FAKE_MALFORMED_PROMPT`: `initialize` is normal; only `prompt` returns `{}` (no accepted).
 * - `FAKE_INIT_ERROR`: `initialize` answers a JSON-RPC error response with code 7.
 * - `FAKE_INIT_ERROR_ONCE_FILE`: fail `initialize` (code 7) only when this
 *   marker file does NOT exist yet, creating it — so the first runtime
 *   process fails the handshake and a respawned one succeeds (retry probe).
 * - `FAKE_ECHO_CWD_IN_INIT`: reply `serverInfo.version` = this process's cwd
 *   (wire-visible spawn-cwd probe).
 * - `FAKE_MALFORMED_EVENT`: the turn's `session.event` carries a number as
 *   the event; `FAKE_MALFORMED_MESSAGE`: assistant/message content is not an
 *   array; `FAKE_MESSAGE_WITHOUT_DATA`: assistant/message with no data
 *   member; `FAKE_MALFORMED_REASON`: `session.finished` reason is a bare
 *   string (wire-validation probes).
 * - `FAKE_EMPTY_MESSAGE`: the turn streams a text chunk, then records an empty
 *   assistant/message for a usage-only max-tokens step.
 * - `FAKE_HANG_INIT`: never answer `initialize` (mid-handshake cancel probe).
 * - `FAKE_INIT_READY` + `FAKE_INIT_GO`: touch the READY file when `initialize`
 *   arrives, then poll for the GO file before answering (deterministic
 *   cancel-during-handshake window).
 * - `FAKE_HANG_PROMPT`: never answer `session/prompt` (for timeout/dispose tests).
 * - `FAKE_STREAM_THEN_MALFORMED`: stream a text chunk for the prompt, then
 *   answer `{}` (no accepted) — same-pipe ordering makes the chunk arrive
 *   before the protocol failure (partial-output retention probe).
 * - `FAKE_IGNORE_EOF` + `FAKE_SIGTERM_FILE`: keep running after stdin EOF; touch the file on SIGTERM (ladder probe).
 * - `FAKE_TRAP_SIGTERM`: with `FAKE_IGNORE_EOF`, survive SIGTERM too (SIGKILL-rung probe).
 * - `FAKE_EXIT_BEFORE_INIT`: exit 3 immediately (spawn-then-die probe).
 * - `FAKE_STDERR`: write this line to stderr at boot (diagnostics-tail probe).
 * - `FAKE_STDERR_NO_NEWLINE`: write this to stderr WITHOUT a newline (buffer-flush probe).
 * - `FAKE_RECORD_INIT`: append each `initialize` params JSON to this file (handshake probe).
 * - `FAKE_ATTEMPT_TERMINAL`: `session/attempt.start` returns an already-terminal,
 *   deduplicated receipt without emitting notifications.
 * - `FAKE_ATTEMPT_IDENTITY_MISMATCH`: attempt responses carry a foreign
 *   `attemptId` (wire ownership-validation probe).
 * - `FAKE_ATTEMPT_BAD_STATUS`: attempt start returns an unknown receipt status.
 * - `FAKE_ATTEMPT_STALE_IDLE`: emit an unrelated root idle before the start
 *   response; the first exact get remains queued, then the owned turn settles.
 * - `FAKE_ATTEMPT_MESSAGE_MISMATCH`: terminal get changes the accepted message.
 * - `FAKE_ATTEMPT_TURN_MISMATCH`: start returns running turn 4 but terminal get
 *   claims turn 5.
 * - `FAKE_ATTEMPT_HASH_MISMATCH`: attempt receipts echo a foreign input hash.
 * - `FAKE_ATTEMPT_TERMINAL_IDLE_BEFORE_RESPONSE`: buffer idle before returning
 *   an already-terminal start receipt.
 * - `FAKE_ATTEMPT_CANCEL_ERROR`: reject cancellation with a JSON-RPC error.
 * - `FAKE_ATTEMPT_POLL_TERMINAL`: emit no notifications; the second exact get
 *   returns terminal proof (cross-process owner / lost-notification probe).
 * - `FAKE_ATTEMPT_PERMANENT_RUNNING`: emit no notifications and remain running.
 * - `FAKE_RECORD_METHODS`: append every received JSON-RPC method to this file.
 * - `FAKE_BINDING_ID_FILE`: read the persistence instance id from this file on
 *   every initialize (runtime-binding restart and mismatch probes).
 * - `FAKE_EXIT_AFTER_INIT_ONCE_FILE`: after the first successful initialize,
 *   create this marker and exit so the same high-level SDK must respawn.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { createInterface } from 'node:readline'

const env = process.env
const DEFAULT_PERSISTENCE_INSTANCE_ID = '11111111-1111-4111-8111-111111111111'

if (env.FAKE_STDERR !== undefined) process.stderr.write(`${env.FAKE_STDERR}\n`)
if (env.FAKE_STDERR_NO_NEWLINE !== undefined) process.stderr.write(env.FAKE_STDERR_NO_NEWLINE)
if (env.FAKE_EXIT_BEFORE_INIT !== undefined) process.exit(3)

if (env.FAKE_IGNORE_EOF !== undefined) {
  // Simulate a runtime that never quiesces from EOF so the dispose ladder
  // must escalate; record which rung fired.
  process.stdin.resume()
  process.stdin.on('end', () => { setInterval(() => {}, 1_000) })
  process.on('SIGTERM', () => {
    if (env.FAKE_SIGTERM_FILE !== undefined) writeFileSync(env.FAKE_SIGTERM_FILE, 'sigterm\n')
    if (env.FAKE_TRAP_SIGTERM === undefined) process.exit(0)
  })
}

function write(message: object): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function notify(method: string, params: object): void {
  write({ jsonrpc: '2.0', method, params })
}

function runtimeBinding(): object {
  const persistenceInstanceId = env.FAKE_BINDING_ID_FILE === undefined
    ? DEFAULT_PERSISTENCE_INSTANCE_ID
    : readFileSync(env.FAKE_BINDING_ID_FILE, 'utf8').trim()
  return {
    protocolVersion: 1,
    schemaVersion: 2,
    persistenceInstanceId,
    rootConfigSha256: 'c'.repeat(64),
  }
}

let seq = 0
const attempts = new Map<string, Record<string, unknown>>()
const staleIdleProbed = new Set<string>()
const attemptGetCounts = new Map<string, number>()
function event(sessionId: string, type: string, data: object): void {
  notify('session.event', { sessionId, event: { type, seq: seq++, time: 0, data } })
}

function assistantText(): string {
  const parts: string[] = []
  if (env.FAKE_ECHO_CWD !== undefined) parts.push(`cwd=${process.cwd()}`)
  for (const name of (env.FAKE_ECHO_ENV ?? '').split(',').filter(entry => entry.length > 0)) {
    parts.push(`${name}=${env[name] ?? ''}`)
  }
  parts.push(env.FAKE_TEXT ?? 'hello from fake runtime')
  return parts.join('\n')
}

function runTurn(sessionId: string): void {
  const text = assistantText()
  if (env.FAKE_MALFORMED_EVENT !== undefined) {
    notify('session.event', { sessionId, event: 42 })
    return
  }
  event(sessionId, 'turn/start', { turn: 0 })
  event(sessionId, 'assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text } })
  if (env.FAKE_MALFORMED_MESSAGE !== undefined) {
    event(sessionId, 'assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: 'fake-malformed-message',
        role: 'assistant',
        content: 'not-an-array',
        source: { kind: 'model', provider: 'fake', model: 'fake' },
      },
    })
    return
  }
  if (env.FAKE_MESSAGE_WITHOUT_DATA !== undefined) {
    notify('session.event', { sessionId, event: { type: 'assistant/message', seq: seq++, time: 0 } })
    return
  }
  event(sessionId, 'assistant/message', {
    turn: 0,
    step: 0,
    message: {
      id: `fake-assistant-${seq}`,
      role: 'assistant',
      // Model the usage-only message recorded after a max-tokens step that
      // assembled no output blocks.
      content: env.FAKE_EMPTY_MESSAGE !== undefined ? [] : [{ type: 'text', text }],
      source: { kind: 'model', provider: 'fake', model: 'fake' },
    },
  })
  const reasonKind = env.FAKE_REASON_KIND ?? 'completed'
  event(sessionId, 'turn/end', { turn: 0, reason: { kind: reasonKind } })
  if (env.FAKE_SUBAGENT !== undefined) {
    const childId = `${sessionId}-child`
    notify('subagent.started', { parentSessionId: sessionId, childSessionId: childId })
    event(childId, 'assistant/message', {
      turn: 0,
      step: 0,
      content: [{ type: 'text', text: 'child says hi' }],
      provenance: { provider: 'fake', model: 'fake' },
    })
    notify('subagent.finished', {
      provider: 'spawn',
      agentId: childId,
      parentSessionId: sessionId,
      childSessionId: childId,
      status: 'ok',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'child says hi' }],
    })
  }
}

function sessionIdOf(params: Record<string, unknown> | undefined): string {
  const value = params?.sessionId
  return typeof value === 'string' ? value : ''
}

function stringParamOf(params: Record<string, unknown> | undefined, key: string): string {
  const value = params?.[key]
  return typeof value === 'string' ? value : ''
}

function attemptKey(params: Record<string, unknown> | undefined): string {
  return `${stringParamOf(params, 'sessionId')}\u0000${stringParamOf(params, 'attemptId')}`
}

function attemptIdentity(
  params: Record<string, unknown> | undefined,
  messageId: string,
): Record<string, unknown> {
  return {
    sessionId: stringParamOf(params, 'sessionId'),
    attemptId: env.FAKE_ATTEMPT_IDENTITY_MISMATCH === undefined
      ? stringParamOf(params, 'attemptId')
      : 'foreign-attempt',
    inputSha256: env.FAKE_ATTEMPT_HASH_MISMATCH === undefined
      ? stringParamOf(params, 'inputSha256')
      : 'f'.repeat(64),
    messageId,
    runtimeBinding: runtimeBinding(),
  }
}

function settleAttempt(
  params: Record<string, unknown> | undefined,
  identity: Record<string, unknown>,
  sessionId: string,
): void {
  runTurn(sessionId)
  attempts.set(attemptKey(params), {
    ...identity,
    ...(env.FAKE_ATTEMPT_MESSAGE_MISMATCH === undefined ? {} : { messageId: 'foreign-message' }),
    status: 'terminal',
    turn: env.FAKE_ATTEMPT_TURN_MISMATCH === undefined ? 0 : 5,
    terminalEventSeq: seq - 1,
    finishReason: { kind: env.FAKE_REASON_KIND ?? 'completed' },
    finalResponse: assistantText(),
  })
  notify('session.status', { sessionId, status: 'idle' })
}

const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  if (line.trim().length === 0) return
  const frame = JSON.parse(line) as { id?: string | number; method?: string; params?: Record<string, unknown> }
  if (frame.method === undefined || frame.id === undefined) return
  if (env.FAKE_RECORD_METHODS !== undefined) appendFileSync(env.FAKE_RECORD_METHODS, `${frame.method}\n`)
  const respond = (result: object): void => { write({ jsonrpc: '2.0', id: frame.id, result }) }
  switch (frame.method) {
    case 'initialize':
      if (env.FAKE_RECORD_INIT !== undefined) appendFileSync(env.FAKE_RECORD_INIT, `${JSON.stringify(frame.params)}\n`)
      if (env.FAKE_HANG_INIT !== undefined) return
      if (env.FAKE_INIT_READY !== undefined && env.FAKE_INIT_GO !== undefined) {
        writeFileSync(env.FAKE_INIT_READY, 'ready\n')
        const go = env.FAKE_INIT_GO
        const id = frame.id
        const poll = setInterval(() => {
          if (!existsSync(go)) return
          clearInterval(poll)
          write({ jsonrpc: '2.0', id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } })
        }, 5)
        return
      }
      if (env.FAKE_INIT_ERROR !== undefined) {
        write({ jsonrpc: '2.0', id: frame.id, error: { code: 7, message: 'scripted init failure', data: { hint: 'fake' } } })
        return
      }
      if (env.FAKE_INIT_ERROR_ONCE_FILE !== undefined && !existsSync(env.FAKE_INIT_ERROR_ONCE_FILE)) {
        writeFileSync(env.FAKE_INIT_ERROR_ONCE_FILE, 'failed-once\n')
        write({ jsonrpc: '2.0', id: frame.id, error: { code: 7, message: 'scripted first-boot failure' } })
        return
      }
      if (env.FAKE_MALFORMED !== undefined) {
        respond({})
        return
      }
      if (env.FAKE_ECHO_CWD_IN_INIT !== undefined) {
        respond({ serverInfo: { name: 'deepseek-harness-sdk-runtime', version: process.cwd() } })
        return
      }
      respond({
        serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' },
        runtimeBinding: runtimeBinding(),
      })
      if (env.FAKE_EXIT_AFTER_INIT_ONCE_FILE !== undefined
        && !existsSync(env.FAKE_EXIT_AFTER_INIT_ONCE_FILE)) {
        writeFileSync(env.FAKE_EXIT_AFTER_INIT_ONCE_FILE, 'exited\n')
        setImmediate(() => process.exit(23))
      }
      return
    case 'session/prompt': {
      const sessionId = sessionIdOf(frame.params)
      const messageId = `fake-user-${seq}`
      event(sessionId, 'agent/inbox/spliced', {
        target: 'next-turn',
        start: 0,
        inserted: [{
          id: messageId,
          role: 'user',
          content: [],
          source: { kind: 'user' },
        }],
      })
      notify('session.status', { sessionId, status: 'running' })
      if (env.FAKE_STREAM_THEN_MALFORMED !== undefined) {
        event(sessionId, 'assistant/chunk', { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'streamed then cut short' } })
        respond({})
        return
      }
      if (env.FAKE_HANG_PROMPT !== undefined) return
      if (env.FAKE_MALFORMED !== undefined || env.FAKE_MALFORMED_PROMPT !== undefined) {
        respond({})
        return
      }
      runTurn(sessionId)
      notify('session.status', { sessionId, status: 'idle' })
      respond({ messageId })
      return
    }
    case 'session/attempt.start': {
      const sessionId = sessionIdOf(frame.params)
      const messageId = `fake-attempt-${stringParamOf(frame.params, 'attemptId')}`
      const identity = attemptIdentity(frame.params, messageId)
      if (env.FAKE_ATTEMPT_BAD_STATUS !== undefined) {
        respond({ attempt: { ...identity, status: 'mystery' }, deduplicated: false })
        return
      }
      if (env.FAKE_ATTEMPT_TERMINAL !== undefined) {
        const terminal = {
          ...identity,
          status: 'terminal',
          turn: 7,
          terminalEventSeq: 71,
          finishReason: { kind: 'completed' },
          finalResponse: assistantText(),
        }
        attempts.set(attemptKey(frame.params), terminal)
        if (env.FAKE_ATTEMPT_TERMINAL_IDLE_BEFORE_RESPONSE !== undefined) {
          notify('session.status', { sessionId, status: 'idle' })
        }
        respond({ attempt: terminal, deduplicated: true })
        return
      }

      const runningWithoutNotifications = env.FAKE_ATTEMPT_POLL_TERMINAL !== undefined
        || env.FAKE_ATTEMPT_PERMANENT_RUNNING !== undefined
      const pending = env.FAKE_ATTEMPT_TURN_MISMATCH === undefined && !runningWithoutNotifications
        ? { ...identity, status: 'queued' }
        : { ...identity, status: 'running', turn: 4 }
      attempts.set(attemptKey(frame.params), pending)
      if (env.FAKE_ATTEMPT_STALE_IDLE !== undefined) {
        notify('session.status', { sessionId, status: 'idle' })
      }
      respond({ attempt: pending, deduplicated: false })
      if (env.FAKE_ATTEMPT_STALE_IDLE === undefined && !runningWithoutNotifications) {
        setImmediate(() => { settleAttempt(frame.params, identity, sessionId) })
      }
      return
    }
    case 'session/attempt.get': {
      const key = attemptKey(frame.params)
      let attempt = attempts.get(key) ?? null
      if (env.FAKE_ATTEMPT_POLL_TERMINAL !== undefined && attempt !== null) {
        const count = (attemptGetCounts.get(key) ?? 0) + 1
        attemptGetCounts.set(key, count)
        if (count >= 2) {
          attempt = {
            ...attempt,
            status: 'terminal',
            turn: 4,
            terminalEventSeq: 42,
            finishReason: { kind: 'completed' },
            finalResponse: 'polled terminal answer',
          }
          attempts.set(key, attempt)
        }
      }
      respond({ attempt })
      if (env.FAKE_ATTEMPT_STALE_IDLE !== undefined
        && attempt?.status === 'queued'
        && !staleIdleProbed.has(key)) {
        staleIdleProbed.add(key)
        const identity = { ...attempt }
        const sessionId = sessionIdOf(frame.params)
        setImmediate(() => { settleAttempt(frame.params, identity, sessionId) })
      }
      return
    }
    case 'session/attempt.cancel': {
      if (env.FAKE_ATTEMPT_CANCEL_ERROR !== undefined) {
        write({
          jsonrpc: '2.0',
          id: frame.id,
          error: { code: -32043, message: 'running attempt is not cancellable' },
        })
        return
      }
      const key = attemptKey(frame.params)
      const prior = attempts.get(key)
      const messageId = typeof prior?.messageId === 'string'
        ? prior.messageId
        : `fake-attempt-${stringParamOf(frame.params, 'attemptId')}`
      const terminal = {
        ...attemptIdentity(frame.params, messageId),
        status: 'terminal',
        terminalEventSeq: seq++,
        finishReason: { kind: 'canceled' },
        finalResponse: '',
      }
      attempts.set(key, terminal)
      respond({ attempt: terminal })
      return
    }
    case 'shutdown':
      respond({})
      // An EOF-ignoring fake also refuses the protocol exit, so the client's
      // dispose ladder (not this cooperative path) must reap it.
      if (env.FAKE_IGNORE_EOF === undefined) setImmediate(() => process.exit(0))
      return
    default:
      write({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: `unknown method: ${frame.method}` } })
  }
})
