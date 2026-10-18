/**
 * High-level run API over {@link HarnessClient}: `DeepSeekHarness` owns one
 * runtime subprocess across many sessions; `HarnessSession.run` sends a
 * prompt and settles when the whole agent next becomes idle.
 * Mirrors the Python SDK's `DeepSeekHarness`/`Session` pair.
 *
 * @module @deepseek-ai/dsh-sdk-client/api
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  AttemptTimeoutError,
  HarnessClient,
  isRecord,
  RequestTimeoutError,
  RuntimeBindingMismatchError,
  SdkProtocolError,
  TransportClosedError,
  sameRuntimeBinding,
} from './client.ts'
import type {
  ContentBlock,
  DeepSeekHarnessOptions,
  HarnessClientOptions,
  HarnessNotification,
  RunResult,
  RuntimeBindingEnvelope,
  SessionAttemptFinishReason,
  SessionAttemptLookupParams,
  SessionAttemptReceipt,
  SessionAttemptTerminalReceipt,
} from './types.ts'

const DEFAULT_ATTEMPT_TIMEOUT_MS = 300_000
const DEFAULT_ATTEMPT_POLL_INTERVAL_MS = 1_000

/**
 * Reusable SDK for running DeepSeek Harness agent turns in a runtime
 * subprocess. The subprocess starts lazily on first use and stays owned by
 * this instance until {@link close}; always close (or `await using`) so the
 * child is reaped.
 */
export class DeepSeekHarness implements AsyncDisposable {
  private clientInstance: HarnessClient
  private readonly launch: HarnessClientOptions
  private readonly cwd: string
  private readonly provider: string
  private readonly model: string
  private readonly maxTokens: number | undefined
  private initialized: Promise<void> | undefined
  private starting = false
  private runtimeBindingValue: RuntimeBindingEnvelope | undefined
  private closed = false

  /** @param options - runtime launch spec plus the session route (cwd/provider/model). */
  constructor(options: DeepSeekHarnessOptions) {
    this.launch = options.launch
    this.clientInstance = new HarnessClient(options.launch)
    // Absolute before the handshake: the child spawns relative to THIS
    // process's cwd, but the wire cwd is resolved again inside the child — a
    // relative value would double-resolve (e.g. `worker` → `worker/worker`).
    this.cwd = resolve(options.cwd ?? options.launch.cwd ?? process.cwd())
    this.provider = options.provider ?? 'deepseek-official'
    this.model = options.model ?? 'deepseek-v4-flash'
    this.maxTokens = options.maxTokens
  }

  /**
   * The underlying JSON-RPC client (exposed for low-level access). A failed
   * handshake reaps its runtime and swaps in a fresh instance, so do not
   * cache this across a failed {@link start}.
   * @returns the client currently owning the runtime subprocess.
   */
  get client(): HarnessClient {
    return this.clientInstance
  }

