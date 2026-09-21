// Each rule has a case that asserts it fails. A gate that cannot fail looks the
// same as one that never needed to.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkLlms,
  checkPackage,
  checkRootIndex,
  declaredExports,
  documentedExports,
  formatFailures,
  main,
  publishedPackages,
} from '../check-llms.js'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface PackageSpec {
  name: string
  private?: boolean
  files?: string[]
  llms?: string
  index?: string
}

/** A throwaway repository root with `packages/<dir>` for each spec. */
const repo = (specs: Record<string, PackageSpec>, rootIndex?: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'check-llms-'))
  made.push(root)

  for (const [dir, spec] of Object.entries(specs)) {
    const pkgDir = join(root, 'packages', dir)
    mkdirSync(join(pkgDir, 'src'), { recursive: true })
    const manifest = {
      name: spec.name,
      private: spec.private,
      files: spec.files ?? ['dist', 'llms.txt'],
    }
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(manifest))
    if (spec.llms !== undefined) writeFileSync(join(pkgDir, 'llms.txt'), spec.llms)
    if (spec.index !== undefined) writeFileSync(join(pkgDir, 'src', 'index.ts'), spec.index)
  }
  if (rootIndex !== undefined) writeFileSync(join(root, 'llms.txt'), rootIndex)
  return root
}

const apiTable = (...names: string[]) =>
  [
    '## API',
    '',
    '| Export | Kind |',
    '| --- | --- |',
    ...names.map((n) => `| \`${n}\` | x |`),
    '',
  ].join('\n')

const wellFormed = (name: string, api = apiTable('toError')) =>
  [
    `# ${name}`,
    '',
    '> A summary.',
    '',
    '## Install',
    '',
    `    npm i ${name}`,
    '',
    api,
    '## Docs',
    '',
  ].join('\n')

const INDEX = "export { toError } from './toError'\n"
const pkg = { dir: 'lib', name: 'lib', files: ['dist', 'llms.txt'] }

describe('documentedExports', () => {
  it('reads the first column of the tables under ## API', () => {
    expect(documentedExports(apiTable('toError', 'ErrorClass'))).toEqual(['toError', 'ErrorClass'])
  })

  it('stops at the next ## heading, but not at a ### one', () => {
    const body = [apiTable('a'), '### Types', '| `b` | x |', '## Gotchas', '| `c` | x |'].join('\n')
    expect(documentedExports(body)).toEqual(['a', 'b'])
  })

  it('reads nothing when there is no API section', () => {
    expect(documentedExports('## Rules\n\n| `a` | b |')).toEqual([])
  })

  it('skips header, separator and prose rows', () => {
    expect(documentedExports('## API\n| Export | Kind |\n| --- | --- |\n| plain | x |')).toEqual([])
  })
})

describe('declaredExports', () => {
  const entry = (source: string) => {
    const root = repo({ lib: { name: 'lib', index: source } })
    return declaredExports(join(root, 'packages', 'lib', 'src', 'index.ts'))
  }

  it.each([
    ['a re-export', "export { a } from './a'"],
    ['a type-only re-export', "export type { a } from './a'"],
    ['a local re-export', 'const a = 1\nexport { a }'],
    ['a function', 'export function a() {}'],
    ['a class', 'export class a {}'],
    ['an interface', 'export interface a {}'],
    ['a type alias', 'export type a = string'],
    ['an enum', 'export enum a {}'],
    ['a const', 'export const a = 1'],
  ])('collects %s', (_, source) => {
    expect(entry(source)).toEqual(new Set(['a']))
  })

  it('skips declarations that are not exported, and export * it cannot follow', () => {
    expect(
      entry("const a = 1\nfunction b() {}\nexport * from './c'\nexport const { d } = {}"),
    ).toEqual(new Set())
  })
})

describe('publishedPackages', () => {
  it('lists the packages that are not private', () => {
    const root = repo({ lib: { name: 'lib' }, tooling: { name: '@repo/tooling', private: true } })
    mkdirSync(join(root, 'packages', 'empty'))
    writeFileSync(join(root, 'packages', 'README.md'), '')

    expect(publishedPackages(root)).toEqual([
      { dir: 'lib', name: 'lib', files: ['dist', 'llms.txt'] },
    ])
  })

  it('reads a missing files array as empty', () => {
    const root = repo({ lib: { name: 'lib' } })
    writeFileSync(join(root, 'packages', 'lib', 'package.json'), '{"name":"lib"}')

    expect(publishedPackages(root)[0]?.files).toEqual([])
  })
})

