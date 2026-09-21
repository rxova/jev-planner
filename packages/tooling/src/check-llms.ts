/**
 * Fails when a published package's `llms.txt` is missing, left out of the
 * tarball, malformed, or out of step with the package's exports.
 *
 * The file ships in the tarball, so it is what a coding agent reads out of
 * `node_modules` after an install. A renamed export leaves it describing an API
 * that no longer exists while every test still passes, and nothing else in the
 * repo reads it. So the check that matters is the last one: the `## API` table
 * and `src/index.ts` name the same exports, in both directions.
 *
 * The root `llms.txt` is the index for an agent that arrives through the
 * repository rather than an install. It restates no API, so the one thing in it
 * that can go stale is the link to each package's file.
 *
 * Reads files only: no build, no network. Usage: `pnpm run check:llms`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { isEntry } from './entry.js'

export const LLMS_FILE = 'llms.txt'

export interface Failure {
  where: string
  reason: string
}

export interface PublishedPackage {
  dir: string
  name: string
  files: string[]
}

interface Manifest {
  name: string
  private?: boolean
  files?: string[]
}

/** Every package under `packages/` that is not private, and so publishes a tarball. */
export const publishedPackages = (root: string): PublishedPackage[] => {
  const packagesDir = join(root, 'packages')

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ dir: entry.name, path: join(packagesDir, entry.name, 'package.json') }))
    .filter(({ path }) => existsSync(path))
    .map(({ dir, path }) => ({ dir, manifest: JSON.parse(readFileSync(path, 'utf8')) as Manifest }))
    .filter(({ manifest }) => manifest.private !== true)
    .map(({ dir, manifest }) => ({ dir, name: manifest.name, files: manifest.files ?? [] }))
}

/**
 * The names in the first column of every table under `## API`, up to the next
 * `## ` heading. Rows whose first cell is not one backticked identifier (the
 * header, the `| --- |` separator) are skipped.
 *
 * Sliced line by line: a single regex with a `\s*$` lookahead stops at the
 * first position, reads every table as empty, and passes every file.
 */
export const documentedExports = (body: string): string[] => {
  const lines = body.split('\n')
  const start = lines.findIndex((line) => line.trim() === '## API')
  if (start === -1) return []

  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))

  return (end === -1 ? rest : rest.slice(0, end)).flatMap((line) => {
    const name = /^\|\s*`([A-Za-z_$][\w$]*)`/.exec(line)?.[1]
    return name === undefined ? [] : [name]
  })
}

/**
 * Every name an entry file exports, types included: an agent importing a type
 * by a name that no longer exists is as broken as one importing a value.
 * `export * from` is not followed, so the documented names it re-exports are
 * reported as missing rather than silently passed.
 */
export const declaredExports = (entry: string): Set<string> => {
  const names = new Set<string>()
  const source = ts.createSourceFile(entry, readFileSync(entry, 'utf8'), ts.ScriptTarget.Latest)

  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) names.add(element.name.text)
      }
      continue
    }

    const exported =
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    if (exported !== true) continue

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text)
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text)
    }
  }

  return names
}

export const checkPackage = (root: string, pkg: PublishedPackage): Failure[] => {
  const pkgDir = join(root, 'packages', pkg.dir)
  const path = join(pkgDir, LLMS_FILE)
  if (!existsSync(path)) {
    return [{ where: pkg.name, reason: `has no ${LLMS_FILE}; every published package ships one` }]
  }

  const failures: Failure[] = []
  const fail = (reason: string) => {
    failures.push({ where: pkg.name, reason })
  }

  if (!pkg.files.includes(LLMS_FILE)) {
    fail(`does not list ${LLMS_FILE} in \`files\`, so the tarball leaves it out`)
  }

  const body = readFileSync(path, 'utf8')
  const lines = body.split('\n')
  const title = lines[0] ?? ''

  // The title is the package name, so a file copied from a sibling is caught.
  if (title !== `# ${pkg.name}`) {
    fail(`${LLMS_FILE} must open with "# ${pkg.name}", found ${JSON.stringify(title)}`)
  }
  // llmstxt.org: a blockquote summary directly under the title.
  if (!lines.slice(1, 4).some((line) => line.startsWith('> '))) {
    fail(`${LLMS_FILE} needs a "> " summary under the title`)
  }
  for (const heading of ['## Install', '## API', '## Docs']) {
    if (!lines.includes(heading)) fail(`${LLMS_FILE} has no "${heading}" section`)
  }

  const entry = join(pkgDir, 'src', 'index.ts')
  if (!existsSync(entry)) {
    fail(`has no src/index.ts to check the ${LLMS_FILE} API table against`)
    return failures
  }

  const documented = new Set(documentedExports(body))
  const declared = declaredExports(entry)
  for (const name of documented) {
    if (!declared.has(name))
      fail(`${LLMS_FILE} documents \`${name}\`, which src/index.ts does not export`)
  }
  for (const name of declared) {
    if (!documented.has(name))
      fail(`${LLMS_FILE} does not document \`${name}\`, which src/index.ts exports`)
  }

  return failures
}

/** The root index exists and links every published package's `llms.txt`. */
export const checkRootIndex = (root: string, packages: PublishedPackage[]): Failure[] => {
  const path = join(root, LLMS_FILE)
  if (!existsSync(path)) {
    return [{ where: LLMS_FILE, reason: 'is missing at the repository root' }]
  }

  const body = readFileSync(path, 'utf8')
  return packages
    .filter((pkg) => !body.includes(`](packages/${pkg.dir}/${LLMS_FILE})`))
    .map((pkg) => ({
      where: LLMS_FILE,
      reason: `does not link packages/${pkg.dir}/${LLMS_FILE}, so ${pkg.name} is missing from the index`,
    }))
}

export const checkLlms = (root: string): Failure[] => {
  const packages = publishedPackages(root)
  return [...packages.flatMap((pkg) => checkPackage(root, pkg)), ...checkRootIndex(root, packages)]
}

export const formatFailures = (failures: Failure[]): string =>
  [
    `check:llms failed — ${String(failures.length)} problem(s)`,
    ...failures.map(({ where, reason }) => `  ✗ ${where} ${reason}`),
  ].join('\n')

/** Returns the process exit code rather than taking it, so tests can call it. */
export const main = (root: string = process.cwd()): number => {
  const failures = checkLlms(resolve(root))
  if (failures.length > 0) {
    console.error(formatFailures(failures))
    return 1
  }

  console.log('check:llms ok — every published llms.txt matches its exports and is in the index')
  return 0
}

/* v8 ignore start -- the entry shell; `main` is what the tests call. */
if (isEntry(import.meta.url)) {
  process.exit(main(process.argv[2]))
}
/* v8 ignore stop */
