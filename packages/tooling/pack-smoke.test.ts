import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  binsOf,
  main,
  packSmoke,
  probeSource,
  shell,
  workspace,
  type Shell,
  type Workspace,
} from './pack-smoke.js';

const SCRATCH = '/scratch';

/** An in-memory workspace holding one package manifest. */
const memory = (manifest: object, { tarball = true } = {}) => {
  const files = new Map<string, string>([[join('/pkg', 'package.json'), JSON.stringify(manifest)]]);
  const removed: string[] = [];
  const fs: Workspace = {
    make: () => SCRATCH,
    list: () => (tarball ? ['rxova-example-0.1.0.tgz'] : []),
    read: (file) => files.get(file) ?? '',
    write: (file, contents) => void files.set(file, contents),
    remove: (dir) => void removed.push(dir),
  };
  return { fs, files, removed };
};

/** A shell that answers like a healthy npm, with per-command overrides. */
const npm =
  (overrides: { version?: string; probe?: string } = {}): Shell =>
  (command, args) => {
    if (command === 'npx') return `${overrides.version ?? '1.2.3'}\n`;
    if (command === 'node') return `${overrides.probe ?? 'ok'}\n`;
    return args.join(' ');
  };

describe('binsOf', () => {
  it('names a string bin after the package, scope dropped', () => {
    expect(binsOf({ name: '@rxova/example', version: '1.0.0', bin: './dist/cli.js' })).toEqual([
      'example',
    ]);
  });

  it('lists every key of a bin map', () => {
    expect(binsOf({ name: 'x', version: '1.0.0', bin: { a: './a.js', b: './b.js' } })).toEqual([
      'a',
      'b',
    ]);
  });

  it('is empty for a library with no bin', () => {
    expect(binsOf({ name: 'x', version: '1.0.0' })).toEqual([]);
  });
});

describe('probeSource', () => {
  it('imports the package by name through its exports map', () => {
    expect(probeSource('@rxova/example')).toContain('await import("@rxova/example")');
  });
});

describe('packSmoke', () => {
  it('packs, installs, imports, and cleans up', () => {
    const { fs, files, removed } = memory({ name: '@rxova/example', version: '0.1.0' });
    const calls: string[] = [];
    const sh: Shell = (command, args, cwd) => {
      calls.push(`${command} ${args[0] ?? ''} @ ${cwd}`);
      return npm()(command, args, cwd);
    };

    expect(packSmoke({ pkgDir: '/pkg', sh, fs })).toBe(
      'pack:smoke ok — @rxova/example@0.1.0 installs and imports from a tarball',
    );
    expect(calls).toEqual([
      'npm pack @ /pkg',
      `npm install @ ${SCRATCH}`,
      `node ${join(SCRATCH, 'probe.mjs')} @ ${SCRATCH}`,
    ]);
    expect(files.get(join(SCRATCH, 'probe.mjs'))).toContain('@rxova/example');
    expect(removed).toEqual([SCRATCH]);
  });

  it('runs every bin the package declares', () => {
    const { fs } = memory({ name: 'tool', version: '1.2.3', bin: { tool: './dist/cli.js' } });
    const sh = vi.fn(npm());
    packSmoke({ pkgDir: '/pkg', sh, fs });
    expect(sh).toHaveBeenCalledWith('npx', ['--no-install', 'tool', '--version'], SCRATCH);
  });

  it('fails when npm pack wrote no tarball, and still cleans up', () => {
    const { fs, removed } = memory({ name: 'x', version: '1.0.0' }, { tarball: false });
    expect(() => packSmoke({ pkgDir: '/pkg', sh: npm(), fs })).toThrow('produced no tarball');
    expect(removed).toEqual([SCRATCH]);
  });

  it('fails when a bin prints something that is not a version', () => {
    const { fs } = memory({ name: 'tool', version: '1.0.0', bin: './cli.js' });
    expect(() =>
      packSmoke({ pkgDir: '/pkg', sh: npm({ version: 'command not found' }), fs }),
    ).toThrow('unusable version');
  });

  it('fails when the probe does not print ok', () => {
    const { fs } = memory({ name: 'x', version: '1.0.0' });
    expect(() => packSmoke({ pkgDir: '/pkg', sh: npm({ probe: 'boom' }), fs })).toThrow(
      'probe failed: boom',
    );
  });
});

describe('main', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  afterEach(() => {
    log.mockClear();
    error.mockClear();
  });

  it('prints the verdict and exits 0', () => {
    const { fs } = memory({ name: 'x', version: '1.0.0' });
    expect(main('/pkg', { sh: npm(), fs })).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pack:smoke ok'));
  });

  it('prints the failure and exits 1', () => {
    const { fs } = memory({ name: 'x', version: '1.0.0' }, { tarball: false });
    expect(main('/pkg', { sh: npm(), fs })).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('pack:smoke failed'));
  });
});

describe('the real shell and workspace', () => {
  it('runs a command and returns its output', () => {
    expect(shell(process.execPath, ['-e', 'process.stdout.write("hi")'], process.cwd())).toBe('hi');
  });

  it('makes, writes, reads, lists and removes a scratch directory', () => {
    const dir = workspace.make();
    const file = join(dir, 'a.txt');
    workspace.write(file, 'hello');
    expect(workspace.read(file)).toBe('hello');
    expect(workspace.list(dir)).toEqual(['a.txt']);
    mkdirSync(join(dir, 'nested'));
    workspace.remove(dir);
    expect(existsSync(dir)).toBe(false);
    expect(() => readFileSync(file)).toThrow();
  });
});
