/**
 * Real cancellation boundaries for durable SDK attempts. This suite boots the
 * built JSON-RPC runtime through Loader, drives its stdio wire, and uses Node's
 * real fetch/Undici path against a deterministic local provider.
 */

import { createServer as createHttpServer, type ServerResponse } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Socket } from 'node:net'
import { execa, type ResultPromise } from 'execa'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const runtimeProject = join(repoRoot, 'python', 'sdk-runtime')
const binScript = join(repoRoot, 'packages', 'examples', 'jsonrpc-demo', 'lib', 'bin.js')

type Frame = Record<string, unknown>
type ProviderMode = 'tcp-before-handler' | 'body-before-headers' | 'first-chunk' | 'tool-running'
type RuntimeOptions = {
  cwd: string
  env: NodeJS.ProcessEnv
  reject: false
  timeout: number
  killSignal: 'SIGKILL'
  stdin: 'pipe'
  stdout: 'pipe'
  stderr: 'pipe'
}

interface ProviderHarness {
  readonly baseUrl: string
  readonly ready: Promise<void>
  readonly requests: readonly Record<string, unknown>[]
  close(): Promise<void>
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  const gate = Promise.withResolvers<undefined>()
  return {
    promise: gate.promise,
    resolve: () => { gate.resolve(undefined) },
  }
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

async function createProvider(mode: ProviderMode): Promise<ProviderHarness> {
  const ready = deferred()
  const requests: Record<string, unknown>[] = []
  const sockets = new Set<Socket>()

  if (mode === 'tcp-before-handler') {
    const server = createTcpServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => { sockets.delete(socket) })
      socket.on('error', () => {})
      // The TCP handshake completed, so fetch is in flight, but the provider
      // application deliberately receives no HTTP request bytes.
      socket.pause()
      ready.resolve()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('TCP provider did not bind')
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      ready: ready.promise,
      requests,
      async close() {
        for (const socket of sockets) socket.destroy()
        await new Promise<void>(resolve => server.close(() => { resolve() }))
      },
    }
  }

  const heldResponses = new Set<ServerResponse>()
  const server = createHttpServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>)
      if (mode === 'body-before-headers') {
        heldResponses.add(response)
        response.on('close', () => { heldResponses.delete(response) })
        ready.resolve()
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (mode === 'first-chunk') {
        heldResponses.add(response)
        response.on('close', () => { heldResponses.delete(response) })
        response.write(sse({ choices: [{ delta: { role: 'assistant', content: 'partial' } }] }), () => {
          ready.resolve()
        })
        return
      }
      response.end([
        sse({
          choices: [{
            delta: {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: 'cancel-tool-call',
                type: 'function',
                function: { name: 'block_until_cancel', arguments: '{}' },
              }],
            },
          }],
        }),
        sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ].join(''))
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket) })
    socket.on('error', () => {})
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP provider did not bind')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    ready: ready.promise,
    requests,
    async close() {
      for (const response of heldResponses) response.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    },
  }
}

class RuntimePeer {
  private readonly frames: Frame[] = []
  private readonly child: ResultPromise<RuntimeOptions>
  private stdoutBuffer = ''
  private stderr = ''
  private nextId = 0

  constructor(configPath: string, env: NodeJS.ProcessEnv) {
    const options: RuntimeOptions = {
      cwd: repoRoot,
      env,
      reject: false,
      timeout: 45_000,
      killSignal: 'SIGKILL',
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
    this.child = execa(process.execPath, [binScript, configPath], options)
    const stdout = this.child.stdout
    const stderr = this.child.stderr
    if (stdout === null || stderr === null) throw new Error('runtime stdio was not piped')
    stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf8')
      const lines = this.stdoutBuffer.split('\n')
      this.stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim().length > 0) this.frames.push(JSON.parse(line) as Frame)
      }
    })
    stderr.on('data', (chunk: Buffer) => { this.stderr += chunk.toString('utf8') })
  }

  async request(method: string, params?: Record<string, unknown>): Promise<Frame> {
    const id = `cancel-e2e-${++this.nextId}`
    const stdin = this.child.stdin
    if (stdin === null) throw new Error('runtime stdin was not piped')
    stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...params === undefined ? {} : { params },
    })}\n`)
    const frame = await this.waitFor(value => value.id === id)
    const error = frame.error as { code?: number; message?: string } | undefined
    if (error !== undefined) {
      throw new Error(`JSON-RPC ${method} failed (${String(error.code)}): ${String(error.message)}`)
    }
    return frame
  }

  async waitFor(predicate: (frame: Frame) => boolean): Promise<Frame> {
    const deadline = Date.now() + 30_000
    for (;;) {
      const index = this.frames.findIndex(predicate)
      if (index >= 0) return this.frames.splice(index, 1)[0]!
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for runtime frame; stderr=${this.stderr}`)
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  async close(): Promise<void> {
    try {
      await this.request('shutdown')
    } catch {
      this.child.kill('SIGKILL')
    }
    await this.child
  }
}

