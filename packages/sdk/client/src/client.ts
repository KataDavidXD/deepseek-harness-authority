/**
 * Low-level JSON-RPC client for a DeepSeek Harness SDK runtime subprocess.
 * {@link HarnessClient} owns the child process: it spawns the runtime, speaks
 * the `@deepseek-ai/dsh-sdk-protocol` wire over the child's stdio, fans
 * server notifications out to subscriptions, and tears the child down to
 * quiescence through a private EOF → SIGTERM → SIGKILL ladder. The design
 * twin is the Python SDK's `HarnessClient` (`python/sdk`); both drive the
 * same runtime protocol. This client runs OUTSIDE any harness context, so it
 * spawns directly rather than through the `dsh-subprocess` service — the
 * seam's documented exception for SDK-managed transports.
 *
 * @module @deepseek-ai/dsh-sdk-client/client
 */

import { spawn, type ChildProcess } from 'node:child_process'
import {
  JsonRpcLineTransport,
  JsonRpcResponseError,
  RUNTIME_BINDING_PROTOCOL_VERSION,
  RUNTIME_BINDING_SCHEMA_VERSION,
  SESSION_ATTEMPT_ID_MAX_LENGTH,
  type InitializeParams,
  type InitializeResult,
  type RuntimeBindingEnvelope,
  type SessionPromptParams,
} from '@deepseek-ai/dsh-sdk-protocol'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { disposeRuntimeProcess } from './dispose.ts'
import type {
  HarnessClientOptions,
  HarnessNotification,
  NotificationFilter,
  SessionAttemptLookupParams,
  SessionAttemptReceipt,
  SessionAttemptStartParams,
  SessionAttemptStartResult,
  SessionAttemptTerminalReceipt,
} from './types.ts'

/** Retained stderr lines used to diagnose an unexpected runtime death. */
const STDERR_TAIL_LIMIT = 400

/** Grace for the runtime's stdio streams to settle after its exit edge. */
const STREAM_SETTLE_MS = 100

/**
 * The runtime subprocess is gone or unusable: it exited, its stdio closed, or
 * it was never launchable. The message carries the exit code and a stderr
 * tail when available.
 */
export class TransportClosedError extends Error {
  /** @param message - the failure description, including any stderr tail. */
  constructor(message: string) {
    super(message)
    this.name = 'TransportClosedError'
  }
}

/** A request exceeded {@link HarnessClientOptions.requestTimeoutMs}. */
export class RequestTimeoutError extends Error {
  /** @param message - which method timed out. */
  constructor(message: string) {
    super(message)
    this.name = 'RequestTimeoutError'
  }
}

/** A durable attempt did not produce exact terminal proof before its run deadline. */
export class AttemptTimeoutError extends Error {
  /** @param message - attempt identity, deadline, and explicit non-cancellation notice. */
  constructor(message: string) {
    super(message)
    this.name = 'AttemptTimeoutError'
  }
}

/** A restarted runtime or receipt addressed a different persistence store. */
export class RuntimeBindingMismatchError extends Error {
  /**
   * @param expected - binding pinned by the first successful handshake.
   * @param actual - conflicting later handshake or receipt binding.
   */
  constructor(
    readonly expected: RuntimeBindingEnvelope,
    readonly actual: RuntimeBindingEnvelope,
  ) {
    super(`runtime persistence binding changed from ${expected.persistenceInstanceId} to ${actual.persistenceInstanceId}`)
    this.name = 'RuntimeBindingMismatchError'
  }
}

/**
 * The runtime answered outside its documented protocol (for example a
 * `session/prompt` response without `accepted: true`).
 */
export class SdkProtocolError extends Error {
  /** @param message - the protocol violation description. */
  constructor(message: string) {
    super(message)
    this.name = 'SdkProtocolError'
  }
}

interface SubscriptionState {
  readonly queue: HarnessNotification[]
  readonly waiters: { resolve: (item: HarnessNotification) => void; reject: (error: Error) => void }[]
  readonly filter: NotificationFilter | undefined
  failure: Error | undefined
}

