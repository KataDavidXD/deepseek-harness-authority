import { describe, expect, it } from 'vitest'
import { resolveCommand } from './process.ts'

describe('release command resolution', () => {
  it('runs pnpm through its JavaScript entry on Windows', () => {
    const entry = 'C:\\tools\\pnpm\\pnpm.mjs'

    expect(resolveCommand('pnpm', ['pack'], {
      platform: 'win32',
      execPath: 'C:\\node\\node.exe',
      env: { npm_execpath: entry },
      pathExists: path => path === entry,
    })).toEqual({ command: 'C:\\node\\node.exe', args: [entry, 'pack'] })
  })

  it('finds npm beside a Windows PATH entry without invoking a batch shim', () => {
    const entry = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'

    expect(resolveCommand('npm', ['install'], {
      platform: 'win32',
      execPath: 'C:\\node\\node.exe',
      env: { PATH: 'C:\\tools;C:\\Program Files\\nodejs' },
      pathExists: path => path === entry,
    })).toEqual({ command: 'C:\\node\\node.exe', args: [entry, 'install'] })
  })

  it('leaves native commands and non-Windows package managers unchanged', () => {
    expect(resolveCommand('git', ['status'], {
      platform: 'win32',
      execPath: 'C:\\node\\node.exe',
      env: {},
      pathExists: () => false,
    })).toEqual({ command: 'git', args: ['status'] })
    expect(resolveCommand('pnpm', ['pack'], {
      platform: 'linux',
      execPath: '/usr/bin/node',
      env: {},
      pathExists: () => false,
    })).toEqual({ command: 'pnpm', args: ['pack'] })
  })

  it('fails closed when a Windows package-manager entry cannot be proven', () => {
    expect(() => resolveCommand('pnpm', ['pack'], {
      platform: 'win32',
      execPath: 'C:\\node\\node.exe',
      env: {},
      pathExists: () => false,
    })).toThrow('cannot locate pnpm JavaScript entry on Windows')
  })
})