describe('checkPackage', () => {
  const check = (spec: Partial<PackageSpec>, files = pkg.files) =>
    checkPackage(repo({ lib: { name: 'lib', llms: wellFormed('lib'), index: INDEX, ...spec } }), {
      ...pkg,
      files,
    }).map(({ reason }) => reason)

  it('passes a well-formed file whose table matches the exports', () => {
    expect(check({})).toEqual([])
  })

  it('fails when the file is missing', () => {
    expect(check({ llms: undefined })).toEqual([
      'has no llms.txt; every published package ships one',
    ])
  })

  it('fails when the file is not in files, so it is not published', () => {
    expect(check({}, ['dist'])).toEqual([
      'does not list llms.txt in `files`, so the tarball leaves it out',
    ])
  })

  it.each([
    ['a title copied from another package', wellFormed('other'), 'must open with "# lib"'],
    ['an empty file', '', 'found ""'],
    ['no summary', wellFormed('lib').replace('> A summary.', 'A summary.'), '"> " summary'],
    ['no install section', wellFormed('lib').replace('## Install', '## Setup'), '"## Install"'],
    ['no docs section', wellFormed('lib').replace('## Docs', '## Links'), '"## Docs"'],
  ])('fails on %s', (_, llms, expected) => {
    expect(check({ llms }).join('\n')).toContain(expected)
  })

  it('fails when the table documents an export that is gone', () => {
    expect(check({ llms: wellFormed('lib', apiTable('toError', 'toErrorOld')) })).toEqual([
      'llms.txt documents `toErrorOld`, which src/index.ts does not export',
    ])
  })

  it('fails when an export is missing from the table', () => {
    expect(check({ index: `${INDEX}export type { ErrorClass } from './types'\n` })).toEqual([
      'llms.txt does not document `ErrorClass`, which src/index.ts exports',
    ])
  })

  it('fails on a missing API section, and on each export it leaves out', () => {
    expect(check({ llms: wellFormed('lib', '') })).toEqual([
      'llms.txt has no "## API" section',
      'llms.txt does not document `toError`, which src/index.ts exports',
    ])
  })

  it('fails when there is no src/index.ts to check against', () => {
    expect(check({ index: undefined })).toEqual([
      'has no src/index.ts to check the llms.txt API table against',
    ])
  })
})

describe('checkRootIndex', () => {
  const two = [pkg, { dir: 'other', name: '@scope/other', files: [] }]
  const index = (body?: string) => checkRootIndex(repo({}, body), two).map(({ reason }) => reason)

  it('passes when it links every published package', () => {
    expect(index('- [lib](packages/lib/llms.txt)\n- [other](packages/other/llms.txt)\n')).toEqual(
      [],
    )
  })

  it('fails for each package it does not link', () => {
    expect(index('- [lib](packages/lib/llms.txt)\n')).toEqual([
      'does not link packages/other/llms.txt, so @scope/other is missing from the index',
    ])
  })

  it('fails when it is missing', () => {
    expect(index()).toEqual(['is missing at the repository root'])
  })
})

describe('checkLlms', () => {
  it('checks every published package and the root index', () => {
    const root = repo(
      { lib: { name: 'lib', llms: wellFormed('lib'), index: INDEX }, other: { name: 'other' } },
      '- [lib](packages/lib/llms.txt)\n',
    )

    expect(checkLlms(root)).toEqual([
      { where: 'other', reason: 'has no llms.txt; every published package ships one' },
      {
        where: 'llms.txt',
        reason: 'does not link packages/other/llms.txt, so other is missing from the index',
      },
    ])
  })
})

describe('formatFailures', () => {
  it('counts the failures and lists one per line', () => {
    expect(formatFailures([{ where: 'lib', reason: 'is wrong' }])).toBe(
      'check:llms failed — 1 problem(s)\n  ✗ lib is wrong',
    )
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
    const root = repo(
      { lib: { name: 'lib', llms: wellFormed('lib'), index: INDEX } },
      '[lib](packages/lib/llms.txt)',
    )
    expect(main(root)).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('check:llms ok'))
  })

  it('prints the failures and exits 1', () => {
    expect(main(repo({ lib: { name: 'lib' } }))).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('has no llms.txt'))
  })

  it('checks the working directory by default', () => {
    const root = repo({ lib: { name: 'lib', private: true } }, '')
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
    expect(main()).toBe(0)
    cwd.mockRestore()
  })
})
