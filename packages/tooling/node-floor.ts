/**
 * Reads the oldest Node the published packages promise to run on, from the
 * `engines.node` in their manifests, for the CI job that installs each packed
 * tarball on exactly that Node.
 *
 * The unit matrix runs the newest release of each major, which proves little
 * about the floor: `>=22.13` is a promise about 22.13, and later 22.x minors add
 * APIs it does not have. Reading the floor from the manifests keeps the job and
 * the promise from drifting apart — lowering `engines` moves the job with it.
 *
 * One floor for the workspace. Packages that disagree fail here, by name,
 * rather than being tested on whichever floor happened to be read last.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isEntry } from './entry.js';

/** The only file access this module needs. Injected for tests. */
export type Workspace = {
  list: (dir: string) => string[];
  read: (file: string) => string | undefined;
};

export const workspace: Workspace = {
  list: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
  read: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined),
};

type Manifest = { name?: string; private?: boolean; engines?: { node?: string } };

export type Published = { dir: string; name: string; floor: string };

/** `>=22.13` → `22.13`. Anything but a plain lower bound has no single floor to test. */
export const floorOf = (range: string): string | undefined =>
  /^>=\s*v?(\d+(?:\.\d+){0,2})$/.exec(range.trim())?.[1];

/** Every non-private package under `packages/`, with the floor it declares. */
export const readPublished = (root: string, fs: Workspace = workspace): Published[] =>
  fs.list(join(root, 'packages')).flatMap((entry) => {
    const dir = `packages/${entry}`;
    const raw = fs.read(join(root, dir, 'package.json'));
    if (raw === undefined) return [];

    const manifest = JSON.parse(raw) as Manifest;
    if (manifest.private === true) return [];

    const name = manifest.name ?? dir;
    const range = manifest.engines?.node;
    if (range === undefined) {
      throw new Error(`${name} is published but declares no engines.node`);
    }
    const floor = floorOf(range);
    if (floor === undefined) {
      throw new Error(`${name}: engines.node "${range}" is not a plain lower bound like ">=22.13"`);
    }
    return [{ dir, name, floor }];
  });

/** The one floor they share, or undefined when nothing is published. */
export const decideFloor = (published: Published[]): string | undefined => {
  const floors = [...new Set(published.map((pkg) => pkg.floor))];
  if (floors.length > 1) {
    const each = published.map((pkg) => `${pkg.name} ${pkg.floor}`).join(', ');
    throw new Error(`published packages disagree on the Node floor (${each}); give them one`);
  }
  return floors[0];
};

/** Returns the process exit code rather than taking it, so tests can call it. */
export const main = (
  root: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  { fs = workspace }: { fs?: Workspace } = {},
): number => {
  try {
    const published = readPublished(root, fs);
    const floor = decideFloor(published);

    console.log(
      floor === undefined
        ? 'node-floor: no published package, nothing to test'
        : `node-floor: ${floor} for ${published.map((pkg) => pkg.name).join(', ')}`,
    );

    if (env.GITHUB_OUTPUT) {
      const dirs = published.map((pkg) => pkg.dir).join(' ');
      appendFileSync(env.GITHUB_OUTPUT, `version=${floor ?? ''}\npackages=${dirs}\n`);
    }
    return 0;
  } catch (failure) {
    console.error(`node-floor failed — ${(failure as Error).message}`);
    return 1;
  }
};

/* v8 ignore start -- the entry shell; covered by the test that spawns this
   file, which reports no coverage back into this run. */
if (isEntry(import.meta.url)) {
  process.exit(main());
}
/* v8 ignore stop */