/** One client-side notification stream returned by {@link HarnessClient.subscribe}. */
export interface NotificationSubscription extends AsyncIterable<HarnessNotification> {
  /**
   * Await the next matching notification.
   * @returns the notification; after the runtime died, drains what was
   * already delivered and then rejects; after {@link close}, rejects
   * immediately (the queue is dropped).
   */
  next(): Promise<HarnessNotification>

  /**
   * Await one matching notification for at most `timeoutMs`. The waiter is
   * removed on timeout, so later delivery remains queued for another consumer.
   * @param timeoutMs - finite non-negative wait bound.
   * @returns the notification, or `undefined` when the bound elapsed.
   */
  nextWithin(timeoutMs: number): Promise<HarnessNotification | undefined>

  /**
   * Drain one already-delivered notification without waiting.
   * @returns the next queued notification, or `undefined` when none is queued.
   */
  tryNext(): HarnessNotification | undefined

  /** Detach from the client; queued items drop and pending waiters reject. */
  close(): void
}

/** Internal producer side of a public notification subscription. */
class NotificationSubscriptionImpl implements NotificationSubscription {
  constructor(
    private readonly state: SubscriptionState,
    private readonly unsubscribe: () => void,
  ) {}

  /**
   * Await the next matching notification.
   * @returns the notification; after the runtime died, drains what was
   * already delivered and then rejects; after {@link close}, rejects
   * immediately (the queue is dropped).
   */
  next(): Promise<HarnessNotification> {
    const queued = this.state.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.state.failure !== undefined) return Promise.reject(this.state.failure)
    return new Promise((resolve, reject) => {
      this.state.waiters.push({ resolve, reject })
    })
  }

  /**
   * Await one matching notification for a bounded interval without leaving a
   * parked waiter behind when the interval elapses.
   * @param timeoutMs - finite non-negative wait bound.
   * @returns the notification, or `undefined` on timeout.
   */
  nextWithin(timeoutMs: number): Promise<HarnessNotification | undefined> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new TypeError('notification timeoutMs must be a finite non-negative number')
    }
    const queued = this.state.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.state.failure !== undefined) return Promise.reject(this.state.failure)
    if (timeoutMs === 0) return Promise.resolve(undefined)
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (item: HarnessNotification): void => {
          clearTimeout(timer)
          resolve(item)
        },
        reject: (error: Error): void => {
          clearTimeout(timer)
          reject(error)
        },
      }
      this.state.waiters.push(waiter)
      const timer = setTimeout(() => {
        const index = this.state.waiters.indexOf(waiter)
        if (index === -1) return
        this.state.waiters.splice(index, 1)
        resolve(undefined)
      }, timeoutMs)
    })
  }

  /**
   * Drain one already-delivered notification without waiting.
   * @returns the next queued notification, or `undefined` when none is queued.
   */
  tryNext(): HarnessNotification | undefined {
    return this.state.queue.shift()
  }

  /** Detach from the client; queued items drop and pending waiters reject. */
  close(): void {
    this.unsubscribe()
    // The drop is part of this method's contract; a runtime-death fail() keeps
    // the queue so already-delivered notifications remain drainable.
    this.state.queue.length = 0
    this.fail(new TransportClosedError('notification subscription closed'))
  }

  /**
   * Reject pending and future waits (delivery stops; the first failure wins).
   * Already-queued notifications remain drainable via {@link next}/{@link tryNext}.
   * @param error - the terminal failure delivered to waiters.
   */
  fail(error: Error): void {
    this.state.failure ??= error
    for (const waiter of this.state.waiters.splice(0)) waiter.reject(this.state.failure)
  }

  /**
   * Deliver one notification to a waiter or the queue when the filter
   * matches. A throwing filter fails only THIS subscription (detached, the
   * throw becomes its terminal error) — it never disturbs sibling
   * subscriptions or the transport's read loop, mirroring the Python client.
   * @param notification - the wire notification to deliver.
   */
  push(notification: HarnessNotification): void {
    let matches: boolean
    try {
      matches = this.state.filter === undefined || this.state.filter(notification)
    } catch (error) {
      this.unsubscribe()
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (!matches) return
    const waiter = this.state.waiters.shift()
    if (waiter !== undefined) waiter.resolve(notification)
    else this.state.queue.push(notification)
  }

  /**
   * Iterate notifications until the subscription or runtime closes (the
   * terminating rejection propagates).
   * @returns an async iterator over {@link next} results.
   */
  async * [Symbol.asyncIterator](): AsyncIterator<HarnessNotification> {
    for (;;) yield await this.next()
  }
}

