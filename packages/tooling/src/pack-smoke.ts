/**
 * Packs the real tarball, installs it into a scratch project, and loads it the
 * way a consumer's Node would: once through `import`, once through `require`.
 *
 * This is the only check that catches a `files` entry that dropped dist, or an
 * exports map that resolves for a bundler but not for plain Node. Both ship
 * green through lint, types and unit tests. It also checks the files a reader
 * opens in `node_modules` beside dist: the README, the license, and the
 * `llms.txt` that `check-llms` keeps in step with the exports.
 *
 * Run from a package directory (`pnpm run pack:smoke`). It packs with
 * `--ignore-scripts`, so dist has to be built first: Turbo's `dependsOn` does
 * that, and CI builds before it runs this on the oldest Node `engines` allows,
 * where pnpm itself does not start. The commands and the scratch directory are
 * injected, so the sequence and every way it can fail are tested without a real
 * pack and install.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isEntry } from './entry.js'

export type Shell = (command: string, args: string[], cwd: string) => string
export interface Workspace {
  make: () => string
  list: (dir: string) => string[]
  read: (file: string) => string
  write: (file: string, contents: string) => void
  remove: (dir: string) => void
}

export const shell: Shell = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export const workspace: Workspace = {
  make: () => mkdtempSync(join(tmpdir(), 'pack-smoke-')),
  list: (dir) => readdirSync(dir),
  read: (file) => readFileSync(file, 'utf8'),
  write: (file, contents) => {
    writeFileSync(file, contents)
  },
  remove: (dir) => {
    rmSync(dir, { recursive: true, force: true })
  },
}

export interface Manifest {
  name: string
  version: string
}

/** The probe a consumer's Node would run, with no bundler in the way. */
export const probeSource = (name: string): string =>
  [
    "import { createRequire } from 'node:module'",
    `const esm = await import(${JSON.stringify(name)})`,
    `const cjs = createRequire(import.meta.url)(${JSON.stringify(name)})`,
    'if (Object.keys(esm).length === 0) throw new Error("the import entry exports nothing")',
    'if (Object.keys(cjs).length === 0) throw new Error("the require entry exports nothing")',
    "console.log('ok')",
  ].join('\n')

/** Files the installed package must hold besides dist, which the probe covers. */
export const SHIPPED = ['LICENSE', 'README.md', 'llms.txt']

/**
 * Runs the whole smoke test and returns the line to print. Throws on any step
 * that did not behave the way a published package has to; the scratch directory
 * is removed either way.
 */
export const packSmoke = ({
  pkgDir,
  sh = shell,
  fs = workspace,
}: {
  pkgDir: string
  sh?: Shell
  fs?: Workspace
}): string => {
  const manifest = JSON.parse(fs.read(join(pkgDir, 'package.json'))) as Manifest
  const scratch = fs.make()
  try {
    sh('npm', ['pack', '--ignore-scripts', '--pack-destination', scratch], pkgDir)
    const tarball = fs.list(scratch).find((file) => file.endsWith('.tgz'))
    if (tarball === undefined) throw new Error('npm pack produced no tarball')

    fs.write(join(scratch, 'package.json'), JSON.stringify({ name: 'scratch', private: true }))
    sh('npm', ['install', '--no-audit', '--no-fund', join(scratch, tarball)], scratch)

    const installed = fs.list(join(scratch, 'node_modules', manifest.name))
    const missing = SHIPPED.filter((file) => !installed.includes(file))
    if (missing.length > 0) throw new Error(`the tarball does not contain ${missing.join(', ')}`)

    const probe = join(scratch, 'probe.mjs')
    fs.write(probe, probeSource(manifest.name))
    const probeOut = sh('node', [probe], scratch).trim()
    if (probeOut !== 'ok') throw new Error(`probe failed: ${probeOut}`)

    return `pack:smoke ok — ${manifest.name}@${manifest.version} installs, imports and requires from a tarball`
  } finally {
    fs.remove(scratch)
  }
}

/** Returns the process exit code rather than taking it, so tests can call it. */
export const main = (
  pkgDir: string = process.cwd(),
  deps: { sh?: Shell; fs?: Workspace } = {},
): number => {
  try {
    console.log(packSmoke({ pkgDir, ...deps }))
    return 0
  } catch (failure) {
    console.error(`pack:smoke failed — ${(failure as Error).message}`)
    return 1
  }
}

/* v8 ignore start -- the entry shell: running it for real packs and installs a
   tarball, which is what the CI step itself does. */
if (isEntry(import.meta.url)) {
  process.exit(main())
}
/* v8 ignore stop */
