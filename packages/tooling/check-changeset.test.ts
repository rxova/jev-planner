import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  check,
  gitDiff,
  hasChangeset,
  labelsOf,
  main,
  SKIP_LABEL,
  touchesPackage,
} from './check-changeset.js';

describe('touchesPackage', () => {
  it('sees a source change', () => {
    expect(touchesPackage(['packages/example/src/index.ts'])).toBe(true);
  });

  it.each([
    'packages/example/README.md',
    'packages/example/src/index.test.ts',
    'packages/example/src/__tests__/fixture.ts',
    'packages/tooling/verify.ts',
    'packages/config/tsdown.base.ts',
    'apps/docs/src/content/docs/index.mdx',
    '.github/workflows/ci.yml',
    'README.md',
  ])('does not count %s as publishable', (file) => {
    expect(touchesPackage([file])).toBe(false);
  });

  it('is true as soon as one file in the set ships', () => {
    expect(touchesPackage(['README.md', 'packages/example/src/index.ts'])).toBe(true);
  });

  it('is false for an empty diff', () => {
    expect(touchesPackage([])).toBe(false);
  });
});

describe('hasChangeset', () => {
  it('recognises a changeset', () => {
    expect(hasChangeset(['.changeset/tidy-pandas-smile.md'])).toBe(true);
  });

  it.each(['.changeset/README.md', '.changeset/config.json', 'docs/changeset.md'])(
    'does not accept %s',
    (file) => {
      expect(hasChangeset([file])).toBe(false);
    },
  );
});

describe('check', () => {
  it('requires nothing when nothing publishable changed', () => {
    const verdict = check(['packages/tooling/verify.ts']);
    expect(verdict.exitCode).toBe(0);
    expect(verdict.message).toContain('no publishable change');
  });

  it('is satisfied by a changeset alongside the change', () => {
    const verdict = check(['packages/example/src/index.ts', '.changeset/tidy-pandas-smile.md']);
    expect(verdict.exitCode).toBe(0);
    expect(verdict.message).toContain('changeset present');
  });

  it('fails a publishable change with no changeset, and says what to do', () => {
    const verdict = check(['packages/example/src/index.ts']);
    expect(verdict.exitCode).toBe(1);
    expect(verdict.message).toContain('adds no changeset');
    expect(verdict.message).toContain('pnpm changeset');
    expect(verdict.message).toContain(SKIP_LABEL);
  });

  it('asks for nothing when the pull request carries the label', () => {
    const verdict = check(['packages/example/package.json'], ['dependencies', SKIP_LABEL]);
    expect(verdict.exitCode).toBe(0);
    expect(verdict.message).toContain(SKIP_LABEL);
  });

  it('is not satisfied by some other label', () => {
    expect(check(['packages/example/src/index.ts'], ['dependencies']).exitCode).toBe(1);
  });
});

describe('labelsOf', () => {
  it('reads the comma-separated list the workflow hands over', () => {
    expect(labelsOf('dependencies,skip-changeset')).toEqual(['dependencies', 'skip-changeset']);
  });

  it('tolerates spacing, and an unlabelled pull request', () => {
    expect(labelsOf(' dependencies , skip-changeset ')).toEqual(['dependencies', 'skip-changeset']);
    expect(labelsOf('')).toEqual([]);
    expect(labelsOf(undefined)).toEqual([]);
  });
});

describe('main', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  afterEach(() => {
    log.mockClear();
    error.mockClear();
  });

  it('refuses to guess when the range is missing', () => {
    expect(main({})).toBe(1);
    expect(main({ BASE_SHA: 'a' })).toBe(1);
    expect(main({ HEAD_SHA: 'b' })).toBe(1);
    expect(error).toHaveBeenCalledWith('check-changeset: BASE_SHA and HEAD_SHA must be set');
  });

  it('asks for the diff of exactly the range it was given', () => {
    const diff = vi.fn(() => ['packages/tooling/verify.ts']);
    expect(main({ BASE_SHA: 'aaa', HEAD_SHA: 'bbb' }, { diff })).toBe(0);
    expect(diff).toHaveBeenCalledWith('aaa', 'bbb');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no publishable change'));
  });

  it('reports a missing changeset on stderr and exits 1', () => {
    const diff = () => ['packages/example/src/index.ts'];
    expect(main({ BASE_SHA: 'aaa', HEAD_SHA: 'bbb' }, { diff })).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('adds no changeset'));
  });

  it('reads the label from the environment the workflow sets', () => {
    const diff = () => ['packages/example/package.json'];
    const env = { BASE_SHA: 'aaa', HEAD_SHA: 'bbb', PR_LABELS: `dependencies,${SKIP_LABEL}` };
    expect(main(env, { diff })).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(SKIP_LABEL));
  });
});

describe('gitDiff', () => {
  it('lists the files an empty range changed — none', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(gitDiff(head, head)).toEqual([]);
  });
});

describe('the entry point', () => {
  it('sets the process exit code from main', () => {
    const script = fileURLToPath(new URL('./check-changeset.ts', import.meta.url));
    let status = 0;
    try {
      // No range in the environment: the one failure that needs no repository.
      execFileSync(process.execPath, ['--import', 'tsx', script], {
        encoding: 'utf8',
        stdio: 'pipe',
        env: { ...process.env, BASE_SHA: '', HEAD_SHA: '' },
      });
    } catch (failure) {
      status = (failure as { status: number }).status;
    }
    expect(status).toBe(1);
  });
});