  /**
   * Start the subprocess and perform the `initialize` handshake once. On
   * failure the runtime is reaped and a fresh client replaces it
   * (`HarnessClient.close` is permanent), so a later call retries with a new
   * subprocess — unless {@link close} already ended this harness.
   * @returns settlement of the (memoized) handshake.
   */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new TransportClosedError('DeepSeek Harness runtime client is closed'))
    if (this.initialized !== undefined && (this.starting || this.clientInstance.isRunning)) {
      return this.initialized
    }
    const replacingDeadRuntime = this.initialized !== undefined
    const previous = this.clientInstance
    if (replacingDeadRuntime) this.clientInstance = new HarnessClient(this.launch)
    const current = this.clientInstance
    this.starting = true
    this.initialized = (async () => {
      try {
        if (replacingDeadRuntime) await previous.close()
        if (this.closed) throw new TransportClosedError('DeepSeek Harness runtime client is closed')
        current.start()
        const initialized = await current.initialize({
          cwd: this.cwd,
          provider: this.provider,
          model: this.model,
          ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
        })
        if (initialized.runtimeBinding !== undefined) this.pinRuntimeBinding(initialized.runtimeBinding)
      } catch (error) {
        this.initialized = undefined
        await current.close()
        if (!this.closed && this.clientInstance === current) this.clientInstance = new HarnessClient(this.launch)
        throw error
      } finally {
        this.starting = false
      }
    })()
    return this.initialized
  }

  /**
   * Initialize without dispatching a prompt and return the pinned store binding.
   * @returns a detached versioned binding envelope.
   */
  async getRuntimeBinding(): Promise<RuntimeBindingEnvelope> {
    await this.start()
    if (this.runtimeBindingValue === undefined) {
      throw new SdkProtocolError('initialize returned no persistence runtime binding')
    }
    return Object.freeze({ ...this.runtimeBindingValue })
  }

  /**
   * Open a session handle (no wire traffic; the runtime creates the session
   * on its first prompt).
   * @param sessionId - explicit id to reuse; omitted mints a fresh one.
   * @returns the session handle.
   */
  session(sessionId?: string): HarnessSession {
    return new HarnessSession(this, sessionId ?? `session-${randomUUID().replaceAll('-', '')}`)
  }

  /**
   * Run one prompt on a fresh (or named) session.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional session id and per-notification observer.
   * @returns the owned activity interval.
   */
  run(input: string | ContentBlock[], options?: RunOptions): Promise<RunResult> {
    return this.session(options?.sessionId).run(input, options)
  }

  /**
   * Read one durable attempt without creating it.
   * @param params - exact session/attempt/input identity.
   * @returns runtime-owned state, or `null` when absent.
   */
  async getAttempt(params: SessionAttemptLookupParams): Promise<SessionAttemptReceipt | null> {
    await this.start()
    return this.clientInstance.getAttempt(params)
  }

  /**
   * Cancel one exact durable attempt and return terminal proof.
   * @param params - exact session/attempt/input identity.
   * @returns runtime-owned terminal cancellation proof.
   */
  async cancelAttempt(params: SessionAttemptLookupParams): Promise<SessionAttemptTerminalReceipt> {
    await this.start()
    return this.clientInstance.cancelAttempt(params)
  }

  /**
   * Shut down and reap the runtime subprocess. Idempotent and terminal —
   * a closed harness no longer retries a failed handshake.
   * @returns settlement of the complete teardown.
   */
  close(): Promise<void> {
    this.closed = true
    return this.clientInstance.close()
  }

  /**
   * `await using` support: {@link close}.
   * @returns settlement of the teardown.
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  /** Preserve the first binding across subprocess generations. */
  private pinRuntimeBinding(binding: RuntimeBindingEnvelope): void {
    if (this.runtimeBindingValue === undefined) {
      this.runtimeBindingValue = Object.freeze({ ...binding })
      return
    }
    if (!sameRuntimeBinding(this.runtimeBindingValue, binding)) {
      throw new RuntimeBindingMismatchError(this.runtimeBindingValue, binding)
    }
  }
}

/** Per-run options: target session and streaming observer. */
export interface RunOptions {
  /** Session id to run on; omitted mints a fresh session per call. */
  sessionId?: string
  /** Caller-stable durable idempotency identity; requires {@link inputSha256}. */
  attemptId?: string
  /** Lowercase SHA-256 of the exact durable input; requires {@link attemptId}. */
  inputSha256?: string
  /** Durable terminal-proof deadline in milliseconds (default 300000); never cancels the attempt. */
  attemptTimeoutMs?: number
  /** Exact-state polling interval in milliseconds (default 1000); notifications remain a fast path. */
  attemptPollIntervalMs?: number
  /** Observer invoked with every notification for this session tree, in wire order. */
  onNotification?: (notification: HarnessNotification) => void
}

/**
 * One SDK session: a stable id plus owned activity intervals.
 */
export class HarnessSession {
  /**
   * @param harness - the owning harness (supplies the client and handshake).
   * @param id - the wire session id this handle runs on.
   */
  constructor(readonly harness: DeepSeekHarness, readonly id: string) {}

