import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  FileSessionOwnershipRegistry,
  SessionOwnerToken,
  SessionOwnershipConflictError,
} from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('FileSessionOwnershipRegistry lifecycle', () => {
  it('keeps the native guard until an admitted mutation drains', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-ownership-release-'))
    roots.push(root)
    const first = new FileSessionOwnershipRegistry(root)
    const second = new FileSessionOwnershipRegistry(root)
    const sessionId = SessionId('release-drain')
    const ownership = await first.acquire(sessionId, SessionOwnerToken('first'))
    const started = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const mutation = first.guardMutation(sessionId, async () => {
      started.resolve(undefined)
      await finish.promise
    })
    let release: Promise<void> | undefined
    try {
      await started.promise
      release = ownership.release()
      expect(ownership.active).toBe(false)
      await expect(second.acquire(sessionId, SessionOwnerToken('too-early')))
        .rejects.toBeInstanceOf(SessionOwnershipConflictError)

      finish.resolve(undefined)
      await mutation
      await release
      const successor = await second.acquire(sessionId, SessionOwnerToken('successor'))
      expect(successor.active).toBe(true)
      await successor.release()
    } finally {
      finish.resolve(undefined)
      await Promise.allSettled([mutation, release ?? ownership.release()])
      await Promise.allSettled([first.close(), second.close()])
    }
  })
})
