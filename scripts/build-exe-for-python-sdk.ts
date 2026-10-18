/**
 * Build the SDK runtime executables and Python node carrier. The fixed
 * `@yao-pkg/pkg --sea` route, deploy flags, and artifact layout are owned by
 * .agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md.
 * The staged closure is symlink-free, and whole-tree assets cover Cordis's
 * runtime imports that pkg cannot discover statically.
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')

/** The closure manifest whose dependencies define the executable. */
const DEPLOY_ROOT_PACKAGE = 'dsh-jsonrpc-agent-pkg'
/** The closed-runtime app entry inside the deployed closure. */
const ENTRY_BIN = 'node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js'
const OUTPUT_BASENAME = 'dsh-jsonrpc-agent-pkg'
/** Default Node major; SEA mode requires at least Node 22. */
const DEFAULT_NODE_RANGE = 'node24'
/** Pinned for reproducible builds. */
const PKG_SPEC = '@yao-pkg/pkg@6.21.0'
const OUT_DIR = 'dist-exe'
/** Python package destination; created when absent. */
const PYTHON_RUNTIME_DIR = 'python/sdk-runtime/src/deepseek_harness_runtime/runtime'
/** The deployed closure doubles as the node-mode carrier. */
const PYTHON_NODE_SUBDIR = 'node'
const FINAL_NODE_CARRIER = resolve(root, PYTHON_RUNTIME_DIR, PYTHON_NODE_SUBDIR)
const DEFAULT_CORDIS_CONFIG = resolve(root, PYTHON_RUNTIME_DIR, 'cordis.yml')
const SOURCE_JSONRPC_BIN = resolve(root, 'packages/examples/jsonrpc-demo/src/bin.ts')
/** Documentation excluded from the generated runtime directory. */
const DEPLOY_ONLY_DOCS = ['README.md', 'README.zh.md', 'README.i18n.yaml']

/**
 * Whole-tree assets cover Cordis's runtime bare-package imports, which pkg's
 * static analysis cannot see. Package manifests are explicit because bare-name
 * resolution depends on them.
 */
const ASSET_GLOBS = [
  'package.json',
  'node_modules/**/*.js',
  'node_modules/**/*.cjs',
  'node_modules/**/*.mjs',
  'node_modules/**/package.json',
  'node_modules/**/*.json',
  'node_modules/**/*.node',
  'node_modules/**/*.wasm',
]

const PLATFORMS = ['linux', 'macos'] as const
const ARCHES = ['x64', 'arm64'] as const
type Platform = (typeof PLATFORMS)[number]
type Arch = (typeof ARCHES)[number]

function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value)
}

function isArch(value: string): value is Arch {
  return (ARCHES as readonly string[]).includes(value)
}

/**
 * A parsed pkg target triple, constructed from `--targets` or the host.
 */
export class Target {
  private constructor(
    /** pkg Node range (`node<major>`). */
    readonly nodeRange: string,
    /**
     * pkg platform tag. Windows is a documented non-goal
     * (.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md).
     */
    readonly platform: Platform,
    /** pkg CPU tag. */
    readonly arch: Arch,
  ) {}

  /** The pkg `--targets` spec string `<nodeRange>-<platform>-<arch>`. */
  get spec(): string {
    return `${this.nodeRange}-${this.platform}-${this.arch}`
  }

