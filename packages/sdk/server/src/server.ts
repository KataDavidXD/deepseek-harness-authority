/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/server
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { MessageId, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type SessionPersistence from '@deepseek-ai/dsh-session-persistence'
import type { SessionOwnerToken, SessionOwnership } from '@deepseek-ai/dsh-session-persistence'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  RuntimeBindingEnvelope,
  SessionAttemptCancelResult,
  SessionAttemptGetResult,
  SessionAttemptLookupParams,
  SessionAttemptStartParams,
  SessionAttemptStartResult,
  SessionAttemptTerminalReceipt,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@deepseek-ai/dsh-sdk-protocol'
import {
  RUNTIME_BINDING_PROTOCOL_VERSION,
  RUNTIME_BINDING_SCHEMA_VERSION,
} from '@deepseek-ai/dsh-sdk-protocol'
import {
  assertAttemptContent,
  createAttemptMessage,
  projectAttempt,
  validateAttemptLookupParams,
  validateAttemptStartParams,
  type AttemptProjection,
} from './attempt.ts'

interface SessionRecord {
  handle: AgentHandle
  ownership?: SessionOwnership
}

/** Whether a claimed message carries any part of the SDK-attempt source extension. */
function isSdkAttemptMessage(message: UserMessage): boolean {
  return message.source.kind === 'user'
    && ('attemptId' in message.source || 'inputSha256' in message.source)
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
  /** Path-free digest of the exact root Cordis bytes mounted by Loader. */
  rootConfigSha256?: string
}

interface CanonicalInitialization {
  readonly cwd: string
  readonly provider: string
  readonly model: string
  readonly maxTokens: number | undefined
}

/** A live SDK process was asked to change its pinned initialization contract. */
export class RuntimeInitializationConflictError extends Error {
  constructor(readonly changedFields: readonly (keyof CanonicalInitialization)[]) {
    super(`SDK runtime initialize conflicts with its pinned fields: ${changedFields.join(', ')}`)
    this.name = 'RuntimeInitializationConflictError'
  }
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

/** Validate an untrusted backend identity before it reaches the JSON-RPC wire. */
function canonicalPersistenceInstanceId(value: unknown): string {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new TypeError('persistence instance identity must be a canonical lowercase UUIDv4')
  }
  return value
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly sessionOperations = new Map<string, Promise<void>>()
  private readonly activeOperations = new Set<Promise<unknown>>()
  private readonly managedAgents = new Map<Agent, SessionOwnership | undefined>()
  private readonly disposers: (() => void)[] = []
  private readonly ownerToken = randomUUID() as SessionOwnerToken
  private runtimeBinding: RuntimeBindingEnvelope | undefined
  private initialization: CanonicalInitialization | undefined
  private initializationQueue: Promise<void> = Promise.resolve()
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    const serverOptions = this.options
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      if (!this.managedAgents.has(agent) || !messages.some(isSdkAttemptMessage)) return next()
      const ownership = this.managedAgents.get(agent)
      if (ownership === undefined) {
        throw new Error('durable SDK attempt claim requires session ownership')
      }
      ownership.assertActive()
      const sessions = this.ctx.get('sessions')
      if (sessions === undefined || !await sessions.flush(agent.session)) {
        throw new Error('durable SDK attempt claim flush had no persistence participant')
      }
      ownership.assertActive()
      return next()
    }, { prepend: true }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: info.lastAssistantMessage }),
      }
      transport.notify('subagent.finished', payload)
    }))
  }

  /**
   * Configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    const candidate = this.canonicalInitialization(params)
    const initialized = this.initializationQueue.then(
      () => this.initializeSerialized(candidate),
      () => this.initializeSerialized(candidate),
    )
    this.initializationQueue = initialized.then(() => {}, () => {})
    return initialized
  }

  /** Validate and canonicalize one handshake without mutating the live runtime. */
  private canonicalInitialization(params: InitializeParams): CanonicalInitialization {
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    if (typeof params.cwd !== 'string' || params.cwd.length === 0) {
      throw new TypeError('initialize cwd must be a non-empty string')
    }
    if (typeof params.provider !== 'string' || params.provider.length === 0) {
      throw new TypeError('initialize provider must be a non-empty string')
    }
    if (typeof params.model !== 'string' || params.model.length === 0) {
      throw new TypeError('initialize model must be a non-empty string')
    }
    return Object.freeze({
      cwd: resolve(params.cwd),
      provider: params.provider,
      model: params.model,
      maxTokens: params.maxTokens,
    })
  }

  /** Serialize the first successful pin and exact-idempotent later handshakes. */
  private async initializeSerialized(candidate: CanonicalInitialization): Promise<InitializeResult> {
    if (this.initialization !== undefined) {
      const changedFields = (['cwd', 'provider', 'model', 'maxTokens'] as const)
        .filter(field => this.initialization?.[field] !== candidate[field])
      if (changedFields.length > 0) throw new RuntimeInitializationConflictError(changedFields)
      return this.initializeResult()
    }

    // Always run the conflict check above before any field mutation or plugin
    // mount. Only a fully successful first handshake becomes process-wide.
    const persistence = this.ctx.get('sessionPersistence')
    const rootConfigSha256 = this.options.rootConfigSha256
    if (rootConfigSha256 !== undefined && !/^[0-9a-f]{64}$/.test(rootConfigSha256)) {
      throw new TypeError('rootConfigSha256 must be a lowercase SHA-256 digest')
    }
    const persistenceInstanceId = persistence?.supportsInstanceIdentity === true
      && rootConfigSha256 !== undefined
      ? canonicalPersistenceInstanceId(await persistence.getInstanceId())
      : undefined
    if (!this.hasAdapterFor(candidate.provider)) {
      if (candidate.provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${candidate.provider}"`)
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek, {})
    }
    const runtimeBinding = persistenceInstanceId !== undefined && rootConfigSha256 !== undefined
      ? Object.freeze({
        protocolVersion: RUNTIME_BINDING_PROTOCOL_VERSION,
        schemaVersion: RUNTIME_BINDING_SCHEMA_VERSION,
        persistenceInstanceId,
        rootConfigSha256,
      } as const)
      : undefined
    this.cwd = candidate.cwd
    this.provider = candidate.provider
    this.model = candidate.model
    this.maxTokens = candidate.maxTokens
    this.runtimeBinding = runtimeBinding
    this.initialization = candidate
    return this.initializeResult()
  }

  /** Return the pinned handshake without exposing mutable server state. */
  private initializeResult(): InitializeResult {
    return {
      serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' },
      ...(this.runtimeBinding === undefined ? {} : { runtimeBinding: this.runtimeBinding }),
    }
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    return this.runSessionOperation(params.sessionId, async () => {
      const rec = await this.getOrCreateSession(params.sessionId, false, true)
      this.assertLiveRecord(params.sessionId, rec)
      const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } })
      rec.handle.agent.followup(message)
      return { messageId: message.id }
    })
  }

  /**
   * Durably admit or recover one idempotent SDK attempt.
   * @param untrusted - request fields, revalidated even for direct callers.
   * @returns current receipt after a persistence flush barrier.
   */
  async startAttempt(untrusted: SessionAttemptStartParams): Promise<SessionAttemptStartResult> {
    const params = validateAttemptStartParams(untrusted)
    return this.runSessionOperation(params.sessionId, async () => {
      const live = this.sessions.get(params.sessionId)
      const configuredPersistence = this.ctx.get('sessionPersistence')
      if (live !== undefined && live.ownership === undefined
        && configuredPersistence?.supportsOwnership === true) {
        throw new Error(`live SDK session "${params.sessionId}" was created without durable ownership`)
      }
      const persistence = this.requireOwnedPersistence()
      let existing = await this.lookupAttempt(persistence, params)
      if (existing !== null) {
        assertAttemptContent(existing, params)
        let rec = this.sessions.get(params.sessionId)
        if (rec === undefined && existing.receipt.status !== 'terminal') {
          rec = await this.getOrCreateSession(params.sessionId, true, true, true)
          existing = this.requireLiveAttempt(rec, params)
          assertAttemptContent(existing, params)
        }
        if (rec !== undefined) {
          const captured = existing.receipt
          await this.flushDurably(rec)
          if (captured.status === 'queued') {
            this.releaseDurablePending(rec, MessageId(captured.messageId))
            this.wakeDurablePending(rec)
          }
          return { attempt: captured, deduplicated: true }
        }
        return { attempt: existing.receipt, deduplicated: true }
      }

      const rec = await this.getOrCreateSession(params.sessionId, true, true, true)
      this.assertLiveRecord(params.sessionId, rec)
      existing = projectAttempt(rec.handle.agent.session.events, params, this.requireRuntimeBinding())
      if (existing !== null) {
        assertAttemptContent(existing, params)
        await this.flushDurably(rec)
        if (existing.receipt.status === 'queued') this.wakeDurablePending(rec)
        return { attempt: existing.receipt, deduplicated: true }
      }

      const message = createAttemptMessage(params)
      this.sendDurablePending(rec, message)
      const admitted = this.requireLiveAttempt(rec, params)
      await this.flushDurably(rec)
      this.releaseDurablePending(rec, message.id)
      this.wakeDurablePending(rec)
      return { attempt: admitted.receipt, deduplicated: false }
    })
  }

  /**
   * Reconcile one exact attempt from its live session or persisted log.
   * @param untrusted - lookup fields, revalidated even for direct callers.
   * @returns current receipt, or `null` for an absent session or attempt.
   */
  async getAttempt(untrusted: SessionAttemptLookupParams): Promise<SessionAttemptGetResult> {
    const params = validateAttemptLookupParams(untrusted)
    return this.runSessionOperation(params.sessionId, async () => {
      const persistence = this.requireIdentityPersistence()
      const projection = await this.lookupAttempt(persistence, params)
      if (projection === null) return { attempt: null }
      const rec = this.sessions.get(params.sessionId)
      if (rec === undefined) return { attempt: projection.receipt }
      await this.flushDurably(rec)
      return { attempt: projection.receipt }
    })
  }

  /**
   * Cancel one exact queued item or its active turn and persist the outcome.
   * @param untrusted - lookup fields, revalidated even for direct callers.
   * @returns terminal receipt after agent quiescence and a flush barrier.
   */
  async cancelAttempt(untrusted: SessionAttemptLookupParams): Promise<SessionAttemptCancelResult> {
    const params = validateAttemptLookupParams(untrusted)
    return this.runSessionOperation(params.sessionId, async () => {
      const persistence = this.requireOwnedPersistence()
      let projection = await this.lookupAttempt(persistence, params)
      if (projection === null) throw new Error(`durable attempt "${params.attemptId}" was not found`)
      if (projection.receipt.status === 'terminal') {
        const live = this.sessions.get(params.sessionId)
        if (live !== undefined) await this.flushDurably(live)
        return { attempt: projection.receipt }
      }

      const rec = await this.getOrCreateSession(params.sessionId, false, true, true)
      this.assertLiveRecord(params.sessionId, rec)
      projection = this.requireLiveAttempt(rec, params)
      if (projection.receipt.status === 'terminal') {
        await this.flushDurably(rec)
        return { attempt: this.asTerminal(projection) }
      }

      if (projection.receipt.status === 'queued') {
        const removed = rec.handle.agent.inbox.remove(MessageId(projection.receipt.messageId))
        if (removed) {
          const canceled = this.asTerminal(this.requireLiveAttempt(rec, params))
          await this.flushDurably(rec)
          return { attempt: canceled }
        }
        projection = this.requireLiveAttempt(rec, params)
      }

      if (projection.receipt.status === 'running') {
        rec.handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
        await rec.handle.agent.whenIdle()
        const terminal = this.asTerminal(this.requireLiveAttempt(rec, params))
        await this.flushDurably(rec)
        this.wakeDurablePending(rec)
        return { attempt: terminal }
      }
      const terminal = this.asTerminal(this.requireLiveAttempt(rec, params))
      await this.flushDurably(rec)
      return { attempt: terminal }
    })
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    await Promise.allSettled([...this.activeOperations])
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => this.disposeRecord(rec)),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'session/attempt.start':
        return this.startAttempt(validateAttemptStartParams(params))
      case 'session/attempt.get':
        return this.getAttempt(validateAttemptLookupParams(params))
      case 'session/attempt.cancel':
        return this.cancelAttempt(validateAttemptLookupParams(params))
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
    }
  }

  /** Serialize one admitted operation behind earlier work for the same session. */
  private runSessionOperation<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new Error('SDK server is shutting down'))
    const previous = this.sessionOperations.get(sessionId) ?? Promise.resolve()
    const operation = previous.then(task)
    const tail = operation.then(() => undefined, () => undefined)
    this.sessionOperations.set(sessionId, tail)
    this.activeOperations.add(operation)
    const forget = (): void => {
      this.activeOperations.delete(operation)
      if (this.sessionOperations.get(sessionId) === tail) this.sessionOperations.delete(sessionId)
    }
    void operation.then(forget, forget)
    return operation
  }

  /** Require the persistence capability before any durable attempt action. */
  private requirePersistence(): SessionPersistence {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new Error('durable SDK attempts require session persistence')
    }
    return persistence
  }

  /** Require a backend whose identity can bind every durable receipt. */
  private requireIdentityPersistence(): SessionPersistence {
    const persistence = this.requirePersistence()
    if (!persistence.supportsInstanceIdentity) {
      throw new Error('durable SDK attempts require persistence instance identity support')
    }
    this.requireRuntimeBinding()
    return persistence
  }

  /** Require the initialize-time binding before durable attempt traffic. */
  private requireRuntimeBinding(): RuntimeBindingEnvelope {
    if (this.runtimeBinding === undefined) {
      throw new Error('durable SDK attempts require an initialized runtime binding')
    }
    return this.runtimeBinding
  }

  /** Require persistence that can exclusively own a durable attempt writer. */
  private requireOwnedPersistence(): SessionPersistence {
    const persistence = this.requirePersistence()
    if (!persistence.supportsOwnership) {
      throw new Error('durable SDK attempts require session ownership support')
    }
    if (!persistence.supportsInstanceIdentity) {
      throw new Error('durable SDK attempts require persistence instance identity support')
    }
    this.requireRuntimeBinding()
    return persistence
  }

  /** Acquire the backend's crash-released exclusive writer ownership. */
  private acquireOwnership(persistence: SessionPersistence, sessionId: string): Promise<SessionOwnership> {
    if (!persistence.supportsOwnership) {
      return Promise.reject(new Error('durable SDK attempts require session ownership support'))
    }
    return persistence.acquireOwnership(SessionId(sessionId), this.ownerToken)
  }

  /** Require a live server record to still own its durable session writer. */
  private requireOwnership(rec: SessionRecord): SessionOwnership {
    if (rec.ownership === undefined) {
      throw new Error('durable SDK attempts require session ownership')
    }
    rec.ownership.assertActive()
    return rec.ownership
  }

  /** Reject a retained session handle that no longer belongs to the live registry. */
  private assertLiveRecord(sessionId: string, rec: SessionRecord): void {
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${sessionId}`)
    }
  }

  /** Require and invoke the wake-only capability used by durable redrive. */
  private wakeDurablePending(rec: SessionRecord): boolean {
    this.requireOwnership(rec)
    if (typeof rec.handle.agent.wakePending !== 'function') {
      throw new Error('durable SDK attempts require an agent with wakePending() support')
    }
    return rec.handle.agent.wakePending()
  }

  /** Insert one SDK attempt behind the agent's process-local delivery gate. */
  private sendDurablePending(rec: SessionRecord, message: ReturnType<typeof createAttemptMessage>): void {
    this.requireOwnership(rec)
    if (typeof rec.handle.agent.sendGated !== 'function'
      || typeof rec.handle.agent.releaseGated !== 'function') {
      throw new Error('durable SDK attempts require an agent with gated delivery support')
    }
    rec.handle.agent.sendGated(message, 'next-turn')
  }

  /** Release one flushed SDK attempt without inserting or waking another item. */
  private releaseDurablePending(rec: SessionRecord, messageId: MessageId): boolean {
    this.requireOwnership(rec)
    if (typeof rec.handle.agent.releaseGated !== 'function') {
      throw new Error('durable SDK attempts require an agent with gated delivery support')
    }
    return rec.handle.agent.releaseGated(messageId)
  }

  /** Read an exact attempt from the server-owned live log or a cold inspection. */
  private async lookupAttempt(
    persistence: SessionPersistence,
    params: SessionAttemptLookupParams,
  ): Promise<AttemptProjection | null> {
    const rec = this.sessions.get(params.sessionId)
    if (rec !== undefined) {
      this.assertLiveRecord(params.sessionId, rec)
      return projectAttempt(rec.handle.agent.session.events, params, this.requireRuntimeBinding())
    }
    const exists = (await persistence.listSnapshots())
      .some(snapshot => snapshot.header.id === params.sessionId)
    if (!exists) return null
    const inspection: { events: readonly SessionEvent[] } = await persistence.readFrom(SessionId(params.sessionId), 0)
    return projectAttempt(inspection.events, params, this.requireRuntimeBinding())
  }

  /** Cross the session store's explicit persistence barrier and require a listener. */
  private async flushDurably(rec: SessionRecord): Promise<void> {
    this.assertLiveRecord(String(rec.handle.agent.id), rec)
    rec.ownership?.assertActive()
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) throw new Error('durable SDK attempts require a session store')
    if (!await sessions.flush(rec.handle.agent.session)) {
      throw new Error('durable SDK attempt flush had no persistence participant')
    }
    rec.ownership?.assertActive()
  }

  /** Re-project an exact attempt from a validated server-owned live record. */
  private requireLiveAttempt(
    rec: SessionRecord,
    params: SessionAttemptLookupParams,
  ): AttemptProjection {
    this.assertLiveRecord(params.sessionId, rec)
    const projection = projectAttempt(rec.handle.agent.session.events, params, this.requireRuntimeBinding())
    if (projection === null) throw new Error(`durable attempt "${params.attemptId}" disappeared from its live session`)
    return projection
  }

  /** Narrow an operation result to the required terminal cancellation receipt. */
  private asTerminal(projection: AttemptProjection): SessionAttemptTerminalReceipt {
    if (projection.receipt.status !== 'terminal') {
      throw new Error(`durable attempt "${projection.receipt.attemptId}" did not reach a terminal state`)
    }
    return projection.receipt
  }

  private async getOrCreateSession(
    sessionId: string,
    wakePending = false,
    admitted = false,
    durable = false,
  ): Promise<SessionRecord> {
    if (this.shuttingDown && !admitted) throw new Error('SDK server is shutting down')
    const existing = this.sessions.get(sessionId)
    if (existing) {
      const persistence = this.ctx.get('sessionPersistence')
      if (durable && (persistence === undefined || !persistence.supportsOwnership)) {
        throw new Error('durable SDK attempts require session ownership support')
      }
      if (durable && existing.ownership === undefined) {
        throw new Error(`live SDK session "${sessionId}" was created without durable ownership`)
      }
      if (durable) this.requireOwnership(existing)
      if (wakePending) this.wakeDurablePending(existing)
      return existing
    }
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    const creation = this.createSession(sessionId, wakePending, durable)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private async createSession(
    sessionId: string,
    wakePending: boolean,
    durable: boolean,
  ): Promise<SessionRecord> {
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@deepseek-ai/dsh-agent-presets README, "Composing a child agent").
    const persistence = this.ctx.get('sessionPersistence')
    if (durable && (persistence === undefined || !persistence.supportsOwnership)) {
      throw new Error(persistence === undefined
        ? 'durable SDK attempts require session persistence'
        : 'durable SDK attempts require session ownership support')
    }
    const ownership = persistence?.supportsOwnership !== true
      ? undefined
      : await this.acquireOwnership(persistence, sessionId)
    try {
      const persisted = persistence === undefined
        ? false
        : (await persistence.listSnapshots()).some(snapshot => snapshot.header.id === sessionId)
      const agentOptions = {
        provider: this.provider,
        model: this.model,
        ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
      }
      const handle = persisted
        ? await this.ctx.agents.resume({
          resumeSessionId: SessionId(sessionId),
          agentOptions,
          wakePending,
          setup: (agentCtx) => { this.trackManagedAgent(agentCtx, ownership) },
        })
        : await this.ctx.agents.create({
          sessionId: SessionId(sessionId),
          meta: { cwd: this.cwd },
          agentOptions,
          setup: (agentCtx) => { this.trackManagedAgent(agentCtx, ownership) },
        })
      const rec: SessionRecord = { handle, ...ownership === undefined ? {} : { ownership } }
      this.sessions.set(sessionId, rec)
      return rec
    } catch (error: unknown) {
      if (ownership === undefined) throw error
      try {
        await ownership.release()
      } catch (releaseError: unknown) {
        throw new AggregateError([error, releaseError], `SDK session "${sessionId}" creation rollback failed`)
      }
      throw error
    }
  }

  /** Mark an unpublished server-created agent before resume may wake its inbox. */
  private trackManagedAgent(agentCtx: Context, ownership: SessionOwnership | undefined): void {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('SDK server agent setup has no agent identity')
    agentCtx.effect(() => {
      this.managedAgents.set(agent, ownership)
      return () => { this.managedAgents.delete(agent) }
    }, `sdk-jsonrpc-server.agent(${agent.id})`)
  }

  /** Quiesce and flush a managed agent before releasing its writer ownership. */
  private async disposeRecord(rec: SessionRecord): Promise<void> {
    const failures: unknown[] = []
    if (rec.ownership !== undefined) {
      try {
        rec.ownership.assertActive()
        rec.handle.agent.cancel({ kind: 'disposed' })
        await rec.handle.agent.whenIdle()
        await this.flushDurably(rec)
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    try {
      await rec.handle.dispose()
    } catch (error: unknown) {
      failures.push(error)
    } finally {
      if (rec.ownership !== undefined) {
        try {
          await rec.ownership.release()
        } catch (error: unknown) {
          failures.push(error)
        }
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK session teardown failed')
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}
