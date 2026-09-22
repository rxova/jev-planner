import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SHIPPED,
  main,
  packSmoke,
  probeSource,
  shell,
  workspace,
  type Shell,
  type Workspace,
} from '../pack-smoke.js'

const SCRATCH = '/scratch'

/**
 * An in-memory workspace holding one package manifest. Listing the scratch
 * directory shows the tarball; listing anything else shows the installed package.
 */
const memory = (
  manifest: object,
  { tarball = true, installed = ['dist', 'package.json', ...SHIPPED] } = {},
) => {
  const files = new Map<string, string>([[join('/pkg', 'package.json'), JSON.stringify(manifest)]])
  const removed: string[] = []
  const fs: Workspace = {
    make: () => SCRATCH,
    list: (dir) => (dir === SCRATCH ? (tarball ? ['jev-planner-0.1.0.tgz'] : []) : installed),
    read: (file) => files.get(file) ?? '',
    write: (file, contents) => {
      files.set(file, contents)
    },
    remove: (dir) => {
      removed.push(dir)
    },
  }
  return { fs, files, removed }
}

/** A shell that answers like a healthy npm, with the probe's output overridable. */
const npm =
  ({ probe = 'ok' }: { probe?: string } = {}): Shell =>
  (command, args) =>
    command === 'node' ? `${probe}\n` : args.join(' ')

describe('probeSource', () => {
  it('loads the package by name through both halves of its exports map', () => {
    const source = probeSource('jev-planner')
    expect(source).toContain('await import("jev-planner")')
    expect(source).toContain('createRequire(import.meta.url)("jev-planner")')
  })
})

describe('packSmoke', () => {
  it('packs, installs, probes, and cleans up', () => {
    const { fs, files, removed } = memory({ name: 'jev-planner', version: '0.1.0' })
    const calls: string[] = []
    const sh: Shell = (command, args, cwd) => {
      calls.push(`${command} ${args.join(' ')} @ ${cwd}`)
      return npm()(command, args, cwd)
    }

    expect(packSmoke({ pkgDir: '/pkg', sh, fs })).toBe(
      'pack:smoke ok — jev-planner@0.1.0 installs, imports and requires from a tarball',
    )
    expect(calls).toEqual([
      `npm pack --ignore-scripts --pack-destination ${SCRATCH} @ /pkg`,
      `npm install --no-audit --no-fund ${join(SCRATCH, 'jev-planner-0.1.0.tgz')} @ ${SCRATCH}`,
      `node ${join(SCRATCH, 'probe.mjs')} @ ${SCRATCH}`,
    ])
    expect(files.get(join(SCRATCH, 'probe.mjs'))).toContain('jev-planner')
    expect(removed).toEqual([SCRATCH])
  })

  it('fails when npm pack wrote no tarball, and still cleans up', () => {
    const { fs, removed } = memory({ name: 'x', version: '1.0.0' }, { tarball: false })
    expect(() => packSmoke({ pkgDir: '/pkg', sh: npm(), fs })).toThrow('produced no tarball')
    expect(removed).toEqual([SCRATCH])
  })

  it('fails when the tarball leaves out a file a reader opens, and still cleans up', () => {
    const { fs, removed } = memory(
      { name: 'x', version: '1.0.0' },
      { installed: ['dist', 'package.json', 'LICENSE'] },
    )
    expect(() => packSmoke({ pkgDir: '/pkg', sh: npm(), fs })).toThrow(
      'the tarball does not contain README.md, llms.txt, config.schema.json',
    )
    expect(removed).toEqual([SCRATCH])
  })

  it('fails when the probe does not print ok, and still cleans up', () => {
    const { fs, removed } = memory({ name: 'x', version: '1.0.0' })
    expect(() => packSmoke({ pkgDir: '/pkg', sh: npm({ probe: 'boom' }), fs })).toThrow(
      'probe failed: boom',
    )
    expect(removed).toEqual([SCRATCH])
  })
})

describe('main', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  afterEach(() => {
    log.mockClear()
    error.mockClear()
  })

  it('prints the verdict and exits 0', () => {
    const { fs } = memory({ name: 'x', version: '1.0.0' })
    expect(main('/pkg', { sh: npm(), fs })).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pack:smoke ok'))
  })

  it('prints the failure and exits 1', () => {
    const { fs } = memory({ name: 'x', version: '1.0.0' }, { tarball: false })
    expect(main('/pkg', { sh: npm(), fs })).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('pack:smoke failed'))
  })
})

describe('the real shell and workspace', () => {
  it('runs a command and returns its output', () => {
    expect(shell(process.execPath, ['-e', 'process.stdout.write("hi")'], process.cwd())).toBe('hi')
  })

  it('makes, writes, reads, lists and removes a scratch directory', () => {
    const dir = workspace.make()
    const file = join(dir, 'a.txt')
    workspace.write(file, 'hello')
    expect(workspace.read(file)).toBe('hello')
    expect(workspace.list(dir)).toEqual(['a.txt'])
    mkdirSync(join(dir, 'nested'))
    workspace.remove(dir)
    expect(existsSync(dir)).toBe(false)
    expect(() => readFileSync(file)).toThrow()
  })
})
