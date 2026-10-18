/**
 * REAL composition: boot a test cordis.yml through Loader, mount the exact SDK
 * server namespace with only stdio hooks substituted, and assert its wire.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as agentCore from '@deepseek-ai/dsh-agent-spine-demo'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as jsonrpc from '../src/index.ts'

const ROOT_CONFIG_SHA256_CAPABILITY = Symbol.for('deepseek-harness.root-config-sha256')

class OneAnswerAdapter extends LlmAdapter {
  calls = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'loader answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'loader answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Wait for one response or notification frame from the composed stdio wire. */
async function waitForFrame(
  frames: readonly Record<string, unknown>[],
  predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000
  for (;;) {
    const frame = frames.find(predicate)
    if (frame !== undefined) return frame
    if (Date.now() >= deadline) throw new Error('timed out waiting for Loader-composed JSON-RPC frame')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('dsh-sdk-jsonrpc-server real Loader composition', () => {
  it('boots from cordis.yml and serves one durable attempt over the user-visible wire', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-sdk-loader-'))
    const configPath = join(root, 'cordis.yml')
    const yamlRoot = root.replaceAll("'", "''")
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-agent-spine-demo'",
      '  config:',
      '    workspaceContext: false',
      "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      `    root: '${yamlRoot}'`,
      "- name: '@deepseek-ai/dsh-sdk-jsonrpc-server'",
      '',
    ].join('\n'))

    const input = new PassThrough()
    const frames: Record<string, unknown>[] = []
    let buffered = ''
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        buffered += chunk.toString('utf8')
        for (;;) {
          const newline = buffered.indexOf('\n')
          if (newline < 0) break
          const line = buffered.slice(0, newline).trim()
          buffered = buffered.slice(newline + 1)
          if (line.length > 0) frames.push(JSON.parse(line) as Record<string, unknown>)
        }
        callback()
      },
    })
    const loaderServer = {
      ...jsonrpc,
      apply(ctx: Context, config: jsonrpc.JsonRpcConfig): void {
        jsonrpc.apply(ctx, { ...config, input, output, exit: (code) => { throw new Error(`unexpected exit ${String(code)}`) } })
      },
    }

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    Object.defineProperty(context, ROOT_CONFIG_SHA256_CAPABILITY, {
      enumerable: false,
      value: 'c'.repeat(64),
    })
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent-spine-demo', agentCore],
      ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
      ['@deepseek-ai/dsh-sdk-jsonrpc-server', loaderServer],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const unloaded = [...context.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const adapter = new OneAnswerAdapter()
    context.llm.registerAdapter(['loader-mock'], adapter)
    const send = (frame: Record<string, unknown>): void => { input.write(`${JSON.stringify(frame)}\n`) }
    send({
      jsonrpc: '2.0', id: 'init', method: 'initialize',
      params: { cwd: root, provider: 'loader-mock', model: 'loader-model' },
    })
    const initialized = await waitForFrame(frames, frame => frame.id === 'init')
    expect(initialized).toMatchObject({
      result: {
        runtimeBinding: {
          protocolVersion: 1,
          schemaVersion: 2,
          rootConfigSha256: 'c'.repeat(64),
        },
      },
    })
    const runtimeBinding = (initialized.result as { runtimeBinding: unknown }).runtimeBinding
    const params = {
      sessionId: 'loader-session',
      attemptId: 'loader-attempt',
      inputSha256: 'a'.repeat(64),
      contentBlocks: [{ type: 'text', text: 'run through Loader' }],
    }
    send({ jsonrpc: '2.0', id: 'start', method: 'session/attempt.start', params })
    expect(await waitForFrame(frames, frame => frame.id === 'start')).toMatchObject({
      result: { attempt: { status: 'queued', runtimeBinding }, deduplicated: false },
    })
    await waitForFrame(frames, frame => frame.method === 'session.status'
      && (frame.params as { sessionId?: string; status?: string } | undefined)?.sessionId === params.sessionId
      && (frame.params as { status?: string } | undefined)?.status === 'idle')
    send({
      jsonrpc: '2.0', id: 'get', method: 'session/attempt.get',
      params: { sessionId: params.sessionId, attemptId: params.attemptId, inputSha256: params.inputSha256 },
    })
    expect(await waitForFrame(frames, frame => frame.id === 'get')).toMatchObject({
      result: {
        attempt: {
          status: 'terminal',
          turn: 1,
          finishReason: { kind: 'completed' },
          finalResponse: 'loader answer',
          runtimeBinding,
        },
      },
    })
    expect(adapter.calls).toBe(1)
  })
})
