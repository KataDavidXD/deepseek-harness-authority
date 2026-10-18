/**
 * Process helpers shared by the release scripts: the release steps drive `git`,
 * `pnpm`, `npm`, and `tar`, and each needs one of three failure behaviours.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Where and with what environment a release step runs a command. */
export interface RunOptions {
  /** Working directory; defaults to the current one. */
  readonly cwd?: string
  /** Child environment; defaults to this process's. */
  readonly env?: NodeJS.ProcessEnv
}

/** What a command produced, for a caller that decides what a failure means. */
export interface CommandResult {
  /** Exit status, or null when a signal ended the process. */
  readonly status: number | null
  /** Captured standard output. */
  readonly stdout: string
  /** Captured standard error. */
  readonly stderr: string
}

/** Injectable host facts for deterministic command-resolution tests. */
export interface CommandResolutionContext {
  /** Host platform; defaults to the current process platform. */
  readonly platform?: NodeJS.Platform
  /** Node executable used to run JavaScript package-manager entries. */
  readonly execPath?: string
  /** Environment that supplies npm_execpath, PNPM_HOME, and PATH. */
  readonly env?: NodeJS.ProcessEnv
  /** File probe; defaults to the real filesystem. */
  readonly pathExists?: (path: string) => boolean
}

/** One executable and argument vector safe to pass to child_process. */
export interface CommandInvocation {
  readonly command: string
  readonly args: readonly string[]
}

/** Candidate JavaScript entries for one package manager on Windows. */
function packageManagerEntries(
  manager: 'npm' | 'pnpm',
  execPath: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const candidates: string[] = []
  const npmExecPath = env.npm_execpath ?? env.NPM_EXECPATH
  if (npmExecPath !== undefined) {
    const name = win32.basename(npmExecPath).toLowerCase()
    if (manager === 'pnpm' ? name.includes('pnpm') : /^npm(?:-cli)?\.(?:c?js|mjs)$/.test(name)) {
      candidates.push(npmExecPath)
    }
  }

  const nodeDirectories = [win32.dirname(execPath), win32.resolve(win32.dirname(execPath), '..')]
  const pathDirectories = (env.Path ?? env.PATH ?? '').split(';').filter(Boolean)
  if (manager === 'pnpm') {
    if (env.PNPM_HOME !== undefined) {
      candidates.push(win32.join(env.PNPM_HOME, 'pnpm.cjs'), win32.join(env.PNPM_HOME, 'pnpm.mjs'))
    }
    for (const directory of [...nodeDirectories, ...pathDirectories]) {
      candidates.push(
        win32.join(directory, 'pnpm.cjs'),
        win32.join(directory, 'pnpm.mjs'),
        win32.join(directory, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
        win32.join(directory, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
        win32.join(directory, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
      )
    }
  } else {
    for (const directory of [...nodeDirectories, ...pathDirectories]) {
      candidates.push(win32.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    }
  }
  return [...new Set(candidates)]
}

/**
 * Resolve package-manager batch shims to JavaScript on Windows.
 *
 * Modern Node rejects spawning ``npm.cmd``/``pnpm.cmd`` without a shell. The
 * release helpers deliberately avoid a shell because tarball paths are data,
 * not command text, so they execute the manager's proven JavaScript entry with
 * the current Node executable instead. Native commands and non-Windows hosts
 * retain their original invocation.
 */
export function resolveCommand(
  command: string,
  args: readonly string[],
  context: CommandResolutionContext = {},
): CommandInvocation {
  const platform = context.platform ?? process.platform
  if (platform !== 'win32' || (command !== 'npm' && command !== 'pnpm')) return { command, args }

  const execPath = context.execPath ?? process.execPath
  const env = context.env ?? process.env
  const pathExists = context.pathExists ?? existsSync
  const entry = packageManagerEntries(command, execPath, env).find(pathExists)
  if (entry === undefined) {
    throw new Error(
      `release process: cannot locate ${command} JavaScript entry on Windows; run through ${command} or set its installation on PATH.`,
    )
  }
  return { command: execPath, args: [entry, ...args] }
}

/**
 * Run a command and capture its output without judging the exit status.
 * @param command - executable name.
 * @param args - command arguments.
 * @param options - working directory and environment.
 * @returns The exit status and captured streams.
 */
export function attempt(command: string, args: readonly string[], options: RunOptions = {}): CommandResult {
  const invocation = resolveCommand(command, args, { env: options.env ?? process.env })
  const result = spawnSync(invocation.command, [...invocation.args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/**
 * Run a command, capture its standard output, and fail on a non-zero exit.
 * @param command - executable name.
 * @param args - command arguments.
 * @param options - working directory and environment.
 * @returns The trimmed standard output.
 */
export function capture(command: string, args: readonly string[], options: RunOptions = {}): string {
  const result = attempt(command, args, options)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout.trim()
}

/**
 * Run a command with inherited streams, so its progress reaches the log, and
 * fail on a non-zero exit.
 * @param command - executable name.
 * @param args - command arguments.
 * @param options - working directory and environment.
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): void {
  const invocation = resolveCommand(command, args, { env: options.env ?? process.env })
  const result = spawnSync(invocation.command, [...invocation.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
}

/**
 * Whether this module is the process entry point.
 *
 * The release scripts are both commands and modules: a test imports their pure
 * logic, and importing a module runs its body, so an unguarded `main()` would
 * run the wrong command with the wrong arguments.
 * @param moduleUrl - the caller's `import.meta.url`.
 * @returns True when Node started this module.
 */
export function isEntry(moduleUrl: string): boolean {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  return realpathSync(invoked) === realpathSync(fileURLToPath(moduleUrl))
}
