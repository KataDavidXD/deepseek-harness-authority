import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as agentCore from '@deepseek-ai/dsh-agent-spine-demo'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { SessionOwnershipConflictError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {
  JsonRpcTransportPeer,
  RuntimeBindingEnvelope,
  SessionAttemptLookupParams,
  SessionAttemptStartParams,
  SessionAttemptTerminalReceipt,
} from '@deepseek-ai/dsh-sdk-protocol'
import { createAttemptMessage, projectAttempt } from '../src/attempt.ts'
import { HarnessSdkJsonRpcServer } from '../src/index.ts'

class FakeTransport implements JsonRpcTransportPeer {
  request(): Promise<never> { return Promise.reject(new Error('unexpected host request')) }
  notify(): void {}
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: (string | null)[]) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const next = this.script.shift()
    if (next === undefined) throw new Error('ScriptedAdapter: script exhausted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (next === null) {
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => { reject(new Error('aborted')) }
        if (options.signal?.aborted === true) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
      })
      return
    }
    yield { type: 'text-delta', index: 0, text: next }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: next } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const roots: string[] = []
const contexts: Context[] = []
const TEST_RUNTIME_BINDING = {
  protocolVersion: 1,
  schemaVersion: 2,
  persistenceInstanceId: '11111111-1111-4111-8111-111111111111',
  rootConfigSha256: 'c'.repeat(64),
} as const satisfies RuntimeBindingEnvelope

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function storageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-attempt-'))
  roots.push(root)
  return root
}

async function harness(
  root: string,
  adapter: ScriptedAdapter,
  persistence = true,
  authoritativeRootConfig = true,
): Promise<{ ctx: Context; server: HarnessSdkJsonRpcServer; runtimeBinding: RuntimeBindingEnvelope | undefined }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(agentCore, { workspaceContext: false })
  if (persistence) {
    await ctx.plugin(JsonlSessionPersistence, { root })
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  ctx.llm.registerAdapter(['mock'], adapter)
  const server = new HarnessSdkJsonRpcServer(
    ctx,
    new FakeTransport(),
    authoritativeRootConfig ? { rootConfigSha256: 'c'.repeat(64) } : {},
  )
  const initialized = await server.initialize({ cwd: root, provider: 'mock', model: 'attempt-model' })
  return { ctx, server, runtimeBinding: initialized.runtimeBinding }
}

function startParams(
  attemptId = 'attempt-1',
  inputSha256 = 'a'.repeat(64),
  text = 'do it',
): SessionAttemptStartParams {
  return {
    sessionId: 'attempt-session',
    attemptId,
    inputSha256,
    contentBlocks: [{ type: 'text', text }],
  }
}

function lookup(params: SessionAttemptStartParams): SessionAttemptLookupParams {
  return {
    sessionId: params.sessionId,
    attemptId: params.attemptId,
    inputSha256: params.inputSha256,
  }
}