  /**
   * Parse one target spec, rejecting malformed triples and unsupported platform or architecture.
   * @param spec - the raw triple, e.g. `node24-linux-x64`.
   * @returns the parsed target.
   */
  static parse(spec: string): Target {
    const parts = spec.split('-')
    const [nodeRange, platform, arch] = parts
    if (parts.length !== 3 || nodeRange === undefined || platform === undefined || arch === undefined) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)} must be <nodeRange>-<platform>-<arch>, e.g. node24-linux-x64.`)
    }
    if (!/^node\d+$/.test(nodeRange)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: node range must look like node24, got ${JSON.stringify(nodeRange)}.`)
    }
    if (!isPlatform(platform)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: platform must be one of ${PLATFORMS.join(', ')}, got ${JSON.stringify(platform)}.`)
    }
    if (!isArch(arch)) {
      throw new Error(`build-exe-for-python-sdk: target ${JSON.stringify(spec)}: arch must be one of ${ARCHES.join(', ')}, got ${JSON.stringify(arch)}.`)
    }
    return new Target(nodeRange, platform, arch)
  }

  /**
   * Resolve the host-platform default on Node 24.
   * @returns the host target; throws on an unsupported host platform or arch.
   */
  static host(): Target {
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : undefined
    if (platform === undefined) {
      throw new Error(`build-exe-for-python-sdk: unsupported host platform ${process.platform}; pass --targets explicitly.`)
    }
    const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined
    if (arch === undefined) {
      throw new Error(`build-exe-for-python-sdk: unsupported host arch ${process.arch}; pass --targets explicitly.`)
    }
    return new Target(DEFAULT_NODE_RANGE, platform, arch)
  }
}

/**
 * Validated CLI configuration; construction owns help and parse-error exits.
 */
export class BuildCli {
  private constructor(
    /** Build targets; defaults to the host platform only. */
    readonly targets: readonly Target[],
    /** Skip step 1 (`pnpm run build`); lib/ artifacts must already exist. */
    readonly skipBuild: boolean,
    /** Print every command and config patch instead of executing. */
    readonly dryRun: boolean,
  ) {}

  /**
   * Parse argv. Help exits 0; malformed flags exit 1; invalid or colliding
   * targets throw.
   * @param argv - the raw arguments (`process.argv.slice(2)`).
   * @returns the parsed, validated configuration.
   */
  static parse(argv: string[]): BuildCli {
    let values: ReturnType<typeof BuildCli.parseRaw>
    try {
      values = BuildCli.parseRaw(argv)
    } catch (error) {
      console.error(`build-exe-for-python-sdk: ${error instanceof Error ? error.message : String(error)}\n`)
      console.error(BuildCli.usage())
      process.exit(1)
    }
    if (values.help) {
      console.log(BuildCli.usage())
      process.exit(0)
    }
    const targets = values.targets === undefined
      ? [Target.host()]
      : values.targets.split(',').map(part => part.trim()).filter(part => part !== '').map(spec => Target.parse(spec))
    if (targets.length === 0) throw new Error('build-exe-for-python-sdk: --targets is empty.')
    const seen = new Set<string>()
    for (const target of targets) {
      const key = `${target.platform}-${target.arch}`
      if (seen.has(key)) {
        throw new Error(`build-exe-for-python-sdk: duplicate platform-arch ${key} in --targets; canonical product names would collide.`)
      }
      seen.add(key)
    }
    return new BuildCli(targets, values['skip-build'], values['dry-run'])
  }

  private static parseRaw(argv: string[]) {
    return parseArgs({
      args: argv,
      options: {
        'targets': { type: 'string' },
        'skip-build': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'help': { type: 'boolean', default: false },
      },
    }).values
  }

  private static usage(): string {
    return [
      'Usage: pnpm exec tsx scripts/build-exe-for-python-sdk.ts [flags]',
      '',
      '  --targets=<t1,t2,...>  pkg targets, e.g. node24-linux-x64,node24-linux-arm64,node24-macos-arm64.',
      '                         Default: the host platform only (on node24).',
      '  --skip-build           skip `pnpm run build` (lib/ artifacts must already exist).',
      '  --dry-run              print every command and config patch without executing.',
      '  --help                 print this help.',
      '',
      `Build route: ${PKG_SPEC} --sea; see .agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md.`,
      `Stages the node carrier in ${PYTHON_RUNTIME_DIR}/${PYTHON_NODE_SUBDIR} and writes executables to ${OUT_DIR}/.`,
    ].join('\n')
  }
}

function pnpmInvocation(args: string[]): readonly [command: string, args: string[]] {
  if (process.platform !== 'win32') return ['pnpm', args]
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath !== undefined && existsSync(npmExecPath) && basename(npmExecPath).toLowerCase().includes('pnpm')) {
    return [process.execPath, [npmExecPath, ...args]]
  }
  const corepackPnpm = join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'pnpm.js')
  if (existsSync(corepackPnpm)) return [process.execPath, [corepackPnpm, ...args]]
  throw new Error(
    'build-exe-for-python-sdk: cannot locate pnpm\'s JavaScript entry on Windows; run this script through pnpm.',
  )
}

/**
 * Render a command for logs and errors, quoting arguments with spaces.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns the printable command line.
 */
function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/**
 * Sequential build pipeline. Subprocesses inherit stdio and errors include
 * the command; dry runs print commands and filesystem changes.
 */
export interface SingleExeBuildLayout {
  /** Isolated deploy target; never point this at the published node carrier. */
  readonly staging: string
  /** Override the executable output directory for isolated verification. */
  readonly outDir?: string
}

export interface NodeCarrierPublishOperations {
  /** Rename one directory on the destination volume. Injectable for rollback tests. */
  move(source: string, destination: string): Promise<void>
}

const nodeCarrierPublishOperations: NodeCarrierPublishOperations = { move: rename }

/**
 * Promote a completed node carrier with exception-safe rollback of the prior
 * carrier. A rollback failure preserves the backup directory for recovery.
 */
export async function publishNodeCarrier(
  staging: string,
  destination: string,
  operations: NodeCarrierPublishOperations = nodeCarrierPublishOperations,
): Promise<void> {
  const source = resolve(staging)
  const target = resolve(destination)
  if (source === target) throw new Error('build-exe-for-python-sdk: staging and published node carrier must differ.')
  const sourceMetadata = await lstat(source)
  if (!sourceMetadata.isDirectory()) throw new Error(`build-exe-for-python-sdk: node carrier staging is not a directory: ${source}.`)
  const parent = dirname(target)
  await mkdir(parent, { recursive: true })
  const backupRoot = await mkdtemp(join(parent, '.dsh-node-backup-'))
  const backup = join(backupRoot, PYTHON_NODE_SUBDIR)
  const hadPrevious = existsSync(target)
  try {
    if (hadPrevious) await operations.move(target, backup)
  } catch (backupError: unknown) {
    await rm(backupRoot, { recursive: true, force: true })
    throw backupError
  }
  try {
    await operations.move(source, target)
  } catch (publishError: unknown) {
    if (hadPrevious) {
      try {
        if (existsSync(target)) {
          throw new Error(`publish target was recreated concurrently: ${target}`)
        }
        await operations.move(backup, target)
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [publishError, rollbackError],
          `build-exe-for-python-sdk: node carrier publish failed and rollback failed; prior carrier remains at ${backup}.`,
        )
      }
    }
    await rm(backupRoot, { recursive: true, force: true })
    throw publishError
  }
  await rm(backupRoot, { recursive: true, force: true })
}

export class SingleExeBuild {
  /**
   * The cleared deploy target, pkg input, and Python node-mode carrier. The
   * checked-in default `cordis.yml` remains in its parent directory.
   */
  readonly staging: string
  private readonly outDir: string

  constructor(private readonly cli: BuildCli, layout: SingleExeBuildLayout) {
    this.staging = layout.staging
    this.outDir = layout.outDir ?? resolve(root, OUT_DIR)
  }

  /** Verify the closure before compiling or packaging. */
  async verifyClosure(): Promise<void> {
    await this.runPnpm('runtime dependency closure', ['run', 'verify-runtime-closure'])
  }

  /** Build all package artifacts unless `--skip-build` was passed. */
  async build(): Promise<void> {
    if (this.cli.skipBuild) {
      console.log('build-exe-for-python-sdk: skipping pnpm run build (--skip-build)')
      return
    }
    await this.runPnpm('build', ['run', 'build'])
  }

  /** Clear and deploy the runtime closure into the node carrier. */
  async deployStaging(): Promise<void> {
    if (this.staging === root || root.startsWith(this.staging + sep)) {
      throw new Error(`build-exe-for-python-sdk: refusing to clear staging dir ${this.staging}: it contains the repo root.`)
    }
    if (this.cli.dryRun) console.log(`build-exe-for-python-sdk: [dry-run] rm -rf ${this.staging}`)
    else await rm(this.staging, { recursive: true, force: true })
    await this.runPnpm('deploy', [
      '--filter',
      DEPLOY_ROOT_PACKAGE,
      'deploy',
      '--prod',
      '--config.inject-workspace-packages=true',
      '--config.node-linker=hoisted',
      this.staging,
    ])
    await this.run('subprocess helper mode', process.execPath, [
      join(
        this.staging,
        'node_modules',
        '@deepseek-ai',
        'dsh-subprocess-local',
        'scripts',
        'ensure-spawn-helper.mjs',
      ),
    ])
    await this.materializeStagedLinks()
    await this.verifyStagedTopology()
    await this.runPnpm('staged peer graph', ['--dir', this.staging, 'peers', 'check'])
    if (this.cli.dryRun) {
      for (const name of DEPLOY_ONLY_DOCS) console.log(`build-exe-for-python-sdk: [dry-run] rm -f ${join(this.staging, name)}`)
    } else {
      await Promise.all(DEPLOY_ONLY_DOCS.map(name => rm(join(this.staging, name), { force: true })))
    }
  }

  /** Replace deploy-time package links with files and reject any remaining link. */
  private async materializeStagedLinks(): Promise<void> {
    if (this.cli.dryRun) {
      console.log('build-exe-for-python-sdk: [dry-run] materialize staged package links')
      return
    }
    const nodeModules = join(this.staging, 'node_modules')
    let remaining = await this.findSymlink(nodeModules)
    while (remaining !== undefined) {
      const segments = remaining.slice(nodeModules.length + 1).split(sep)
      const binIndex = segments.lastIndexOf('.bin')
      if (binIndex >= 0) {
        await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
        remaining = await this.findSymlink(nodeModules)
        continue
      }
      const destination = remaining
      const source = await realpath(destination)
      const nestedNodeModules = join(source, 'node_modules')
      await rm(destination, { recursive: true, force: true })
      await cp(source, destination, {
        recursive: true,
        dereference: true,
        filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
      })
      remaining = await this.findSymlink(nodeModules)
    }
  }

  /** Return the first symbolic link below a directory, if one exists. */
  private async findSymlink(directory: string): Promise<string | undefined> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) return path
      if (metadata.isDirectory()) {
        const nested = await this.findSymlink(path)
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }

  /** Reject split Cordis identity or any link that escaped materialization. */
  private async verifyStagedTopology(): Promise<void> {
    if (this.cli.dryRun) {
      console.log('build-exe-for-python-sdk: [dry-run] verify one physical Cordis and no staged links')
      return
    }
    const nodeModules = join(this.staging, 'node_modules')
    const cordisInstances: string[] = []
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        const metadata = await lstat(path)
        if (metadata.isSymbolicLink()) {
          throw new Error(`build-exe-for-python-sdk: staged dependency link remained after materialization: ${path}.`)
        }
        if (!metadata.isDirectory()) continue
        if (
          entry.name === 'cordis'
          && basename(dirname(path)) === '@deepseek-ai'
          && basename(dirname(dirname(path))) === 'node_modules'
        ) cordisInstances.push(path)
        await walk(path)
      }
    }
    await walk(nodeModules)
    if (cordisInstances.length !== 1) {
      throw new Error(
        'build-exe-for-python-sdk: expected exactly one physical @deepseek-ai/cordis instance; '
        + `found ${cordisInstances.length}: ${cordisInstances.join(', ')}.`,
      )
    }
  }

  /** Add the executable entry and pkg assets to the staged manifest. */
  async injectPkgConfig(): Promise<void> {
    const patch = { bin: ENTRY_BIN, pkg: { assets: ASSET_GLOBS } }
    const manifestPath = join(this.staging, 'package.json')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] patch ${manifestPath} with ${JSON.stringify(patch)}`)
      return
    }
    if (!existsSync(manifestPath)) {
      throw new Error(`build-exe-for-python-sdk: ${manifestPath} missing — pnpm deploy did not produce a staged package.`)
    }
    if (!existsSync(join(this.staging, ENTRY_BIN))) {
      throw new Error(`build-exe-for-python-sdk: ${join(this.staging, ENTRY_BIN)} missing — run without --skip-build so lib/ artifacts exist.`)
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, ...patch }, null, 2)}\n`)
    console.log(`build-exe-for-python-sdk: injected pkg config into ${manifestPath}`)
  }

  /** Start the source bin and staged node carrier before publishing either artifact. */
  async verifyNodeCarriers(): Promise<void> {
    const stagedEntry = join(this.staging, ENTRY_BIN)
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] probe source carrier ${SOURCE_JSONRPC_BIN}`)
      console.log(`build-exe-for-python-sdk: [dry-run] probe staged node carrier ${stagedEntry}`)
      return
    }
    const probeRoot = await mkdtemp(join(dirname(this.staging), '.dsh-carrier-probe-'))
    const cwd = join(probeRoot, 'cwd')
    const sessions = join(probeRoot, 'sessions')
    await mkdir(cwd, { recursive: true })
    await mkdir(sessions, { recursive: true })
    try {
      await this.probeCarrier('source carrier', ['--import', 'tsx', SOURCE_JSONRPC_BIN, DEFAULT_CORDIS_CONFIG], cwd, sessions)
      await this.probeCarrier('staged node carrier', [stagedEntry, DEFAULT_CORDIS_CONFIG], cwd, sessions)
    } finally {
      await rm(probeRoot, { recursive: true, force: true })
    }
  }

  /** Publish only after every build and launch gate has passed. */
  async publishStaging(destination: string): Promise<void> {
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] promote ${this.staging} to ${destination} with rollback`)
      return
    }
    await publishNodeCarrier(this.staging, destination)
    console.log(`build-exe-for-python-sdk: published node carrier ${destination}`)
  }

  /** Drive one carrier through sequential initialize/shutdown over real stdio JSON-RPC. */
  private async probeCarrier(label: string, args: string[], cwd: string, sessions: string): Promise<void> {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: {
        ...process.env,
        CI: 'true',
        DEEPSEEK_API_KEY: 'build-carrier-probe-no-secret',
        DSH_CWD: cwd,
        DSH_SESSION_ROOT: sessions,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const frames: Array<{ id?: unknown; error?: { code?: unknown; message?: unknown } }> = []
    let stdoutBuffer = ''
    let stderr = ''
    let parseError: Error | undefined
    let processError: Error | undefined
    let exited = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === '') continue
        try {
          frames.push(JSON.parse(line) as { id?: unknown; error?: { code?: unknown; message?: unknown } })
        } catch (error: unknown) {
          parseError = new Error(`invalid JSON-RPC stdout from ${label}: ${line}`, { cause: error })
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      child.once('error', (error) => {
        processError = error
        exited = true
        resolvePromise({ code: null, signal: null })
      })
      child.once('exit', (code, signal) => {
        exited = true
        resolvePromise({ code, signal })
      })
    })
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    const request = async (id: string, method: string, params?: Record<string, unknown>): Promise<void> => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
      const deadline = Date.now() + 30_000
      for (;;) {
        if (processError !== undefined) throw new Error(`${label} failed to spawn`, { cause: processError })
        if (parseError !== undefined) throw parseError
        const index = frames.findIndex(frame => frame.id === id)
        if (index >= 0) {
          const [frame] = frames.splice(index, 1)
          if (frame?.error !== undefined) {
            throw new Error(`${label} ${method} failed (${String(frame.error.code)}): ${String(frame.error.message)}`)
          }
          return
        }
        if (exited) throw new Error(`${label} exited before ${id}; stderr=${stderr}`)
        if (Date.now() >= deadline) throw new Error(`${label} timed out waiting for ${id}; stderr=${stderr}`)
        await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
      }
    }
    try {
      await request('initialize', 'initialize', {
        cwd,
        provider: 'deepseek-official',
        model: 'build-carrier-probe-no-call',
      })
      await request('shutdown', 'shutdown')
      child.stdin.end()
      const result = await exit
      if (result.code !== 0) {
        const cause = result.code === null ? `signal ${result.signal ?? 'unknown'}` : `exit code ${result.code}`
        throw new Error(`build-exe-for-python-sdk: ${label} failed (${cause}); stderr=${stderr}`)
      }
      console.log(`build-exe-for-python-sdk: ${label} initialize/shutdown passed`)
    } finally {
      clearTimeout(killer)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exit
      }
    }
  }

  /**
   * Package one target; SEA mode accepts one target per invocation.
   * @param target - the pkg target triple to build.
   * @returns the executable path and, on macOS, its helper path.
   */
  async pack(target: Target): Promise<string[]> {
    const product = join(this.outDir, `${OUTPUT_BASENAME}-${target.platform}-${target.arch}`)
    await this.prepareNativePty(target)
    if (!this.cli.dryRun) await mkdir(this.outDir, { recursive: true })
    await this.runPnpm(`pkg ${target.spec}`, [
      'dlx',
      PKG_SPEC,
      this.staging,
      '--sea',
      '--targets',
      target.spec,
      '--output',
      product,
    ])
    if (!this.cli.dryRun && !existsSync(product)) {
      throw new Error(`build-exe-for-python-sdk: product ${product} is missing after the pkg run; inspect ${this.outDir}.`)
    }
    if (target.platform !== 'macos') return [product]
    const spawnHelper = `${product}-spawn-helper`
    const source = join(this.staging, 'node_modules', 'node-pty', 'prebuilds', `darwin-${target.arch}`, 'spawn-helper')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] cp ${source} ${spawnHelper}`)
    } else {
      await copyFile(source, spawnHelper)
      await chmod(spawnHelper, 0o755)
    }
    return [product, spawnHelper]
  }

  /**
   * Put the target node-pty addon in the staged closure. Linux npm installs
   * build it from source, but legacy deploy omits that side-effect directory.
   * @param target - the pkg target whose native addon is being staged.
   */
  private async prepareNativePty(target: Target): Promise<void> {
    const stagedBuild = join(this.staging, 'node_modules', 'node-pty', 'build')
    if (this.cli.dryRun) console.log(`build-exe-for-python-sdk: [dry-run] rm -rf ${stagedBuild}`)
    else await rm(stagedBuild, { recursive: true, force: true })
    if (target.platform !== 'linux') return
    const source = join(root, 'packages', 'subprocess', 'subprocess-local', 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
    const destination = join(stagedBuild, 'Release', 'pty.node')
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] cp ${source} ${destination}`)
      return
    }
    const host = Target.host()
    if (target.platform !== host.platform || target.arch !== host.arch) {
      throw new Error(
        'build-exe-for-python-sdk: build the Linux runtime on its target architecture; '
        + `target ${target.platform}-${target.arch} does not match host ${host.platform}-${host.arch}.`,
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
  }

  /**
   * Print each product path and, outside dry-run mode, its size.
   * @param products - the product paths returned by {@link pack}.
   */
  printProducts(products: string[]): void {
    console.log(this.cli.dryRun ? 'build-exe-for-python-sdk: [dry-run] would produce:' : 'build-exe-for-python-sdk: products:')
    for (const path of products) {
      if (this.cli.dryRun) {
        console.log(`  ${path}`)
        continue
      }
      const megabytes = statSync(path).size / (1024 * 1024)
      console.log(`  ${path}  (${megabytes.toFixed(1)} MB)`)
    }
  }

  /**
   * Copy each product into the Python runtime package. The deployed node
   * carrier is already in place, and `dist-exe/` retains upload copies.
   * @param products - the product paths returned by {@link pack}.
   */
  async syncToPythonRuntime(products: string[]): Promise<void> {
    const destDir = resolve(root, PYTHON_RUNTIME_DIR)
    if (this.cli.dryRun) {
      for (const path of products) {
        console.log(`build-exe-for-python-sdk: [dry-run] cp ${path} ${join(destDir, basename(path))}`)
      }
      return
    }
    await mkdir(destDir, { recursive: true })
    for (const path of products) {
      const destination = join(destDir, basename(path))
      await copyFile(path, destination)
      await chmod(destination, statSync(path).mode & 0o777)
      console.log(`build-exe-for-python-sdk: synced ${destination}`)
    }
  }

  /**
   * Run one subprocess with inherited stdio. Spawn and non-zero-exit errors
   * include the command; dry runs only print it.
   * @param label - the step name used in logs and error messages.
   * @param command - the executable.
   * @param args - its arguments.
   */
  private async run(label: string, command: string, args: string[]): Promise<void> {
    const printable = formatCommand(command, args)
    if (this.cli.dryRun) {
      console.log(`build-exe-for-python-sdk: [dry-run] ${printable}`)
      return
    }
    console.log(`build-exe-for-python-sdk: ${label}: ${printable}`)
    await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(command, args, {
        cwd: root,
        stdio: 'inherit',
        // Artifact builds must not mutate or validate a developer's Git hooks.
        env: { ...process.env, CI: 'true' },
      })
      child.once('error', (error) => {
        reject(new Error(`build-exe-for-python-sdk: ${label} failed to spawn: ${error.message} (${printable})`))
      })
      child.once('exit', (code, signal) => {
        if (code === 0) {
          resolvePromise()
          return
        }
        const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
        reject(new Error(`build-exe-for-python-sdk: ${label} failed (${cause}): ${printable}`))
      })
    })
  }

  /** Run pnpm through its JavaScript entry on Windows, where batch spawning is rejected by Node. */
  private async runPnpm(label: string, args: string[]): Promise<void> {
    const [command, invocationArgs] = pnpmInvocation(args)
    await this.run(label, command, invocationArgs)
  }
}

async function main(): Promise<void> {
  const cli = BuildCli.parse(process.argv.slice(2))
  const carrierParent = dirname(FINAL_NODE_CARRIER)
  if (!cli.dryRun) await mkdir(carrierParent, { recursive: true })
  const buildRoot = cli.dryRun
    ? join(carrierParent, '.dsh-node-build-<temporary>')
    : await mkdtemp(join(carrierParent, '.dsh-node-build-'))
  const pipeline = new SingleExeBuild(cli, { staging: join(buildRoot, PYTHON_NODE_SUBDIR) })
  console.log(`build-exe-for-python-sdk: targets: ${cli.targets.map(target => target.spec).join(', ')}`)
  console.log(`build-exe-for-python-sdk: staging: ${pipeline.staging}`)
  try {
    await pipeline.verifyClosure()
    await pipeline.build()
    await pipeline.deployStaging()
    await pipeline.injectPkgConfig()
    await pipeline.verifyNodeCarriers()
    const products: string[] = []
    for (const target of cli.targets) products.push(...await pipeline.pack(target))
    pipeline.printProducts(products)
    await pipeline.publishStaging(FINAL_NODE_CARRIER)
    await pipeline.syncToPythonRuntime(products)
  } finally {
    if (!cli.dryRun) await rm(buildRoot, { recursive: true, force: true })
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) await main()