/**
 * JSON-RPC client for the DeepSeek Harness SDK runtime over subprocess stdio.
 *
 * The subprocess starts lazily on {@link start} and is owned by this instance
 * until {@link close}, which requests protocol `shutdown` and then walks the
 * shared EOF → SIGTERM → SIGKILL dispose ladder to quiescence. There is no
 * wire-level cancel: a timed-out request stays running server-side until the
 * runtime is closed.
 */
export class HarnessClient {
  private child: ChildProcess | undefined
  private transport: JsonRpcLineTransport | undefined
  private readonly stderrTail: string[] = []
  private readonly subscriptions = new Map<string, NotificationSubscriptionImpl>()
  private readonly sessionParents = new Map<string, string>()
  private subscriptionSerial = 0
  private exitCode: number | null | undefined
  private spawnError: Error | undefined
  private streamsSettled: Promise<void> = Promise.resolve()
  private closeTask: Promise<void> | undefined
  private runtimeBinding: RuntimeBindingEnvelope | undefined

  /** @param options - launch spec, complete child environment, and timeouts. */
  constructor(readonly options: HarnessClientOptions) {}

  /** Whether this low-level client currently owns a live request transport. */
  get isRunning(): boolean {
    return this.closeTask === undefined
      && this.child !== undefined
      && this.child.exitCode === null
      && this.child.signalCode === null
      && this.exitCode === undefined
      && this.spawnError === undefined
  }

