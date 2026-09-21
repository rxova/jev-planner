import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideScope,
  git,
  isReleaseMetadata,
  main,
  versionBumpOnly,
  type Git,
} from './check-scope.js';

const RANGE = { base: 'aaa', head: 'bbb' };

/** A fake repository: `--name-only` lists files, `--unified=0` returns a diff per file. */
const fakeGit =
  (files: string[], patches: Record<string, string> = {}): Git =>
  (...args) => {
    if (args.includes('--name-only')) return files.join('\n');
    return patches[args[args.length - 1] ?? ''] ?? '';
  };

const bump = [
  '--- a/packages/example/package.json',
  '+++ b/packages/example/package.json',
  '@@ -3 +3 @@',
  '-  "version": "0.1.0",',
  '+  "version": "0.2.0",',
].join('\n');

describe('isReleaseMetadata', () => {
  it.each(['.changeset/tidy-pandas-smile.md', 'CHANGELOG.md', 'packages/example/CHANGELOG.md'])(
    'treats %s as release bookkeeping',
    (file) => {
      expect(isReleaseMetadata(file)).toBe(true);
    },
  );

  it.each(['.changeset/config.json', 'README.md', 'packages/example/src/index.ts'])(
    'does not treat %s as release bookkeeping',
    (file) => {
      expect(isReleaseMetadata(file)).toBe(false);
    },
  );
});

describe('versionBumpOnly', () => {
  it('accepts a diff that only moves the version', () => {
    const run = fakeGit([], { 'packages/example/package.json': bump });
    expect(versionBumpOnly('packages/example/package.json', RANGE, run)).toBe(true);
  });

  it('rejects a dependency slipped in beside the bump', () => {
    const run = fakeGit([], {
      'package.json': `${bump}\n+    "left-pad": "^1.3.0",`,
    });
    expect(versionBumpOnly('package.json', RANGE, run)).toBe(false);
  });

  it('rejects a file with no edits at all', () => {
    expect(versionBumpOnly('package.json', RANGE, fakeGit([]))).toBe(false);
  });
});

describe('decideScope', () => {
  it.each([
    [undefined, 'bbb'],
    ['aaa', undefined],
    ['0000000000000000000000000000000000000000', 'bbb'],
  ])('runs everything without a usable range (%s…%s)', (base, head) => {
    expect(decideScope(base, head, fakeGit([]))).toEqual({
      codeChanged: true,
      reason: 'no usable commit range',
    });
  });

  it('runs everything when the range cannot be diffed', () => {
    const run: Git = () => {
      throw new Error('bad object');
    };
    expect(decideScope('aaa', 'bbb', run).reason).toBe('could not diff the range');
  });

  it('runs everything on an empty diff', () => {
    expect(decideScope('aaa', 'bbb', fakeGit([])).reason).toBe('empty diff');
  });

  it('skips a release commit', () => {
    const run = fakeGit(
      [
        '.changeset/tidy-pandas-smile.md',
        'packages/example/CHANGELOG.md',
        'packages/example/package.json',
      ],
      { 'packages/example/package.json': bump },
    );
    const scope = decideScope('aaa', 'bbb', run);
    expect(scope.codeChanged).toBe(false);
    expect(scope.reason).toContain('release commit');
  });

  it('runs everything when a manifest changed more than its version', () => {
    const run = fakeGit(['package.json'], { 'package.json': `${bump}\n+  "private": true,` });
    expect(decideScope('aaa', 'bbb', run).codeChanged).toBe(true);
  });

  it('runs everything for a source change', () => {
    const scope = decideScope('aaa', 'bbb', fakeGit(['packages/example/src/index.ts']));
    expect(scope).toEqual({ codeChanged: true, reason: '1 file(s) changed' });
  });
});

describe('main', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  afterEach(() => {
    log.mockClear();
  });

  it('reports the verdict and always exits 0', () => {
    expect(main({}, { run: fakeGit([]) })).toBe(0);
    expect(log).toHaveBeenCalledWith('check-scope: code-changed=true');
  });

  it('writes the step output when the workflow provides a file for it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-scope-'));
    const output = join(dir, 'output');
    try {
      main({ BASE_SHA: 'aaa', HEAD_SHA: 'bbb', GITHUB_OUTPUT: output }, { run: fakeGit(['a.ts']) });
      expect(readFileSync(output, 'utf8')).toBe('code-changed=true\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('git', () => {
  it('runs git for real', () => {
    expect(git('rev-parse', '--is-inside-work-tree').trim()).toBe('true');
  });
});

describe('the entry point', () => {
  it('prints a verdict when run as a script', () => {
    const script = fileURLToPath(new URL('./check-scope.ts', import.meta.url));
    const out = execFileSync(process.execPath, ['--import', 'tsx', script], {
      encoding: 'utf8',
      env: { ...process.env, BASE_SHA: '', HEAD_SHA: '', GITHUB_OUTPUT: '' },
    });
    expect(out).toContain('code-changed=true');
  });
});
