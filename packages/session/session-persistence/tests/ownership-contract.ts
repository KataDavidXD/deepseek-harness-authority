/**
 * Shared cross-provider ownership contract for durable session writers.
 *
 * Each fixture mounts two real persistence providers over one storage scope so
 * every assertion crosses provider-instance state rather than a process-local
 * coordinator map.
 * @module @deepseek-ai/dsh-session-persistence/tests/ownership-contract
 */

import { describe, expect, it } from 'vitest'
import type { SessionPersistence } from '../src/index.ts'
import {
  SessionOwnerToken,
  SessionOwnershipConflictError,
} from '../src/index.ts'
import { meta, oneTurnLog } from './contract.ts'

/** Two independently mounted providers over one durable storage scope. */
export interface OwnershipContractFixture {
  /** First provider instance. */
  readonly first: SessionPersistence
  /** Second provider instance. */
  readonly second: SessionPersistence
  /** Dispose both instances and their shared temporary storage. */
  readonly dispose: () => Promise<void>
}

/**
 * Run the backend-independent ownership, fencing, and guarded-mutation suite.
 * @param name - backend label included in the test suite name.
 * @param make - fresh pair of providers sharing one storage scope.
 */
export function runOwnershipContract(
  name: string,
  make: () => Promise<OwnershipContractFixture>,
): void {
  describe(`SessionPersistence ownership contract: ${name}`, () => {
    it('admits one owner, preserves the marker, and advances the fence after release', async () => {
      const fixture = await make()
      const id = meta('ownership-exclusive').id
      try {
        expect(fixture.first.supportsOwnership).toBe(true)
        expect(fixture.second.supportsOwnership).toBe(true)
        const first = await fixture.first.acquireOwnership(id, SessionOwnerToken('owner-first'))
        expect(first.active).toBe(true)
        first.assertActive()
        expect(await fixture.first.acquireOwnership(id, SessionOwnerToken('owner-first'))).toBe(first)

        await expect(fixture.second.acquireOwnership(id, SessionOwnerToken('owner-second')))
          .rejects.toBeInstanceOf(SessionOwnershipConflictError)

        await first.release()
        expect(first.active).toBe(false)
        expect(() => { first.assertActive() }).toThrow(/no longer active/)

        const second = await fixture.second.acquireOwnership(id, SessionOwnerToken('owner-second'))
        expect(BigInt(second.fencingToken)).toBeGreaterThan(BigInt(first.fencingToken))
        await second.release()
        await second.release()
      } finally {
        await fixture.dispose()
      }
    })

    it('requires a current local owner for every later append once ownership was enabled', async () => {
      const fixture = await make()
      const header = meta('ownership-append')
      try {
        await fixture.first.create(header)
        await fixture.first.append(header.id, oneTurnLog())

        const first = await fixture.first.acquireOwnership(header.id, SessionOwnerToken('append-first'))
        await first.release()

        const continuation = [
          { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
          { type: 'turn/end', seq: 7, time: 8, data: { turn: 2, reason: { kind: 'completed' as const } } },
        ] as const
        await expect(fixture.first.append(header.id, continuation))
          .rejects.toThrow(/requires an active ownership/)
        await expect(fixture.second.append(header.id, continuation))
          .rejects.toThrow(/requires an active ownership/)

        const second = await fixture.second.acquireOwnership(header.id, SessionOwnerToken('append-second'))
        await fixture.second.append(header.id, continuation)
        await second.release()
        expect((await fixture.second.inspect(header.id)).events.map(event => event.seq))
          .toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      } finally {
        await fixture.dispose()
      }
    })

    it('requires ownership for mutating crash repair after the marker exists', async () => {
      const fixture = await make()
      const header = meta('ownership-repair')
      try {
        await fixture.first.create(header)
        await fixture.first.append(header.id, [
          { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
          { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
        ])
        const first = await fixture.first.acquireOwnership(header.id, SessionOwnerToken('repair-first'))
        await first.release()

        await expect(fixture.second.load(header.id))
          .rejects.toThrow(/requires an active ownership/)

        const second = await fixture.second.acquireOwnership(header.id, SessionOwnerToken('repair-second'))
        const repaired = await fixture.second.load(header.id)
        expect(repaired.events.at(-1)).toMatchObject({
          type: 'turn/end',
          data: { reason: { kind: 'interrupted' } },
        })
        await second.release()
      } finally {
        await fixture.dispose()
      }
    })

    it('does not serialize different session identities behind one ownership lock', async () => {
      const fixture = await make()
      try {
        const [first, second] = await Promise.all([
          fixture.first.acquireOwnership(meta('ownership-left').id, SessionOwnerToken('left-owner')),
          fixture.second.acquireOwnership(meta('ownership-right').id, SessionOwnerToken('right-owner')),
        ])
        expect(first.active).toBe(true)
        expect(second.active).toBe(true)
        await Promise.all([first.release(), second.release()])
      } finally {
        await fixture.dispose()
      }
    })
  })
}