  /**
   * Spawn the runtime subprocess and start reading frames. Idempotent while
   * the process is live; rejects reuse after {@link close}.
   */
  start(): void {
    if (this.closeTask !== undefined) throw new TransportClosedError('DeepSeek Harness runtime client is closed')
    if (this.child !== undefined) return
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.once('error', (error) => {
      this.spawnError = error
      // A spawn failure destroys the pipes without an input 'end' edge, so the
      // transport's pending requests must be failed here.
      this.transport?.close()
      this.failSubscriptions(this.closedError('DeepSeek Harness runtime failed to start'))
    })
    // Writes racing the runtime's death EPIPE on stdin; the exit edge below is
    // the real signal, so the stream-level error only needs to be non-fatal.
    // The timing of that race is not deterministically reproducible.
    /* v8 ignore next */
    child.stdin.on('error', () => {})
    let stderrBuffer = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk
      const newline = stderrBuffer.lastIndexOf('\n')
      if (newline >= 0) {
        this.appendStderr(stderrBuffer.slice(0, newline).split('\n'))
        stderrBuffer = stderrBuffer.slice(newline + 1)
      }
    })
    let signalStreamsSettled!: () => void
    this.streamsSettled = new Promise((resolve) => { signalStreamsSettled = resolve })
    const settled = { stderr: false, exited: false }
    const maybeSettle = (): void => {
      if (settled.stderr && settled.exited) signalStreamsSettled()
    }
    child.stderr.once('close', () => {
      if (stderrBuffer.length > 0) this.appendStderr([stderrBuffer])
      settled.stderr = true
      maybeSettle()
    })
    child.once('exit', (code) => {
      this.exitCode = code
      settled.exited = true
      maybeSettle()
      this.failSubscriptions(this.closedError('DeepSeek Harness runtime exited'))
    })
    child.once('close', () => {
      // All stdio has settled: stdout 'end' already drained every tail frame,
      // so closing now cannot drop responses — it only fails requests that
      // will never be answered.
      this.transport?.close()
    })
    const transport = new JsonRpcLineTransport(child.stdout, child.stdin)
    transport.onNotification((method, params) => { this.dispatchNotification({ method, params }) })
    transport.start()
    this.transport = transport
  }

  /**
   * Perform the process-wide handshake.
   * @param params - workspace cwd plus the provider/model route.
   * @returns the runtime's wire identity.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    const result = await this.request('initialize', { ...params })
    if (!isRecord(result) || !isRecord(result.serverInfo)
      || typeof result.serverInfo.name !== 'string' || typeof result.serverInfo.version !== 'string') {
      throw new SdkProtocolError(`initialize returned no server identity: ${JSON.stringify(result)}`)
    }
    const runtimeBinding = result.runtimeBinding === undefined
      ? undefined
      : validatedRuntimeBinding(result.runtimeBinding, 'initialize')
    if (runtimeBinding !== undefined) this.pinRuntimeBinding(runtimeBinding)
    return {
      serverInfo: { name: result.serverInfo.name, version: result.serverInfo.version },
      ...(runtimeBinding === undefined ? {} : { runtimeBinding }),
    }
  }

  /**
   * Queue one prompt and return its durable inbox identity.
   * @param sessionId - target session; an unknown id creates it.
   * @param contentBlocks - the user message, sent verbatim.
   * @returns the queued message id.
   */
  async prompt(sessionId: string, contentBlocks: ContentBlock[]): Promise<string> {
    const params: SessionPromptParams = { sessionId, contentBlocks }
    const result = await this.request('session/prompt', { ...params })
    if (!isRecord(result) || typeof result.messageId !== 'string') {
      throw new SdkProtocolError(`session/prompt returned no message id: ${JSON.stringify(result)}`)
    }
    return result.messageId
  }

  /**
   * Idempotently admit one durably identified prompt.
   * @param params - exact session/attempt/input identity plus prompt blocks.
   * @param timeoutMs - optional request bound; omitted uses the client default.
   * @returns runtime-owned attempt state and whether admission deduplicated.
   */
  async startAttempt(params: SessionAttemptStartParams, timeoutMs?: number): Promise<SessionAttemptStartResult> {
    validateAttemptLookup(params)
    const result = await this.request('session/attempt.start', { ...params }, timeoutMs)
    if (!isRecord(result) || typeof result.deduplicated !== 'boolean') {
      throw new SdkProtocolError(`session/attempt.start returned no deduplication proof: ${JSON.stringify(result)}`)
    }
    const attempt = validatedAttemptReceipt(result.attempt, params, 'session/attempt.start')
    this.pinRuntimeBinding(attempt.runtimeBinding)
    return {
      attempt,
      deduplicated: result.deduplicated,
    }
  }

  /**
   * Read durable state for one exact attempt without creating or resuming it.
   * @param params - exact lookup identity.
   * @param timeoutMs - optional request bound; omitted uses the client default.
   * @returns the runtime-owned receipt, or `null` when no such attempt exists.
   */
  async getAttempt(params: SessionAttemptLookupParams, timeoutMs?: number): Promise<SessionAttemptReceipt | null> {
    validateAttemptLookup(params)
    const result = await this.request('session/attempt.get', { ...params }, timeoutMs)
    if (!isRecord(result) || !Object.hasOwn(result, 'attempt')) {
      throw new SdkProtocolError(`session/attempt.get returned no attempt field: ${JSON.stringify(result)}`)
    }
    if (result.attempt === null) return null
    const attempt = validatedAttemptReceipt(result.attempt, params, 'session/attempt.get')
    this.pinRuntimeBinding(attempt.runtimeBinding)
    return attempt
  }

  /**
   * Cancel one exact attempt and require terminal runtime-owned proof.
   * @param params - exact lookup identity.
   * @returns the durable cancellation receipt.
   */
  async cancelAttempt(params: SessionAttemptLookupParams): Promise<SessionAttemptTerminalReceipt> {
    validateAttemptLookup(params)
    const result = await this.request('session/attempt.cancel', { ...params })
    if (!isRecord(result)) {
      throw new SdkProtocolError(`session/attempt.cancel returned no result object: ${JSON.stringify(result)}`)
    }
    const attempt = validatedAttemptReceipt(result.attempt, params, 'session/attempt.cancel')
    this.pinRuntimeBinding(attempt.runtimeBinding)
    if (attempt.status !== 'terminal') {
      throw new SdkProtocolError(`session/attempt.cancel returned nonterminal status: ${attempt.status}`)
    }
    return attempt
  }

  /**
   * Send one JSON-RPC request and await its result.
   * @param method - the wire method name.
   * @param params - the params object; omitted params send `{}`.
   * @param timeoutMs - per-call override of {@link HarnessClientOptions.requestTimeoutMs}.
   * @returns the raw result; rejects with {@link JsonRpcResponseError} on a
   * protocol error response, {@link RequestTimeoutError} on timeout, and
   * {@link TransportClosedError} when the runtime is gone.
   */
  async request(method: string, params?: object, timeoutMs?: number): Promise<unknown> {
    this.start()
    // A dead runtime cannot answer; fail with process context instead of
    // writing into a destroyed pipe and hanging until the timeout.
    if (this.exitCode !== undefined || this.spawnError !== undefined) {
      await this.settleStreams()
      throw this.closedError('DeepSeek Harness runtime is not running')
    }
    const transport = this.transport
    /* v8 ignore next -- start() either sets the transport or throws */
    if (transport === undefined) throw new TransportClosedError('DeepSeek Harness runtime is not running')
    const timeout = timeoutMs ?? this.options.requestTimeoutMs
    try {
      if (timeout === undefined) return await transport.request(method, params ?? {})
      // The abort signal makes the timeout an abandonment: the transport drops
      // its pending entry, so repeated bounded requests against a hung method
      // retain no per-call state (the server-side work still runs to close).
      const abandon = new AbortController()
      const timer = setTimeout(() => {
        abandon.abort(new RequestTimeoutError(`${method} timed out after ${timeout}ms waiting for the DeepSeek Harness runtime`))
      }, timeout)
      try {
        return await transport.request(method, params ?? {}, abandon.signal)
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      if (error instanceof JsonRpcResponseError || error instanceof RequestTimeoutError) throw error
      // Transport-level failures gain process context: exit code + stderr tail.
      await this.settleStreams()
      throw this.closedError(errorMessage(error))
    }
  }

  /**
   * Subscribe to server notifications.
   * @param filter - optional predicate; omitted means every notification.
   * @returns the subscription handle; close it to stop delivery. After
   * {@link close} or runtime death the handle is born failed — there is no
   * producer left, so `next()` rejects instead of waiting forever.
   */
  subscribe(filter?: NotificationFilter): NotificationSubscription {
    const id = String(this.subscriptionSerial++)
    const state: SubscriptionState = { queue: [], waiters: [], filter, failure: undefined }
    const subscription = new NotificationSubscriptionImpl(state, () => { this.subscriptions.delete(id) })
    if (this.closeTask !== undefined || this.exitCode !== undefined || this.spawnError !== undefined) {
      subscription.fail(this.closedError('DeepSeek Harness runtime closed'))
      return subscription
    }
    this.subscriptions.set(id, subscription)
    return subscription
  }

  /**
   * Subscribe to one session and the descendants discovered from
   * `subagent.started` lineage edges (the runtime notifies for every session
   * in its context; scoping is client-side, mirroring the Python SDK).
   * @param sessionId - the root session id.
   * @returns the filtered subscription handle.
   */
  subscribeSessionTree(sessionId: string): NotificationSubscription {
    return this.subscribe((notification) => {
      const params = notification.params
      if (notification.method === 'subagent.started' || notification.method === 'subagent.finished') {
        const parentId = params.parentSessionId
        if (typeof parentId === 'string' && this.isDescendantOf(parentId, sessionId)) return true
        return params.childSessionId === sessionId
      }
      const relatedId = params.sessionId
      return typeof relatedId === 'string' && this.isDescendantOf(relatedId, sessionId)
    })
  }

  /**
   * Shut the runtime down and reap it: a best-effort protocol `shutdown`
   * bounded by `shutdownTimeoutMs`, then the shared stdin-EOF → SIGTERM →
   * SIGKILL ladder until the process actually exited. Idempotent.
   * @returns settlement of the complete teardown.
   */
  close(): Promise<void> {
    this.closeTask ??= this.performClose()
    return this.closeTask
  }

  private async performClose(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    try {
      await this.request('shutdown', undefined, this.options.shutdownTimeoutMs ?? 1_000)
    } catch (error) {
      // Diagnostic only: the dispose ladder below is the authoritative teardown
      // for a runtime that cannot answer shutdown anymore.
      this.appendStderr([`shutdown request failed: ${errorMessage(error)}`])
    }
    await disposeRuntimeProcess(child, {
      disposeEofGraceMs: this.options.disposeEofGraceMs ?? 6_000,
      disposeGraceMs: this.options.disposeGraceMs ?? 3_000,
    })
    this.transport?.close()
    this.failSubscriptions(this.closedError('DeepSeek Harness runtime closed'))
  }

  private dispatchNotification(notification: HarnessNotification): void {
    this.recordSessionRelationship(notification)
    for (const subscription of this.subscriptions.values()) subscription.push(notification)
  }

  private recordSessionRelationship(notification: HarnessNotification): void {
    if (notification.method !== 'subagent.started') return
    const parentId = notification.params.parentSessionId
    const childId = notification.params.childSessionId
    if (typeof parentId === 'string' && parentId !== '' && typeof childId === 'string' && childId !== '' && parentId !== childId) {
      this.sessionParents.set(childId, parentId)
    }
  }

  private isDescendantOf(sessionId: string, rootSessionId: string): boolean {
    const visited = new Set<string>()
    let current = sessionId
    while (!visited.has(current)) {
      if (current === rootSessionId) return true
      visited.add(current)
      const parent = this.sessionParents.get(current)
      if (parent === undefined) return false
      current = parent
    }
    // The parent map only ever extends chains upward, so a cycle cannot form.
    /* v8 ignore next */
    return false
  }

  private failSubscriptions(error: Error): void {
    for (const subscription of this.subscriptions.values()) subscription.fail(error)
  }

  private appendStderr(lines: string[]): void {
    const kept = lines.filter(line => line.length > 0)
    this.stderrTail.push(...kept)
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LIMIT)
    }
  }

  private settleStreams(): Promise<void> {
    return Promise.race([
      this.streamsSettled,
      new Promise<void>((resolve) => { setTimeout(resolve, STREAM_SETTLE_MS) }),
    ])
  }

  private closedError(reason: string): TransportClosedError {
    const parts = [reason]
    if (this.spawnError !== undefined) parts.push(`spawn error: ${this.spawnError.message}`)
    if (this.exitCode !== undefined) parts.push(`exit code: ${String(this.exitCode)}`)
    if (this.stderrTail.length > 0) parts.push(`stderr tail:\n${this.stderrTail.join('\n')}`)
    return new TransportClosedError(parts.join('\n'))
  }

  /** Pin one process's handshake/receipt stream to a single store identity. */
  private pinRuntimeBinding(binding: RuntimeBindingEnvelope): void {
    if (this.runtimeBinding === undefined) {
      this.runtimeBinding = binding
      return
    }
    if (!sameRuntimeBinding(this.runtimeBinding, binding)) {
      throw new RuntimeBindingMismatchError(this.runtimeBinding, binding)
    }
  }
}

