/** Real deploy hermeticity, pre-publish launch, and publication acceptance. */

import { lstat, mkdtemp, readlink, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BuildCli, SingleExeBuild } from './build-exe-for-python-sdk.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const sourceRuntimePackage = join(root, 'python', 'sdk-runtime', 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek')
const eventSourceParser = join(root, 'packages', 'llm', 'llm-deepseek', 'node_modules', 'eventsource-parser')

interface DirectoryIdentity {
  readonly kind: 'directory' | 'symlink' | 'missing'
  readonly target?: string
}

const skippedWorkspaceDirectories = new Set(['.git', '.sessions', '.ruff_cache', 'dist-exe'])

/**
 * Snapshot every workspace-owned install tree without following package links
 * or descending into pnpm's immutable content-addressed virtual store.
 */
async function installTreeIdentity(): Promise<readonly string[]> {
  const installRoots: string[] = []
  async function discover(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || skippedWorkspaceDirectories.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.name === 'node_modules') {
        installRoots.push(path)
        continue
      }
      await discover(path)
    }
  }
  await discover(root)

  const records: string[] = []
  async function snapshot(path: string): Promise<void> {
    const metadata = await lstat(path, { bigint: true })
    const name = relative(root, path)
    if (metadata.isSymbolicLink()) {
      records.push(`link:${name}:${await readlink(path)}`)
      return
    }
    if (metadata.isDirectory()) {
      records.push(`dir:${name}`)
      if (path.endsWith(join('node_modules', '.pnpm'))) return
      for (const entry of await readdir(path)) await snapshot(join(path, entry))
      return
    }
    records.push(`file:${name}:${metadata.size}:${metadata.mtimeNs}`)
  }
  for (const path of installRoots.sort()) await snapshot(path)
  return records.sort()
}

async function identity(path: string): Promise<DirectoryIdentity> {
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return { kind: 'symlink', target: await readlink(path) }
    return { kind: 'directory' }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
}

describe('single-executable SDK deploy hermeticity', () => {
  it('preserves source installs, probes both node carriers, and publishes only after validation', { timeout: 120_000 }, async () => {
    const stagingParent = await mkdtemp(join(tmpdir(), 'dsh-build-hermeticity-'))
    const staging = join(stagingParent, 'staging-node')
    const published = join(stagingParent, 'published-node')
    const installTreeBefore = await installTreeIdentity()
    const before = {
      sourceRuntimePackage: await identity(sourceRuntimePackage),
      eventSourceParser: await identity(eventSourceParser),
    }
    const cli = BuildCli.parse(['--targets=node24-linux-x64', '--skip-build'])
    const pipeline = new SingleExeBuild(cli, { staging })

    try {
      await pipeline.deployStaging()
      await pipeline.injectPkgConfig()
      await pipeline.verifyNodeCarriers()

      expect(await installTreeIdentity()).toEqual(installTreeBefore)
      expect(await identity(sourceRuntimePackage)).toEqual(before.sourceRuntimePackage)
      expect(await identity(eventSourceParser)).toEqual(before.eventSourceParser)
      expect(await identity(join(staging, 'node_modules', 'eventsource-parser'))).not.toEqual({ kind: 'missing' })
      expect(await identity(join(staging, 'node_modules', '@deepseek-ai', 'cordis'))).toEqual({ kind: 'directory' })

      await pipeline.publishStaging(published)
      expect(await identity(staging)).toEqual({ kind: 'missing' })
      expect(await identity(join(published, 'node_modules', '@deepseek-ai', 'cordis'))).toEqual({ kind: 'directory' })
      await new SingleExeBuild(cli, { staging: published }).verifyNodeCarriers()
      expect(await installTreeIdentity()).toEqual(installTreeBefore)
    } finally {
      await rm(stagingParent, { recursive: true, force: true })
    }
  })
})
