/**
 * Black-box helper that intentionally exits without releasing a JSONL session
 * ownership. The parent test terminates this process to prove that the kernel,
 * rather than a cooperative cleanup callback, releases the advisory lock.
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SessionOwnerToken } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const root = process.argv[2]
if (root === undefined) throw new Error('ownership-child requires a JSONL root argument')

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
const ownership = await ctx.sessionPersistence.acquireOwnership(
  SessionId('ownership-child-crash'),
  SessionOwnerToken('child-process'),
)

process.stdout.write(`READY ${ownership.fencingToken}\n`)

// Deliberately do not dispose the plugin or ownership. SIGKILL/TerminateProcess
// must close the OS handle/descriptor and make the guard acquirable again.
setInterval(() => undefined, 60_000)