  /**
   * Queue one prompt, then observe the whole session through its next idle.
   * @param input - prompt text, or content blocks sent verbatim.
   * @param options - optional per-notification observer.
   * @returns the owned activity interval; rejects on transport loss, timeout,
   * or a protocol error.
   */
  async run(
    input: string | ContentBlock[],
    options?: Pick<
      RunOptions,
      'attemptId' | 'attemptPollIntervalMs' | 'attemptTimeoutMs' | 'inputSha256' | 'onNotification'
    >,
  ): Promise<RunResult> {
    const durableIdentity = durableIdentityOf(this.id, options)
    const attemptTiming = durableIdentity === undefined ? undefined : durableAttemptTiming(options)
    await this.harness.start()
    const client = this.harness.client
    const contentBlocks = normalizeInput(input)
    const events: SessionEvent[] = []
    const notifications: HarnessNotification[] = []

    const subscription = client.subscribeSessionTree(this.id)
    const collect = (notification: HarnessNotification): void => {
      if (notification.method === 'session.event' && notification.params.sessionId === this.id) {
        // Wire boundary: the envelope feeds the typed RunResult, so a
        // malformed runtime surfaces as a protocol error, not as type-invalid
        // data (or a TypeError out of finalResponse).
        const event = validatedSessionEvent(notification.params.event)
        notifications.push(notification)
        options?.onNotification?.(notification)
        events.push(event)
        return
      }
      notifications.push(notification)
      options?.onNotification?.(notification)
    }
    let messageId: string
    let deduplicated = false
    let terminal: SessionAttemptTerminalReceipt | undefined
    let observedTurn: number | undefined
    try {
      if (durableIdentity === undefined) {
        messageId = await client.prompt(this.id, contentBlocks)
        let received = false
        while (true) {
          const notification = await subscription.next()
          if (!received) {
            if (notification.method !== 'session.event'
              || notification.params.sessionId !== this.id
              || !isInboxReceipt(notification.params.event, messageId)) continue
            received = true
          }
          collect(notification)
          if (isRootIdle(notification, this.id)) break
        }
      } else {
        /* v8 ignore next -- durable identity and timing are constructed together */
        if (attemptTiming === undefined) throw new SdkProtocolError('durable attempt timing was not initialized')
        const deadline = performance.now() + attemptTiming.timeoutMs
        const started = await attemptRequestBeforeDeadline(
          durableIdentity,
          attemptTiming.timeoutMs,
          deadline,
          remainingMs => client.startAttempt({ ...durableIdentity, contentBlocks }, remainingMs),
        )
        messageId = started.attempt.messageId
        deduplicated = started.deduplicated
        if (started.attempt.status === 'terminal') {
          terminal = started.attempt
        } else {
          if (started.attempt.status === 'running') observedTurn = started.attempt.turn
          let nextPollAt = performance.now() + attemptTiming.pollIntervalMs
          while (terminal === undefined) {
            const now = performance.now()
            if (now >= deadline) {
              throw attemptTimeoutError(durableIdentity, attemptTiming.timeoutMs)
            }
            if (now >= nextPollAt) {
              const settled = await attemptRequestBeforeDeadline(
                durableIdentity,
                attemptTiming.timeoutMs,
                deadline,
                remainingMs => client.getAttempt(durableIdentity, remainingMs),
              )
              const progress = validatedAttemptProgress(settled, messageId, observedTurn)
              observedTurn = progress.observedTurn
              terminal = progress.terminal
              nextPollAt = performance.now() + attemptTiming.pollIntervalMs
              continue
            }
            const waitMs = Math.max(0, Math.min(nextPollAt, deadline) - now)
            const notification = await subscription.nextWithin(waitMs)
            if (notification === undefined) continue
            collect(notification)
            if (!isRootIdle(notification, this.id)) continue
            const settled = await attemptRequestBeforeDeadline(
              durableIdentity,
              attemptTiming.timeoutMs,
              deadline,
              remainingMs => client.getAttempt(durableIdentity, remainingMs),
            )
            const progress = validatedAttemptProgress(settled, messageId, observedTurn)
            observedTurn = progress.observedTurn
            terminal = progress.terminal
            nextPollAt = performance.now() + attemptTiming.pollIntervalMs
          }
        }
      }
    } finally {
      subscription.close()
    }

    if (durableIdentity !== undefined) {
      /* v8 ignore next -- both durable branches above establish terminal or throw */
      if (terminal === undefined) throw new SdkProtocolError('durable attempt settled without terminal proof')
      return {
        sessionId: this.id,
        messageId,
        attemptId: durableIdentity.attemptId,
        inputSha256: durableIdentity.inputSha256,
        deduplicated,
        finalResponse: terminal.finalResponse,
        finishReason: terminal.finishReason,
        terminalEventSeq: terminal.terminalEventSeq,
        runtimeBinding: terminal.runtimeBinding,
        ...(terminal.turn === undefined ? {} : { turn: terminal.turn }),
        events,
        notifications,
      }
    }

    const finishReason = lastFinishReason(events)
    return {
      sessionId: this.id,
      messageId,
      deduplicated: false,
      finalResponse: finalResponse(events),
      ...(finishReason === undefined ? {} : { finishReason }),
      events,
      notifications,
    }
  }