/**
 * Whether `value` is a plain JSON object (the wire-boundary shape probe).
 * @param value - the wire value to probe.
 * @returns `true` iff `value` is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reject incomplete or non-canonical caller identity before any wire dispatch. */
function validateAttemptLookup(params: SessionAttemptLookupParams): void {
  if (typeof params.sessionId !== 'string' || params.sessionId.length === 0) {
    throw new TypeError('sessionId must be a non-empty string')
  }
  if (typeof params.attemptId !== 'string'
    || params.attemptId.length === 0
    || params.attemptId.length > SESSION_ATTEMPT_ID_MAX_LENGTH
    || !/^[A-Za-z0-9][A-Za-z0-9._:~-]*$/.test(params.attemptId)) {
    throw new TypeError(`attemptId must be 1-${SESSION_ATTEMPT_ID_MAX_LENGTH} safe ASCII characters`)
  }
  if (!/^[0-9a-f]{64}$/.test(params.inputSha256)) {
    throw new TypeError('inputSha256 must be a lowercase SHA-256 digest')
  }
}

/** Validate a runtime receipt and bind every echoed ownership field to the request. */
function validatedAttemptReceipt(
  value: unknown,
  expected: SessionAttemptLookupParams,
  method: string,
): SessionAttemptReceipt {
  if (!isRecord(value)) {
    throw new SdkProtocolError(`${method} returned no attempt receipt: ${JSON.stringify(value)}`)
  }
  const identityMatches = value.sessionId === expected.sessionId
    && value.attemptId === expected.attemptId
    && value.inputSha256 === expected.inputSha256
  if (!identityMatches) {
    throw new SdkProtocolError(`${method} returned a foreign attempt identity: ${JSON.stringify(value)}`)
  }
  if (typeof value.messageId !== 'string' || value.messageId.length === 0) {
    throw new SdkProtocolError(`${method} returned no message identity: ${JSON.stringify(value)}`)
  }
  const turn = validatedOptionalTurn(value.turn, method)
  const runtimeBinding = validatedRuntimeBinding(value.runtimeBinding, method)
  const identity = {
    sessionId: expected.sessionId,
    attemptId: expected.attemptId,
    inputSha256: expected.inputSha256,
    messageId: value.messageId,
    runtimeBinding,
  }
  if (value.status === 'queued' || value.status === 'running') {
    return { ...identity, status: value.status, ...(turn === undefined ? {} : { turn }) }
  }
  if (value.status !== 'terminal') {
    throw new SdkProtocolError(`${method} returned an unknown attempt status: ${JSON.stringify(value.status)}`)
  }
  if (!Number.isSafeInteger(value.terminalEventSeq) || (value.terminalEventSeq as number) < 0) {
    throw new SdkProtocolError(`${method} returned an invalid terminalEventSeq: ${JSON.stringify(value)}`)
  }
  if (!isRecord(value.finishReason)
    || typeof value.finishReason.kind !== 'string'
    || value.finishReason.kind.length === 0) {
    throw new SdkProtocolError(`${method} returned an invalid finishReason: ${JSON.stringify(value)}`)
  }
  if (typeof value.finalResponse !== 'string') {
    throw new SdkProtocolError(`${method} returned an invalid finalResponse: ${JSON.stringify(value)}`)
  }
  return {
    ...identity,
    status: 'terminal',
    ...(turn === undefined ? {} : { turn }),
    terminalEventSeq: value.terminalEventSeq as number,
    finishReason: value.finishReason as SessionAttemptTerminalReceipt['finishReason'],
    finalResponse: value.finalResponse,
  }
}