describe('durable SDK attempts', () => {
  it('binds initialization and every attempt receipt to the same persistence instance', async () => {
    const root = await storageRoot()
    const { server, runtimeBinding } = await harness(root, new ScriptedAdapter(['answer']))
    expect(runtimeBinding).toMatchObject({
      protocolVersion: 1,
      schemaVersion: 2,
      rootConfigSha256: 'c'.repeat(64),
    })
    expect(runtimeBinding?.persistenceInstanceId).toBeTypeOf('string')
    const started = await server.startAttempt(startParams('binding-attempt'))
    expect(started.attempt.runtimeBinding).toEqual(runtimeBinding)
    const read = await server.getAttempt(lookup(startParams('binding-attempt')))
    expect(read.attempt?.runtimeBinding).toEqual(runtimeBinding)
  })

  it('admits once, preserves attempt-to-turn evidence, and fails closed on hash or content conflicts', async () => {
    const root = await storageRoot()
    const adapter = new ScriptedAdapter(['answer'])
    const { ctx, server } = await harness(root, adapter)
    const params = startParams()

    const [first, duplicate] = await Promise.all([
      server.startAttempt(params),
      server.startAttempt(structuredClone(params)),
    ])
    await ctx.agents.get(SessionId(params.sessionId))?.whenIdle()
    const reconciled = await server.getAttempt(lookup(params))

    expect(first.deduplicated).toBe(false)
    expect(Object.keys(first.attempt).sort()).toEqual([
      'attemptId',
      'inputSha256',
      'messageId',
      'runtimeBinding',
      'sessionId',
      'status',
    ])
    expect(duplicate.deduplicated).toBe(true)
    expect(adapter.requests).toHaveLength(1)
    expect(reconciled.attempt).toMatchObject({
      status: 'terminal',
      sessionId: params.sessionId,
      attemptId: params.attemptId,
      inputSha256: params.inputSha256,
      turn: 1,
      finishReason: { kind: 'completed' },
      finalResponse: 'answer',
    })
    expect((reconciled.attempt as SessionAttemptTerminalReceipt).terminalEventSeq).toBeTypeOf('number')
    expect(reconciled.attempt?.messageId).toMatch(/^dsh-sdk-attempt:[0-9a-f]{64}$/)

    await expect(server.startAttempt({ ...params, inputSha256: 'b'.repeat(64) }))
      .rejects.toThrow('identity conflict')
    await expect(server.startAttempt({ ...params, contentBlocks: [{ type: 'text', text: 'different' }] }))
      .rejects.toThrow('content conflict')

    const inspection = await ctx.sessionPersistence.inspect(SessionId(params.sessionId))
    const insertions = inspection.events.filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(message => message.id === reconciled.attempt?.messageId))
    expect(insertions).toHaveLength(1)
    expect(insertions[0]).toMatchObject({
      data: {
        inserted: [{
          source: { kind: 'user', attemptId: params.attemptId, inputSha256: params.inputSha256 },
          content: params.contentBlocks,
        }],
      },
    })
  })

  it('persists the queued identity before waking the model driver', async () => {
    const root = await storageRoot()
    const adapter = new ScriptedAdapter(['after barrier'])
    const { ctx, server } = await harness(root, adapter)
    const params = startParams('flush-before-dispatch')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return original(session)
    })

    const starting = server.startAttempt(params)
    await entered.promise
    expect(adapter.requests).toHaveLength(0)
    const agent = ctx.agents.get(SessionId(params.sessionId))
    expect(agent).toBeDefined()
    expect(projectAttempt(agent?.session.events ?? [], lookup(params), TEST_RUNTIME_BINDING)?.receipt.status).toBe('queued')

    release.resolve(undefined)
    await expect(starting).resolves.toMatchObject({
      attempt: { status: 'queued' },
      deduplicated: false,
    })
    await agent?.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect((await server.getAttempt(lookup(params))).attempt).toMatchObject({
      status: 'terminal',
      finalResponse: 'after barrier',
    })
  })

  it('flushes the claimed attempt intent before allowing adapter dispatch', async () => {
    const root = await storageRoot()
    const adapter = new ScriptedAdapter(['after claim barrier'])
    const { ctx, server } = await harness(root, adapter)
    const params = startParams('claim-before-dispatch')
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = ctx.sessions.flush.bind(ctx.sessions)
    let calls = 0
    const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      calls += 1
      if (calls === 2) {
        entered.resolve(undefined)
        await release.promise
      }
      return original(session)
    })

    await server.startAttempt(params)
    try {
      await vi.waitFor(() => { expect(flush).toHaveBeenCalledTimes(2) })
      await entered.promise
      expect(adapter.requests).toHaveLength(0)
    } finally {
      release.resolve(undefined)
    }
    const agent = ctx.agents.get(SessionId(params.sessionId))
    await agent?.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const stored = await ctx.sessionPersistence.readFrom(SessionId(params.sessionId), 0)
    expect(stored.events.some(event => event.type === 'turn/start')).toBe(true)
    expect(stored.events.some(event => event.type === 'agent/inbox/spliced'
      && event.data.removedCount === 1 && event.data.outcome === undefined)).toBe(true)
    expect(projectAttempt(stored.events, lookup(params), TEST_RUNTIME_BINDING)?.receipt.status).not.toBe('queued')
  })

  it('fails before adapter dispatch when the claimed-attempt flush rejects', async () => {
    const root = await storageRoot()
    const adapter = new ScriptedAdapter(['must not dispatch'])
    const { ctx, server } = await harness(root, adapter)
    const params = startParams('claim-flush-failure')
    const original = ctx.sessions.flush.bind(ctx.sessions)
    let calls = 0
    const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      calls += 1
      if (calls === 2) throw new Error('claim persistence unavailable')
      return original(session)
    })

    await server.startAttempt(params)
    const agent = ctx.agents.get(SessionId(params.sessionId))
    await agent?.whenIdle()
    expect(flush).toHaveBeenCalledTimes(2)
    expect(adapter.requests).toHaveLength(0)

    flush.mockRestore()
    await expect(server.getAttempt(lookup(params))).resolves.toMatchObject({
      attempt: { status: 'terminal', finishReason: { kind: 'error' }, finalResponse: '' },
    })
  })

  it('keeps a second attempt unclaimable while its flush races a running turn', async () => {
    const root = await storageRoot()
    const adapter = new ScriptedAdapter([null, 'after running flush'])
    const { ctx, server } = await harness(root, adapter)
    const running = startParams('running-before-flush')
    const admitted = startParams('admitted-during-run', 'b'.repeat(64), 'run after the barrier')
    await server.startAttempt(running)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })

    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return original(session)
    })
    const starting = server.startAttempt(admitted)
    await entered.promise

    const agent = ctx.agents.get(SessionId(running.sessionId))
    expect(agent).toBeDefined()
    agent?.cancel({ kind: 'user' }, { keepInbox: true })
    await agent?.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(projectAttempt(agent?.session.events ?? [], lookup(admitted), TEST_RUNTIME_BINDING)?.receipt.status).toBe('queued')

    release.resolve(undefined)
    await expect(starting).resolves.toMatchObject({ attempt: { status: 'queued' } })
    await agent?.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    await expect(server.getAttempt(lookup(admitted))).resolves.toMatchObject({
      attempt: { status: 'terminal', finalResponse: 'after running flush' },
    })
  })

  it('keeps a failed admission flush parked and releases the same live attempt on retry', async () => {
    const root = await storageRoot()
    const adapter = new ScriptedAdapter(['after retry'])
    const { ctx, server } = await harness(root, adapter)
    const params = startParams('retry-after-flush-failure')
    const original = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush')
      .mockImplementation(original)
      .mockRejectedValueOnce(new Error('persistence unavailable'))

    await expect(server.startAttempt(params)).rejects.toThrow('persistence unavailable')
    expect(adapter.requests).toHaveLength(0)
    const agent = ctx.agents.get(SessionId(params.sessionId))
    expect(projectAttempt(agent?.session.events ?? [], lookup(params), TEST_RUNTIME_BINDING)?.receipt.status).toBe('queued')

    await expect(server.startAttempt(params)).resolves.toMatchObject({
      attempt: { status: 'queued' },
      deduplicated: true,
    })
    await agent?.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    await expect(server.getAttempt(lookup(params))).resolves.toMatchObject({
      attempt: { status: 'terminal', finalResponse: 'after retry' },
    })
  })

  it('returns the receipt captured before its flush instead of advertising a later event', async () => {
    const root = await storageRoot()
    const adapter = new ScriptedAdapter([null])
    const { ctx, server } = await harness(root, adapter)
    const params = startParams('receipt-cut')
    await server.startAttempt(params)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const agent = ctx.agents.get(SessionId(params.sessionId))
    expect(agent).toBeDefined()

    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = ctx.sessions.flush.bind(ctx.sessions)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return original(session)
    })
    const reconciling = server.getAttempt(lookup(params))
    await entered.promise
    agent?.cancel({ kind: 'user' }, { keepInbox: true })
    await agent?.whenIdle()
    release.resolve(undefined)

    await expect(reconciling).resolves.toMatchObject({ attempt: { status: 'running', turn: 1 } })
    flush.mockRestore()
    await expect(server.getAttempt(lookup(params))).resolves.toMatchObject({
      attempt: { status: 'terminal', turn: 1, finishReason: { kind: 'aborted' } },
    })
  })

  it('redrives a cold queued receipt through resume without a second insertion or model call', async () => {
    const root = await storageRoot()
    const seed = await harness(root, new ScriptedAdapter([]))
    const params = startParams('restart-attempt')
    const message = createAttemptMessage(params)
    await seed.ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(params.sessionId),
      createdAt: 1,
      cwd: root,
    })
    await seed.ctx.sessionPersistence.append(SessionId(params.sessionId), [{
      type: 'agent/inbox/spliced',
      seq: 0,
      time: 1,
      data: { target: 'next-turn', start: 0, inserted: [message] },
    }])
    await seed.server.shutdown()
    await seed.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(seed.ctx), 1)

    const adapter = new ScriptedAdapter(['after restart'])
    const resumed = await harness(root, adapter)
    const result = await resumed.server.startAttempt(params)
    await resumed.ctx.agents.get(SessionId(params.sessionId))?.whenIdle()
    const terminal = await resumed.server.getAttempt(lookup(params))

    expect(result.deduplicated).toBe(true)
    expect(adapter.requests).toHaveLength(1)
    expect(terminal.attempt).toMatchObject({
      status: 'terminal',
      turn: 1,
      finishReason: { kind: 'completed' },
      finalResponse: 'after restart',
    })
    const inspection = await resumed.ctx.sessionPersistence.inspect(SessionId(params.sessionId))
    expect(inspection.events.filter(event => event.type === 'agent/inbox/spliced'
      && event.data.inserted.some(inserted => inserted.id === message.id))).toHaveLength(1)
    expect(inspection.events.filter(event => event.type === 'user/message'
      && event.data.id === message.id)).toHaveLength(1)
  })

  it('gives one server durable ownership when two contexts redrive the same queued session', async () => {
    const root = await storageRoot()
    const seed = await harness(root, new ScriptedAdapter([]))
    const params = startParams('contended-redrive')
    const message = createAttemptMessage(params)
    await seed.ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(params.sessionId),
      createdAt: 1,
      cwd: root,
    })
    await seed.ctx.sessionPersistence.append(SessionId(params.sessionId), [{
      type: 'agent/inbox/spliced',
      seq: 0,
      time: 1,
      data: { target: 'next-turn', start: 0, inserted: [message] },
    }])
    await seed.server.shutdown()
    await seed.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(seed.ctx), 1)

    const firstAdapter = new ScriptedAdapter(['first owner', 'first retry'])
    const secondAdapter = new ScriptedAdapter(['second owner', 'second retry'])
    const first = await harness(root, firstAdapter)
    const second = await harness(root, secondAdapter)
    const outcomes = await Promise.allSettled([
      first.server.startAttempt(params),
      second.server.startAttempt(params),
    ])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toBeInstanceOf(SessionOwnershipConflictError)
    await Promise.all([
      first.ctx.agents.get(SessionId(params.sessionId))?.whenIdle(),
      second.ctx.agents.get(SessionId(params.sessionId))?.whenIdle(),
    ])
    expect(firstAdapter.requests.length + secondAdapter.requests.length).toBe(1)

    const winnerIndex = outcomes.findIndex(outcome => outcome.status === 'fulfilled')
    const winner = winnerIndex === 0 ? first : second
    const loser = winnerIndex === 0 ? second : first
    const loserAdapter = winnerIndex === 0 ? secondAdapter : firstAdapter
    await winner.server.shutdown()

    const afterRelease = startParams('after-owner-release', 'c'.repeat(64), 'take ownership after release')
    await loser.server.startAttempt(afterRelease)
    await loser.ctx.agents.get(SessionId(params.sessionId))?.whenIdle()
    expect(loserAdapter.requests).toHaveLength(1)
  })

  it('releases durable ownership only after the final flush and agent disposal complete', async () => {
    const root = await storageRoot()
    const adapter = new ScriptedAdapter(['finished'])
    const { ctx, server } = await harness(root, adapter)
    const params = startParams('shutdown-release-order')
    await server.startAttempt(params)
    await ctx.agents.get(SessionId(params.sessionId))?.whenIdle()

    const rec = (server as unknown as {
      sessions: Map<string, {
        handle: { dispose(): Promise<void> }
        ownership?: { active: boolean; release(): Promise<void> }
      }>
    }).sessions.get(params.sessionId)
    expect(rec?.ownership).toBeDefined()
    if (rec?.ownership === undefined) throw new Error('expected server-owned durable session')

    const flushEntered = Promise.withResolvers<undefined>()
    const allowFlush = Promise.withResolvers<undefined>()
    const originalFlush = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementation(async (session) => {
      flushEntered.resolve(undefined)
      await allowFlush.promise
      return originalFlush(session)
    })
    const disposeEntered = Promise.withResolvers<undefined>()
    const allowDispose = Promise.withResolvers<undefined>()
    const originalDispose = rec.handle.dispose.bind(rec.handle)
    const dispose = vi.spyOn(rec.handle, 'dispose').mockImplementation(async () => {
      disposeEntered.resolve(undefined)
      await allowDispose.promise
      await originalDispose()
    })
    const originalRelease = rec.ownership.release.bind(rec.ownership)
    const release = vi.spyOn(rec.ownership, 'release').mockImplementation(() => originalRelease())

    const shutdown = server.shutdown()
    await flushEntered.promise
    expect(dispose).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(rec.ownership.active).toBe(true)

    allowFlush.resolve(undefined)
    await disposeEntered.promise
    expect(release).not.toHaveBeenCalled()
    expect(rec.ownership.active).toBe(true)

    allowDispose.resolve(undefined)
    await expect(shutdown).resolves.toEqual({})
    expect(release).toHaveBeenCalledOnce()
    expect(rec.ownership.active).toBe(false)
  })

  it('releases ownership when agent creation rolls back before publication', async () => {
    const root = await storageRoot()
    const params = startParams('creation-rollback')
    const firstAdapter = new ScriptedAdapter([])
    const first = await harness(root, firstAdapter)
    vi.spyOn(first.ctx.agents, 'create').mockRejectedValueOnce(new Error('synthetic creation failure'))

    await expect(first.server.startAttempt(params)).rejects.toThrow('synthetic creation failure')
    expect(firstAdapter.requests).toHaveLength(0)

    const secondAdapter = new ScriptedAdapter(['after rollback'])
    const second = await harness(root, secondAdapter)
    await expect(second.server.startAttempt(params)).resolves.toMatchObject({
      attempt: { status: 'queued' },
      deduplicated: false,
    })
    await second.ctx.agents.get(SessionId(params.sessionId))?.whenIdle()
    expect(secondAdapter.requests).toHaveLength(1)
  })

  it('repairs a cold running receipt to interrupted on start retry without redispatch', async () => {
    const sourceRoot = await storageRoot()
    const params = startParams('restart-running')
    const source = await harness(sourceRoot, new ScriptedAdapter([null]))
    await source.server.startAttempt(params)
    const sourceAgent = source.ctx.agents.get(SessionId(params.sessionId))
    expect(sourceAgent).toBeDefined()
    await vi.waitFor(() => {
      expect(projectAttempt(sourceAgent?.session.events ?? [], lookup(params), TEST_RUNTIME_BINDING)?.receipt.status)
        .toBe('running')
    })
    const openEvents = structuredClone(sourceAgent?.session.events ?? [])
    sourceAgent?.cancel({ kind: 'user' }, { keepInbox: true })
    await sourceAgent?.whenIdle()
    await source.server.shutdown()
    await source.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(source.ctx), 1)

    const restartRoot = await storageRoot()
    const seed = await harness(restartRoot, new ScriptedAdapter([]))
    await seed.ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(params.sessionId),
      createdAt: 1,
      cwd: restartRoot,
    })
    await seed.ctx.sessionPersistence.append(SessionId(params.sessionId), openEvents)
    await seed.server.shutdown()
    await seed.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(seed.ctx), 1)

    const adapter = new ScriptedAdapter([])
    const resumed = await harness(restartRoot, adapter)
    await expect(resumed.server.getAttempt(lookup(params))).resolves.toMatchObject({
      attempt: { status: 'running', turn: 1 },
    })
    await expect(resumed.server.startAttempt(params)).resolves.toMatchObject({
      attempt: { status: 'terminal', turn: 1, finishReason: { kind: 'interrupted' } },
      deduplicated: true,
    })
    expect(adapter.requests).toHaveLength(0)
    await expect(resumed.server.getAttempt(lookup(params))).resolves.toMatchObject({
      attempt: { status: 'terminal', turn: 1, finishReason: { kind: 'interrupted' } },
    })
  })

  it('fails closed when a custom resumed agent does not implement wakePending', async () => {
    const root = await storageRoot()
    const seed = await harness(root, new ScriptedAdapter([]))
    const params = startParams('unsupported-resume-wake')
    const message = createAttemptMessage(params)
    await seed.ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(params.sessionId),
      createdAt: 1,
      cwd: root,
    })
    await seed.ctx.sessionPersistence.append(SessionId(params.sessionId), [{
      type: 'agent/inbox/spliced',
      seq: 0,
      time: 1,
      data: { target: 'next-turn', start: 0, inserted: [message] },
    }])
    await seed.server.shutdown()
    await seed.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(seed.ctx), 1)

    const adapter = new ScriptedAdapter([])
    const resumed = await harness(root, adapter)
    const resume = resumed.ctx.agents.resume.bind(resumed.ctx.agents)
    vi.spyOn(resumed.ctx.agents, 'resume').mockImplementation(async (options) => {
      const handle = await resume({ ...options, wakePending: false })
      Object.defineProperty(handle.agent, 'wakePending', { value: undefined })
      return handle
    })

    await expect(resumed.server.startAttempt(params)).rejects.toThrow('wakePending() support')
    expect(adapter.requests).toHaveLength(0)
    expect(projectAttempt(
      resumed.ctx.agents.get(SessionId(params.sessionId))?.session.events ?? [],
      lookup(params),
      TEST_RUNTIME_BINDING,
    )?.receipt.status).toBe('queued')
  })

  it('cancels an exact queued item without disturbing the running attempt, then cancels that turn', async () => {
    const root = await storageRoot()
    const adapter = new ScriptedAdapter([null])
    const { server } = await harness(root, adapter)
    const running = startParams('running-attempt')
    const queued = startParams('queued-attempt', 'b'.repeat(64), 'later')

    await server.startAttempt(running)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const queuedStart = await server.startAttempt(queued)
    expect(queuedStart.attempt.status).toBe('queued')

    const queuedCanceled = await server.cancelAttempt(lookup(queued))
    expect(queuedCanceled.attempt).toMatchObject({
      status: 'terminal',
      finishReason: { kind: 'canceled' },
      finalResponse: '',
    })
    expect(queuedCanceled.attempt.turn).toBeUndefined()

    const runningCanceled = await server.cancelAttempt(lookup(running))
    expect(runningCanceled.attempt).toMatchObject({
      status: 'terminal',
      turn: 1,
      finishReason: { kind: 'aborted' },
    })
    expect(adapter.requests).toHaveLength(1)
  })

  it('wakes the preserved queued attempt after canceling the running turn', async () => {
    const root = await storageRoot()
    const adapter = new ScriptedAdapter([null, 'after cancellation'])
    const { ctx, server } = await harness(root, adapter)
    const running = startParams('cancel-running')
    const queued = startParams('preserved-queued', 'b'.repeat(64), 'run after cancellation')
    await server.startAttempt(running)
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    await expect(server.startAttempt(queued)).resolves.toMatchObject({ attempt: { status: 'queued' } })

    await expect(server.cancelAttempt(lookup(running))).resolves.toMatchObject({
      attempt: { status: 'terminal', finishReason: { kind: 'aborted' } },
    })
    const agent = ctx.agents.get(SessionId(running.sessionId))
    await agent?.whenIdle()
    expect(adapter.requests).toHaveLength(2)
    await expect(server.getAttempt(lookup(queued))).resolves.toMatchObject({
      attempt: { status: 'terminal', finalResponse: 'after cancellation' },
    })
  })

  it('requires persistence and rejects malformed attempt wire values before creating an agent', async () => {
    const root = await storageRoot()
    const adapter = new ScriptedAdapter([])
    const withoutPersistence = await harness(root, adapter, false)
    const params = startParams()
    await expect(withoutPersistence.server.startAttempt(params))
      .rejects.toThrow('require session persistence')
    expect(withoutPersistence.ctx.agents.get(SessionId(params.sessionId))).toBeUndefined()

    const noFingerprintRoot = await storageRoot()
    const withoutFingerprint = await harness(noFingerprintRoot, adapter, true, false)
    expect(withoutFingerprint.runtimeBinding).toBeUndefined()
    await expect(withoutFingerprint.server.startAttempt(params))
      .rejects.toThrow('require an initialized runtime binding')
    expect(withoutFingerprint.ctx.agents.get(SessionId(params.sessionId))).toBeUndefined()
    expect(adapter.requests).toHaveLength(0)

    const unsupportedRoot = await storageRoot()
    const unsupported = await harness(unsupportedRoot, adapter)
    Object.defineProperty(unsupported.ctx.sessionPersistence, 'supportsOwnership', { value: false })
    await expect(unsupported.server.startAttempt(params))
      .rejects.toThrow('require session ownership support')
    expect(unsupported.ctx.agents.get(SessionId(params.sessionId))).toBeUndefined()

    const malformedRoot = await storageRoot()
    const malformed = await harness(malformedRoot, adapter)
    await expect(malformed.server.handleRequest('session/attempt.start', {
      ...params,
      attemptId: `x${'/'.repeat(128)}`,
    })).rejects.toThrow('attemptId')
    await expect(malformed.server.handleRequest('session/attempt.get', {
      ...lookup(params),
      inputSha256: 'A'.repeat(64),
    })).rejects.toThrow('inputSha256')
    await expect(malformed.server.handleRequest('session/attempt.start', {
      ...params,
      contentBlocks: [{ type: 'text', text: Number.NaN }],
    })).rejects.toThrow('finite JSON numbers')
    await expect(malformed.server.handleRequest('session/attempt.start', {
      ...params,
      contentBlocks: [{ type: 'image', bytes: new Uint8Array([1]) }],
    })).rejects.toThrow('JSON objects and arrays')
    const cyclic: unknown[] = []
    cyclic.push({ type: 'text', text: cyclic })
    await expect(malformed.server.handleRequest('session/attempt.start', {
      ...params,
      contentBlocks: cyclic,
    })).rejects.toThrow('must not contain a cycle')
    const symbolBlock = { type: 'text', text: 'hidden key' }
    Object.defineProperty(symbolBlock, Symbol('hidden'), { value: true, enumerable: true })
    await expect(malformed.server.handleRequest('session/attempt.start', {
      ...params,
      contentBlocks: [symbolBlock],
    })).rejects.toThrow('must not contain symbol keys')
    const getter = vi.fn(() => 'must not execute')
    const accessorBlock = { type: 'text' } as { type: string; text?: string }
    Object.defineProperty(accessorBlock, 'text', { get: getter, enumerable: true })
    await expect(malformed.server.handleRequest('session/attempt.start', {
      ...params,
      contentBlocks: [accessorBlock],
    })).rejects.toThrow('must be an enumerable data property')
    expect(getter).not.toHaveBeenCalled()
    expect(malformed.ctx.agents.get(SessionId(params.sessionId))).toBeUndefined()
  })

  it('keeps legacy prompts compatible with persistence that does not support ownership', async () => {
    const root = await storageRoot()
    const adapter = new ScriptedAdapter(['legacy answer'])
    const { ctx, server } = await harness(root, adapter)
    const acquire = vi.spyOn(ctx.sessionPersistence, 'acquireOwnership')
    Object.defineProperty(ctx.sessionPersistence, 'supportsOwnership', { value: false })

    const receipt = await server.prompt({
      sessionId: 'attempt-session',
      contentBlocks: [{ type: 'text', text: 'legacy prompt' }],
    })
    expect(receipt.messageId).toBeTypeOf('string')
    await ctx.agents.get(SessionId('attempt-session'))?.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(acquire).not.toHaveBeenCalled()

    await expect(server.startAttempt(startParams('unsupported-upgrade')))
      .rejects.toThrow('require session ownership support')
    expect(adapter.requests).toHaveLength(1)
  })

  it('observes cold terminal and queued attempts without acquiring unsupported ownership', async () => {
    const root = await storageRoot()
    const terminalParams = startParams('read-only-terminal')
    const seed = await harness(root, new ScriptedAdapter(['stored answer']))
    await seed.server.startAttempt(terminalParams)
    await seed.ctx.agents.get(SessionId(terminalParams.sessionId))?.whenIdle()
    await seed.server.shutdown()
    await seed.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(seed.ctx), 1)

    const observer = await harness(root, new ScriptedAdapter([]))
    const queuedParams = { ...startParams('read-only-queued'), sessionId: 'queued-observation' }
    const queuedMessage = createAttemptMessage(queuedParams)
    await observer.ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: SessionId(queuedParams.sessionId),
      createdAt: 1,
      cwd: root,
    })
    await observer.ctx.sessionPersistence.append(SessionId(queuedParams.sessionId), [{
      type: 'agent/inbox/spliced',
      seq: 0,
      time: 1,
      data: { target: 'next-turn', start: 0, inserted: [queuedMessage] },
    }])
    const acquire = vi.spyOn(observer.ctx.sessionPersistence, 'acquireOwnership')
    Object.defineProperty(observer.ctx.sessionPersistence, 'supportsOwnership', { value: false })

    await expect(observer.server.getAttempt(lookup(terminalParams))).resolves.toMatchObject({
      attempt: { status: 'terminal', finalResponse: 'stored answer' },
    })
    await expect(observer.server.getAttempt(lookup(queuedParams))).resolves.toMatchObject({
      attempt: { status: 'queued' },
    })
    expect(observer.ctx.agents.get(SessionId(terminalParams.sessionId))).toBeUndefined()
    expect(observer.ctx.agents.get(SessionId(queuedParams.sessionId))).toBeUndefined()
    expect(acquire).not.toHaveBeenCalled()
  })

  it('refuses to upgrade a live legacy session created before durable ownership was available', async () => {
    const root = await storageRoot()
    const adapter = new ScriptedAdapter(['legacy answer'])
    const { ctx, server } = await harness(root, adapter, false)
    await server.prompt({
      sessionId: 'attempt-session',
      contentBlocks: [{ type: 'text', text: 'legacy before persistence' }],
    })
    await ctx.agents.get(SessionId('attempt-session'))?.whenIdle()

    await ctx.plugin(JsonlSessionPersistence, { root })
    await new Promise(resolve => setTimeout(resolve, 25))
    const acquire = vi.spyOn(ctx.sessionPersistence, 'acquireOwnership')
    await expect(server.startAttempt(startParams('unsafe-live-upgrade')))
      .rejects.toThrow('was created without durable ownership')
    expect(acquire).not.toHaveBeenCalled()
    expect(adapter.requests).toHaveLength(1)
  })

  it('returns null for lookup, rejects cancel when absent, and waits admitted operations during shutdown', async () => {
    const root = await storageRoot()
    const adapter = new ScriptedAdapter([])
    const { ctx, server } = await harness(root, adapter)
    const params = startParams('missing-attempt')
    expect(await server.getAttempt(lookup(params))).toEqual({ attempt: null })
    await expect(server.cancelAttempt(lookup(params))).rejects.toThrow('was not found')

    const release = Promise.withResolvers<undefined>()
    const original = ctx.sessionPersistence.listSnapshots.bind(ctx.sessionPersistence)
    const blocked = vi.spyOn(ctx.sessionPersistence, 'listSnapshots').mockImplementation(async () => {
      await release.promise
      return original()
    })
    const admitted = server.getAttempt(lookup(params))
    await vi.waitFor(() => { expect(blocked).toHaveBeenCalledOnce() })
    const shutdown = server.shutdown()
    let shutdownSettled = false
    void shutdown.then(() => { shutdownSettled = true }, () => { shutdownSettled = true })
    await Promise.resolve()
    expect(shutdownSettled).toBe(false)
    await expect(server.getAttempt(lookup(params))).rejects.toThrow('shutting down')
    release.resolve(undefined)
    await expect(admitted).resolves.toEqual({ attempt: null })
    await expect(shutdown).resolves.toEqual({})
  })
})
