import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

/** Serial build tests: the real deploy gate is intentionally resource-heavy. */
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    execArgv: vitestExecArgv,
    setupFiles: ['./scripts/test-invariants.ts'],
    include: [
      'scripts/build-exe-for-python-sdk.spec.ts',
      'scripts/build-exe-for-python-sdk.e2e.ts',
    ],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
})
