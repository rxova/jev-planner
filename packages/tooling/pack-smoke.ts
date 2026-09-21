/**
 * Packs the real tarball, installs it into a scratch project, imports it the
 * way a consumer's Node would, and runs every bin it declares.
 *
 * This is the only check that catches a `files` entry that dropped dist, an
 * exports map that resolves for a bundler but not for plain Node, or a bin that
 * lost its execute bit somewhere between the build and npm. Every one of those
 * ships green through lint, types and unit tests.
 *
 * Run from a package directory (`pnpm run pack:smoke` in each package). The
 * commands and the scratch directory are injected rather than reached for
 * directly, so the sequence — and every way it is allowed to fail — can be
 * tested without spending a minute on a real pack and install.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isEntry } from './entry.js';

export type Shell = (command: string, args: string[], cwd: string) => string;
export type Workspace = {
  make: () => string;
  list: (dir: string) => string[];
  read: (file: string) => string;
  write: (file: string, contents: string) => void;
  remove: (dir: string) => void;
};

export const shell: Shell = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export const workspace: Workspace = {
  make: () => mkdtempSync(join(tmpdir(), 'pack-smoke-')),
  list: (dir) => readdirSync(dir),
  read: (file) => readFileSync(file, 'utf8'),
  write: (file, contents) => writeFileSync(file, contents),
  remove: (dir) => rmSync(dir, { recursive: true, force: true }),
};

export type Manifest = { name: string; version: string; bin?: string | Record<string, string> };

/** The command names a package installs: a string `bin` is named after the package. */
export const binsOf = ({ name, bin }: Manifest): string[] => {
  if (typeof bin === 'string') return [name.replace(/^@[^/]+\//, '')];
  return Object.keys(bin ?? {});
};

/** The probe a consumer's Node would run, with no bundler in the way. */
export const probeSource = (name: string): string =>
  [
    `const mod = await import(${JSON.stringify(name)});`,
    'if (Object.keys(mod).length === 0) throw new Error("the entry exports nothing");',
    "console.log('ok');",
  ].join('\n');

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
  pkgDir: string;
  sh?: Shell;
  fs?: Workspace;
}): string => {
  const manifest = JSON.parse(fs.read(join(pkgDir, 'package.json'))) as Manifest;
  const scratch = fs.make();
  try {
    sh('npm', ['pack', '--pack-destination', scratch], pkgDir);
    const tarball = fs.list(scratch).find((f) => f.endsWith('.tgz'));
    if (!tarball) throw new Error('npm pack produced no tarball');

    fs.write(join(scratch, 'package.json'), JSON.stringify({ name: 'scratch', private: true }));
    sh('npm', ['install', '--no-audit', '--no-fund', join(scratch, tarball)], scratch);

    // Every bin, as a consumer gets it.
    for (const bin of binsOf(manifest)) {
      const version = sh('npx', ['--no-install', bin, '--version'], scratch).trim();
      if (!/^\d+\.\d+\.\d+/.test(version)) {
        throw new Error(`bin \`${bin}\` reported an unusable version: ${version}`);
      }
    }

    // The library entry, through the exports map, in plain Node with no bundler.
    const probe = join(scratch, 'probe.mjs');
    fs.write(probe, probeSource(manifest.name));
    const probeOut = sh('node', [probe], scratch).trim();
    if (probeOut !== 'ok') throw new Error(`probe failed: ${probeOut}`);

    return `pack:smoke ok — ${manifest.name}@${manifest.version} installs and imports from a tarball`;
  } finally {
    fs.remove(scratch);
  }
};

/** Returns the process exit code rather than taking it, so tests can call it. */
export const main = (
  pkgDir: string = process.cwd(),
  deps: { sh?: Shell; fs?: Workspace } = {},
): number => {
  try {
    console.log(packSmoke({ pkgDir, ...deps }));
    return 0;
  } catch (failure) {
    console.error(`pack:smoke failed — ${(failure as Error).message}`);
    return 1;
  }
};

/* v8 ignore start -- the entry shell: running it for real packs and installs a
   tarball, which is what the CI task itself does. */
if (isEntry(import.meta.url)) {
  process.exit(main());
}
/* v8 ignore stop */
