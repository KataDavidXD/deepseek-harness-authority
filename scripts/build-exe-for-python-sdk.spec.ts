/** Fast contract tests for the SDK runtime deploy command. */

import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuildCli, publishNodeCarrier, SingleExeBuild } from './build-exe-for-python-sdk.ts'

describe('single-executable SDK deploy command', () => {
  afterEach(() => vi.restoreAllMocks())

  it('uses modern injected deployment and never opts into legacy workspace mutation', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => logs.push(parts.map(String).join(' ')))
    const cli = BuildCli.parse(['--targets=node24-linux-x64', '--skip-build', '--dry-run'])
    const pipeline = new SingleExeBuild(cli, { staging: join(tmpdir(), 'dsh-modern-deploy-contract') })

    await pipeline.deployStaging()

    const command = logs.find(line => line.includes(' deploy '))
    expect(command).toBeDefined()
    expect(command).toContain('--config.inject-workspace-packages=true')
    expect(command).toContain('--config.node-linker=hoisted')
    expect(command).not.toContain('--legacy')
    expect(command).not.toContain('--config.auto-install-peers=false')
  })

  it('restores the previous carrier when publication cannot promote staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-node-publish-rollback-'))
    const staging = join(root, 'staging')
    const destination = join(root, 'destination')
    await mkdir(staging)
    await mkdir(destination)
    await writeFile(join(staging, 'marker'), 'new')
    await writeFile(join(destination, 'marker'), 'old')
    let moves = 0
    try {
      await expect(publishNodeCarrier(staging, destination, {
        async move(source, target) {
          moves += 1
          if (moves === 2) throw new Error('simulated promotion failure')
          await rename(source, target)
        },
      })).rejects.toThrow('simulated promotion failure')

      expect(await readFile(join(destination, 'marker'), 'utf8')).toBe('old')
      expect(await readFile(join(staging, 'marker'), 'utf8')).toBe('new')
      expect((await readdir(root)).sort()).toEqual(['destination', 'staging'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