/** Validate exact versioned path-free runtime binding fields. */
export function validatedRuntimeBinding(value: unknown, method: string): RuntimeBindingEnvelope {
  const exactKeys = isRecord(value)
    && Object.keys(value).sort().join(',') === 'persistenceInstanceId,protocolVersion,rootConfigSha256,schemaVersion'
  if (!isRecord(value)
    || !exactKeys
    || value.protocolVersion !== RUNTIME_BINDING_PROTOCOL_VERSION
    || value.schemaVersion !== RUNTIME_BINDING_SCHEMA_VERSION
    || typeof value.persistenceInstanceId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.persistenceInstanceId)
    || typeof value.rootConfigSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.rootConfigSha256)) {
    throw new SdkProtocolError(`${method} returned an invalid runtime binding: ${JSON.stringify(value)}`)
  }
  return Object.freeze({
    protocolVersion: RUNTIME_BINDING_PROTOCOL_VERSION,
    schemaVersion: RUNTIME_BINDING_SCHEMA_VERSION,
    persistenceInstanceId: value.persistenceInstanceId,
    rootConfigSha256: value.rootConfigSha256,
  })
}

/** Compare every versioned runtime-binding field. */
export function sameRuntimeBinding(left: RuntimeBindingEnvelope, right: RuntimeBindingEnvelope): boolean {
  return (['protocolVersion', 'schemaVersion', 'persistenceInstanceId', 'rootConfigSha256'] as const)
    .every(key => left[key] === right[key])
}

/** Validate the optional owning turn without truthy/coercive wire parsing. */
function validatedOptionalTurn(value: unknown, method: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SdkProtocolError(`${method} returned an invalid attempt turn: ${JSON.stringify(value)}`)
  }
  return value as number
}

/** The message of a thrown value (the transport only throws `Error`s; `String` covers the rest). */
function errorMessage(error: unknown): string {
  /* v8 ignore next -- the transport and dispose ladder reject only with Errors */
  return error instanceof Error ? error.message : String(error)
}