  /**
   * Read one durable attempt owned by this session.
   * @param attemptId - caller-stable attempt identity.
   * @param inputSha256 - lowercase SHA-256 of the exact input.
   * @returns runtime-owned state, or `null` when absent.
   */
  getAttempt(attemptId: string, inputSha256: string): Promise<SessionAttemptReceipt | null> {
    return this.harness.getAttempt({ sessionId: this.id, attemptId, inputSha256 })
  }

  /**
   * Cancel one durable attempt owned by this session.
   * @param attemptId - caller-stable attempt identity.
   * @param inputSha256 - lowercase SHA-256 of the exact input.
   * @returns runtime-owned terminal cancellation proof.
   */
  cancelAttempt(attemptId: string, inputSha256: string): Promise<SessionAttemptTerminalReceipt> {
    return this.harness.cancelAttempt({ sessionId: this.id, attemptId, inputSha256 })
  }
}

/**
 * Normalize run input: a string becomes one text block; blocks pass verbatim.
 * @param input - prompt text or content blocks.
 * @returns the content blocks to send.
 */
export function normalizeInput(input: string | ContentBlock[]): ContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input
}

/** Validate the fields in a wire `session.event` envelope before returning the typed result. */
function validatedSessionEvent(value: unknown): SessionEvent {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new SdkProtocolError(`session.event carried no event envelope: ${JSON.stringify(value)}`)
  }
  // The one variant this module reads into (finalResponse) must carry
  // kind-tagged content blocks; other variants pass through under their
  // envelope shape.
  if (value.type === 'assistant/message') {
    const message = isRecord(value.data) ? value.data.message : undefined
    const content = isRecord(message) ? message.content : undefined
    if (!Array.isArray(content) || !content.every(block => isRecord(block) && typeof block.type === 'string')) {
      throw new SdkProtocolError(`assistant/message event carried malformed content: ${JSON.stringify(value)}`)
    }
  }
  if (value.type === 'turn/end') {
    const reason = isRecord(value.data) ? value.data.reason : undefined
    if (!isRecord(reason) || typeof reason.kind !== 'string' || reason.kind.length === 0) {
      throw new SdkProtocolError(`turn/end event carried malformed reason: ${JSON.stringify(value)}`)
    }
  }
  return value as unknown as SessionEvent
}

/** Whether a raw session event is the durable enqueue receipt for `messageId`. */
function isInboxReceipt(value: unknown, messageId: string): boolean {
  if (!isRecord(value) || value.type !== 'agent/inbox/spliced' || !isRecord(value.data)) return false
  const inserted = value.data.inserted
  return Array.isArray(inserted) && inserted.some(message => isRecord(message) && message.id === messageId)
}

/** Whether one notification is the target session's whole-agent idle edge. */
function isRootIdle(notification: HarnessNotification, sessionId: string): boolean {
  return notification.method === 'session.status'
    && notification.params.sessionId === sessionId
    && notification.params.status === 'idle'
}