function attemptStatus(frame: Frame): string | undefined {
  const result = frame.result as { attempt?: { status?: string } } | undefined
  return result?.attempt?.status
}

function attemptReceipt(frame: Frame): Record<string, unknown> | undefined {
  const result = frame.result as { attempt?: Record<string, unknown> } | undefined
  return result?.attempt
}

async function waitForRunning(peer: RuntimePeer, lookup: Record<string, unknown>): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const frame = await peer.request('session/attempt.get', lookup)
    if (attemptStatus(frame) === 'running') return
    if (Date.now() >= deadline) throw new Error('attempt did not enter running state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      await access(path)
      return
    } catch {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

async function writeComposition(root: string): Promise<string> {
  const pluginPath = join(root, 'cancel-tool.mjs')
  await writeFile(pluginPath, [
    "import { writeFile } from 'node:fs/promises'",
    "import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'",
    "export const name = 'cancel-e2e-tool'",
    "export const inject = ['tools']",
    'export function apply(ctx) {',
    '  return ctx.effect(() => ctx.tools.register(defineContentToolFixture({',
    "    name: 'block_until_cancel',",
    "    description: 'Block until the owning turn is cancelled.',",
    '    parameters: {},',
    '    async execute(_args, exec) {',
    '      await writeFile(process.env.DSH_CANCEL_TOOL_MARKER, \'started\')',
    '      await new Promise((_resolve, reject) => {',
    '        const abort = () => {',
    '          const cause = exec.signal.reason',
    "          if (cause !== null && typeof cause === 'object' && Object.isExtensible(cause)) {",
    "            Object.defineProperty(cause, 'stack', { configurable: true, enumerable: false, get: () => 'tool stack' })",
    '          }',
    "          reject(new Error('tool aborted'))",
    '        }',
    '        if (exec.signal.aborted) abort()',
    "        else exec.signal.addEventListener('abort', abort, { once: true })",
    '      })',
    "      return [{ type: 'text', text: 'unreachable' }]",
    '    },',
    '  })))',
    '}',
    '',
  ].join('\n'))
  const configPath = join(root, 'cordis.yml')
  const yamlRoot = root.replaceAll("'", "''")
  const yamlPlugin = pathToFileURL(pluginPath).href.replaceAll("'", "''")
  await writeFile(configPath, [
    '- id: sdk-jsonrpc-server',
    '  name: \'@deepseek-ai/dsh-sdk-jsonrpc-server\'',
    '- id: agent-core',
    '  name: \'@deepseek-ai/dsh-agent-spine-demo\'',
    '  config:',
    '    workspaceContext: false',
    '- id: llm-deepseek',
    '  name: \'@deepseek-ai/dsh-llm-deepseek\'',
    '- id: sessions',
    '  name: \'@deepseek-ai/dsh-session-persistence-jsonl\'',
    '  config:',
    `    root: '${yamlRoot}'`,
    '    compression: none',
    '- id: session-checkpoints',
    '  name: \'@deepseek-ai/dsh-session-checkpoint-policy\'',
    '- id: cancel-tool',
    `  name: '${yamlPlugin}'`,
    '',
  ].join('\n'))
  return configPath
}

describe('durable attempt cancellation over the real JSON-RPC runtime', () => {
  it('cancels an exact queued attempt without dispatching it or disturbing the owned turn', async () => {
    const root = await mkdtemp(join(runtimeProject, '.dsh-cancel-e2e-'))
    const marker = join(root, 'tool-started')
    const provider = await createProvider('body-before-headers')
    const configPath = await writeComposition(root)
    const rootConfigSha256 = createHash('sha256').update(await readFile(configPath)).digest('hex')
    const peer = new RuntimePeer(configPath, {
      DEEPSEEK_API_KEY: 'cancel-e2e-no-secret',
      DEEPSEEK_BASE_URL: provider.baseUrl,
      DSH_CWD: root,
      DSH_SESSION_ROOT: root,
      DSH_CANCEL_TOOL_MARKER: marker,
    })
    try {
      await peer.request('initialize', { cwd: root, provider: 'deepseek-official', model: 'cancel-e2e-model' })
      const running = {
        sessionId: 'cancel-queued-window',
        attemptId: 'attempt-owned',
        inputSha256: 'a'.repeat(64),
        contentBlocks: [{ type: 'text', text: 'keep this turn owned' }],
      }
      const queued = {
        sessionId: running.sessionId,
        attemptId: 'attempt-queued',
        inputSha256: 'b'.repeat(64),
        contentBlocks: [{ type: 'text', text: 'this turn must never dispatch' }],
      }
      const runningLookup = {
        sessionId: running.sessionId,
        attemptId: running.attemptId,
        inputSha256: running.inputSha256,
      }
      const queuedLookup = {
        sessionId: queued.sessionId,
        attemptId: queued.attemptId,
        inputSha256: queued.inputSha256,
      }

      expect(attemptStatus(await peer.request('session/attempt.start', running))).toBe('queued')
      await provider.ready
      await waitForRunning(peer, runningLookup)
      expect(provider.requests).toHaveLength(1)
      const ownedReceipt = attemptReceipt(await peer.request('session/attempt.get', runningLookup))
      expect(ownedReceipt).toMatchObject({ status: 'running', turn: 1 })

      expect(await peer.request('session/attempt.start', queued)).toMatchObject({
        result: {
          deduplicated: false,
          attempt: {
            sessionId: queued.sessionId,
            attemptId: queued.attemptId,
            inputSha256: queued.inputSha256,
            status: 'queued',
          },
        },
      })
      expect(await peer.request('session/attempt.get', queuedLookup)).toMatchObject({
        result: { attempt: { status: 'queued' } },
      })
      expect(provider.requests).toHaveLength(1)
      await expect(access(marker)).rejects.toThrow()

      const queuedCanceled = attemptReceipt(await peer.request('session/attempt.cancel', queuedLookup))
      expect(queuedCanceled).toMatchObject({
        sessionId: queued.sessionId,
        attemptId: queued.attemptId,
        inputSha256: queued.inputSha256,
        status: 'terminal',
        finishReason: { kind: 'canceled' },
        finalResponse: '',
        runtimeBinding: {
          protocolVersion: 1,
          schemaVersion: 2,
          rootConfigSha256,
        },
      })
      expect(typeof queuedCanceled?.terminalEventSeq).toBe('number')
      const queuedBinding = queuedCanceled?.runtimeBinding as Record<string, unknown> | undefined
      expect(typeof queuedBinding?.persistenceInstanceId).toBe('string')
      expect(queuedCanceled).not.toHaveProperty('turn')
      expect(attemptReceipt(await peer.request('session/attempt.get', queuedLookup))).toEqual(queuedCanceled)
      expect(attemptReceipt(await peer.request('session/attempt.get', runningLookup))).toEqual(ownedReceipt)
      expect(provider.requests).toHaveLength(1)
      await expect(access(marker)).rejects.toThrow()

      expect(await peer.request('session/attempt.cancel', runningLookup)).toMatchObject({
        result: { attempt: { status: 'terminal', turn: 1, finishReason: { kind: 'aborted' } } },
      })
      expect(provider.requests).toHaveLength(1)
    } finally {
      await peer.close()
      await provider.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { mode: 'tcp-before-handler', label: 'before the provider request reaches its HTTP handler' },
    { mode: 'body-before-headers', label: 'after the provider reads the body but before response headers' },
    { mode: 'first-chunk', label: 'after the first SSE chunk' },
    { mode: 'tool-running', label: 'while a model-selected tool is running' },
  ] satisfies { mode: ProviderMode; label: string }[])('persists a terminal receipt $label', async ({ mode }) => {
    const root = await mkdtemp(join(runtimeProject, '.dsh-cancel-e2e-'))
    const marker = join(root, 'tool-started')
    const provider = await createProvider(mode)
    const configPath = await writeComposition(root)
    const peer = new RuntimePeer(configPath, {
      DEEPSEEK_API_KEY: 'cancel-e2e-no-secret',
      DEEPSEEK_BASE_URL: provider.baseUrl,
      DSH_CWD: root,
      DSH_SESSION_ROOT: root,
      DSH_CANCEL_TOOL_MARKER: marker,
    })
    try {
      await peer.request('initialize', { cwd: root, provider: 'deepseek-official', model: 'cancel-e2e-model' })
      const params = {
        sessionId: `cancel-${mode}`,
        attemptId: `attempt-${mode}`,
        inputSha256: mode.charCodeAt(0).toString(16).padStart(2, '0').repeat(32),
        contentBlocks: [{ type: 'text', text: `cancel ${mode}` }],
      }
      const lookup = {
        sessionId: params.sessionId,
        attemptId: params.attemptId,
        inputSha256: params.inputSha256,
      }
      expect(attemptStatus(await peer.request('session/attempt.start', params))).toBe('queued')
      if (mode === 'tool-running') await waitForFile(marker)
      else await provider.ready
      await waitForRunning(peer, lookup)

      const canceled = await peer.request('session/attempt.cancel', lookup)
      expect(canceled).toMatchObject({
        result: { attempt: { status: 'terminal', turn: 1, finishReason: { kind: 'aborted' } } },
      })
      expect(await peer.request('session/attempt.get', lookup)).toMatchObject({
        result: { attempt: { status: 'terminal', turn: 1, finishReason: { kind: 'aborted' } } },
      })
      expect(provider.requests).toHaveLength(mode === 'tcp-before-handler' ? 0 : 1)
    } finally {
      await peer.close()
      await provider.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
