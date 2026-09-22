import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '../process/process.js'

/**
 * Top-level files that say what a repository is and how it is built, read in
 * this order. Tracked files only, so a `.env` or anything else ignored is never
 * sent: the snapshot goes to a third-party API.
 */
const SNAPSHOT_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'CONTRIBUTING.md',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
]

const MAX_SNAPSHOT_PATHS = 2_000
export const MAX_SNAPSHOT_FILE_CHARS = 16_000
export const MAX_SNAPSHOT_CHARS = 80_000

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated]`
}

/**
 * What an agent without repository access is told about `cwd`: the files git
 * tracks under it, and the contents of the `SNAPSHOT_FILES` among them, within
 * fixed size budgets. Outside a git repository it says so rather than guessing
 * which files are safe to send.
 */
export async function repoSnapshot(cwd: string): Promise<string> {
  let paths: string[]
  try {
    const { stdout } = await runProcess('git', ['ls-files'], { cwd, timeoutMs: 15_000 })
    paths = stdout.split('\n').filter(Boolean)
  } catch {
    return '<repository-snapshot>\nNot a git repository: no files are available.\n</repository-snapshot>'
  }

  const listed = paths.slice(0, MAX_SNAPSHOT_PATHS)
  const omitted = paths.length - listed.length
  let snapshot = `<repository-snapshot>\nTracked files (${String(paths.length)}):\n${listed.join('\n')}${
    omitted > 0 ? `\n[${String(omitted)} more not listed]` : ''
  }`

  const tracked = new Set(paths)
  for (const file of SNAPSHOT_FILES) {
    if (!tracked.has(file)) continue
    const contents = await readFile(join(cwd, file), 'utf8').catch(() => undefined)
    if (contents === undefined) continue
    const block = `\n\n<file path="${file}">\n${clip(contents, MAX_SNAPSHOT_FILE_CHARS)}\n</file>`
    if (snapshot.length + block.length > MAX_SNAPSHOT_CHARS) break
    snapshot += block
  }
  return `${snapshot}\n</repository-snapshot>`
}