/** Parse the optional durable pair before starting the runtime or dispatching. */
function durableIdentityOf(
  sessionId: string,
  options: Pick<RunOptions, 'attemptId' | 'inputSha256'> | undefined,
): SessionAttemptLookupParams | undefined {
  const attemptId = options?.attemptId
  const inputSha256 = options?.inputSha256
  const hasAttempt = attemptId !== undefined
  const hasInput = inputSha256 !== undefined
  if (hasAttempt !== hasInput) {
    throw new TypeError('attemptId and inputSha256 must be supplied together')
  }
  if (attemptId === undefined || inputSha256 === undefined) return undefined
  return { sessionId, attemptId, inputSha256 }
}

/** Validate bounded durable waiting controls before runtime dispatch. */
function durableAttemptTiming(
  options: Pick<RunOptions, 'attemptPollIntervalMs' | 'attemptTimeoutMs'> | undefined,
): { pollIntervalMs: number; timeoutMs: number } {
  const timeoutMs = options?.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS
  const pollIntervalMs = options?.attemptPollIntervalMs ?? DEFAULT_ATTEMPT_POLL_INTERVAL_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('attemptTimeoutMs must be a finite positive number')
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new TypeError('attemptPollIntervalMs must be a finite positive number')
  }
  return { pollIntervalMs, timeoutMs }
}

/** Poll one exact attempt within its single overall deadline. */
async function attemptRequestBeforeDeadline<T>(
  identity: SessionAttemptLookupParams,
  timeoutMs: number,
  deadline: number,
  request: (remainingMs: number) => Promise<T>,
): Promise<T> {
  const remainingMs = deadline - performance.now()
  if (remainingMs <= 0) throw attemptTimeoutError(identity, timeoutMs)
  try {
    return await request(Math.max(1, Math.ceil(remainingMs)))
  } catch (error) {
    if (error instanceof RequestTimeoutError) throw attemptTimeoutError(identity, timeoutMs)
    throw error
  }
}

/** Convert one exact receipt into monotonic client-side attempt progress. */
function validatedAttemptProgress(
  settled: SessionAttemptReceipt | null,
  messageId: string,
  observedTurn: number | undefined,
): { observedTurn: number | undefined; terminal: SessionAttemptTerminalReceipt | undefined } {
  if (settled === null) {
    throw new SdkProtocolError('session/attempt.get lost an attempt accepted by session/attempt.start')
  }
  if (settled.messageId !== messageId) {
    throw new SdkProtocolError('session/attempt.get changed the accepted message identity')
  }
  if (settled.status === 'queued') {
    if (observedTurn !== undefined) {
      throw new SdkProtocolError('session/attempt.get regressed a running attempt to queued')
    }
    return { observedTurn, terminal: undefined }
  }
  if (settled.status === 'running') {
    return { observedTurn: stableAttemptTurn(observedTurn, settled.turn), terminal: undefined }
  }
  if (observedTurn !== undefined && settled.turn !== observedTurn) {
    throw new SdkProtocolError('session/attempt.get changed the owning turn')
  }
  return { observedTurn, terminal: settled }
}

/** Build the typed timeout without mutating or canceling runtime-owned work. */
function attemptTimeoutError(
  identity: SessionAttemptLookupParams,
  timeoutMs: number,
): AttemptTimeoutError {
  return new AttemptTimeoutError(
    `durable attempt "${identity.attemptId}" in session "${identity.sessionId}" did not become terminal within ${timeoutMs}ms; the SDK did not cancel it, so call getAttempt() or cancelAttempt() explicitly`,
  )
}

/** Last validated legacy interval turn reason, when one exists. */
function lastFinishReason(events: SessionEvent[]): SessionAttemptFinishReason | undefined {
  const end = events.findLast(event => event.type === 'turn/end')
  return end?.data.reason
}

/** Keep a claimed turn stable across running receipts before terminal proof. */
function stableAttemptTurn(previous: number | undefined, current: number | undefined): number | undefined {
  if (previous !== undefined && current !== undefined && current !== previous) {
    throw new SdkProtocolError('session/attempt.get changed the owning turn')
  }
  return current ?? previous
}

/**
 * Extract the concatenated text of the last assistant message.
 * @param events - the activity interval's `session.event` payloads in wire order.
 * @returns the final response text, or `''` when no assistant message exists.
 */
export function finalResponse(events: SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    return event.data.message.content
      .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
      .map(block => block.text)
      .join('')
  }
  return ''
}
