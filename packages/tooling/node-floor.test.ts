import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideFloor,
  floorOf,
  main,
  readPublished,
  workspace,
  type Workspace,
} from './node-floor.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

/** A fake workspace: package directory → manifest, or undefined for a directory without one. */
const fakeFs = (manifests: Record<string, object | undefined>): Workspace => ({
  list: () => Object.keys(manifests),
  read: (file) => {
    const entry = file.split(/[\\/]/).at(-2) ?? '';
    const manifest = manifests[entry];
    return manifest === undefined ? undefined : JSON.stringify(manifest);
  },
});

const pkg = (name: string, node?: string, extra: object = {}) => ({
  name,
  ...(node === undefined ? {} : { engines: { node } }),
  ...extra,
});

describe('floorOf', () => {
  it.each([
    ['>=22.13', '22.13'],
    ['>= 20.11.0', '20.11.0'],
    ['>=v22', '22'],
  ])('reads %s as %s', (range, floor) => {
    expect(floorOf(range)).toBe(floor);
  });

  it.each(['^22.13', '>=22 <25', '22.x', '*', ''])('has no single floor for "%s"', (range) => {
    expect(floorOf(range)).toBeUndefined();
  });
});

describe('readPublished', () => {
  it('reads each published package and its floor', () => {
    const fs = fakeFs({ lib: pkg('@scope/lib', '>=22.13') });
    expect(readPublished('/repo', fs)).toEqual([
      { dir: 'packages/lib', name: '@scope/lib', floor: '22.13' },
    ]);
  });

  it('skips private packages and directories without a manifest', () => {
    const fs = fakeFs({
      tooling: pkg('@scope/tooling', undefined, { private: true }),
      stray: undefined,
    });
    expect(readPublished('/repo', fs)).toEqual([]);
  });

  it('refuses a published package without engines.node', () => {
    const fs = fakeFs({ lib: pkg('@scope/lib') });
    expect(() => readPublished('/repo', fs)).toThrow('@scope/lib is published but declares no');
  });

  it('refuses a range with no single floor, naming the directory when the name is missing', () => {
    const fs = fakeFs({ lib: { engines: { node: '^22.13' } } });
    expect(() => readPublished('/repo', fs)).toThrow('packages/lib: engines.node "^22.13"');
  });
});

describe('decideFloor', () => {
  it('returns the floor the packages share', () => {
    const floor = decideFloor([
      { dir: 'packages/a', name: 'a', floor: '22.13' },
      { dir: 'packages/b', name: 'b', floor: '22.13' },
    ]);
    expect(floor).toBe('22.13');
  });

  it('returns nothing when nothing is published', () => {
    expect(decideFloor([])).toBeUndefined();
  });

  it('refuses packages that disagree, naming each', () => {
    expect(() =>
      decideFloor([
        { dir: 'packages/a', name: 'a', floor: '20.11' },
        { dir: 'packages/b', name: 'b', floor: '22.13' },
      ]),
    ).toThrow('(a 20.11, b 22.13)');
  });
});

describe('main', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  afterEach(() => {
    log.mockClear();
    error.mockClear();
  });

  const withOutput = (run: (output: string) => void): string => {
    const dir = mkdtempSync(join(tmpdir(), 'node-floor-'));
    const output = join(dir, 'output');
    try {
      run(output);
      return readFileSync(output, 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('writes the floor and the package directories as step outputs', () => {
    const fs = fakeFs({ a: pkg('a', '>=22.13'), b: pkg('b', '>=22.13') });
    const written = withOutput((output) => {
      expect(main('/repo', { GITHUB_OUTPUT: output }, { fs })).toBe(0);
    });
    expect(written).toBe('version=22.13\npackages=packages/a packages/b\n');
    expect(log).toHaveBeenCalledWith('node-floor: 22.13 for a, b');
  });

  it('writes an empty floor when nothing is published, so the job skips its steps', () => {
    const written = withOutput((output) => {
      expect(main('/repo', { GITHUB_OUTPUT: output }, { fs: fakeFs({}) })).toBe(0);
    });
    expect(written).toBe('version=\npackages=\n');
    expect(log).toHaveBeenCalledWith('node-floor: no published package, nothing to test');
  });

  it('only prints when there is no step output to write', () => {
    expect(main('/repo', {}, { fs: fakeFs({ a: pkg('a', '>=22.13') }) })).toBe(0);
  });

  it('fails with the reason when the manifests cannot be trusted', () => {
    expect(main('/repo', {}, { fs: fakeFs({ a: pkg('a') }) })).toBe(1);
    expect(error).toHaveBeenCalledWith(
      'node-floor failed — a is published but declares no engines.node',
    );
  });
});

describe('workspace', () => {
  it('lists and reads real files', () => {
    expect(workspace.list(here)).toContain('node-floor.ts');
    expect(workspace.read(join(here, 'package.json'))).toContain('"private": true');
  });

  it('treats a missing directory or file as empty rather than throwing', () => {
    expect(workspace.list(join(here, 'no-such-dir'))).toEqual([]);
    expect(workspace.read(join(here, 'no-such-file.json'))).toBeUndefined();
  });
});

describe('the entry point', () => {
  it('reads this repository and prints its floor', () => {
    const script = join(here, 'node-floor.ts');
    const out = execFileSync(process.execPath, ['--import', 'tsx', script], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: '' },
    });
    expect(out).toMatch(/^node-floor: /);
  });
});
