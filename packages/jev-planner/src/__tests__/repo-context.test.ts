import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../process.js'
import { MAX_SNAPSHOT_CHARS, MAX_SNAPSHOT_FILE_CHARS, repoSnapshot } from '../repo-context.js'

vi.mock('../process.js', () => ({ runProcess: vi.fn() }))

const run = vi.mocked(runProcess)
let dir: string

function tracked(...paths: string[]): void {
  run.mockResolvedValue({ stdout: `${paths.join('\n')}\n`, stderr: '', exitCode: 0 })
}

beforeEach(async () => {
  run.mockReset()
  dir = await mkdtemp(join(tmpdir(), 'jev-snapshot-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('repoSnapshot', () => {
  it('lists tracked files and inlines the tracked top-level docs', async () => {
    await writeFile(join(dir, 'README.md'), '# Demo')
    await writeFile(join(dir, 'package.json'), '{}')
    await writeFile(join(dir, '.env'), 'SECRET=1')
    tracked('README.md', 'package.json', 'src/index.ts')

    const snapshot = await repoSnapshot(dir)
    expect(run).toHaveBeenCalledWith('git', ['ls-files'], { cwd: dir, timeoutMs: 15_000 })
    expect(snapshot).toBe(
      '<repository-snapshot>\nTracked files (3):\nREADME.md\npackage.json\nsrc/index.ts' +
        '\n\n<file path="README.md">\n# Demo\n</file>' +
        '\n\n<file path="package.json">\n{}\n</file>\n</repository-snapshot>',
    )
    expect(snapshot).not.toContain('SECRET')
  })

  it('never reads an untracked file, and skips a tracked one that is gone', async () => {
    await writeFile(join(dir, 'AGENTS.md'), 'untracked notes')
    tracked('README.md')
    const snapshot = await repoSnapshot(dir)
    expect(snapshot).not.toContain('<file')
  })

  it('says so outside a git repository', async () => {
    run.mockRejectedValue(new Error('not a git repository'))
    await expect(repoSnapshot(dir)).resolves.toBe(
      '<repository-snapshot>\nNot a git repository: no files are available.\n</repository-snapshot>',
    )
  })

  it('caps the file list, each file and the whole snapshot', async () => {
    const paths = Array.from({ length: 2_005 }, (_, index) => `f${String(index)}.ts`)
    await writeFile(join(dir, 'AGENTS.md'), 'a'.repeat(MAX_SNAPSHOT_FILE_CHARS + 1))
    for (const file of ['CLAUDE.md', 'README.md', 'CONTRIBUTING.md', 'package.json', 'go.mod']) {
      await writeFile(join(dir, file), 'b'.repeat(MAX_SNAPSHOT_FILE_CHARS))
    }
    tracked(
      ...paths,
      'AGENTS.md',
      'CLAUDE.md',
      'README.md',
      'CONTRIBUTING.md',
      'package.json',
      'go.mod',
    )

    const snapshot = await repoSnapshot(dir)
    expect(snapshot).toContain('Tracked files (2011):')
    expect(snapshot).toContain('\nf1999.ts\n[11 more not listed]')
    expect(snapshot).not.toContain('f2000.ts')
    expect(snapshot).toContain(`${'a'.repeat(MAX_SNAPSHOT_FILE_CHARS)}\n[truncated]\n</file>`)
    expect(snapshot.length).toBeLessThanOrEqual(
      MAX_SNAPSHOT_CHARS + '\n</repository-snapshot>'.length,
    )
    expect(snapshot).not.toContain('<file path="go.mod">')
  })
})
