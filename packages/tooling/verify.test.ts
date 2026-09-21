import { afterEach, describe, expect, it, vi } from 'vitest';
import { STEPS, shell, verify } from './verify.js';

describe('STEPS', () => {
  it('is the list CI runs, in the order CI runs it', () => {
    expect(STEPS.map(([name]) => name)).toEqual([
      'lint',
      'format',
      'build',
      'typecheck',
      'unit tests',
      'package exports',
      'pack smoke',
      'dependency versions',
      'unused code',
      'dependency dedupe',
      'audit',
    ]);
  });
});

describe('verify', () => {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  afterEach(() => {
    out.mockClear();
    err.mockClear();
  });

  it('runs every step in order and passes', () => {
    const ran: string[] = [];
    const code = verify(
      [
        ['first', 'echo one'],
        ['second', 'echo two'],
      ],
      { run: (command) => void ran.push(command) },
    );

    expect(code).toBe(0);
    expect(ran).toEqual(['echo one', 'echo two']);
    expect(out).toHaveBeenCalledWith('\nverify: all checks passed\n');
  });

  it('stops at the first failure and names it', () => {
    const ran: string[] = [];
    const code = verify(
      [
        ['first', 'echo one'],
        ['second', 'boom'],
        ['third', 'echo three'],
      ],
      {
        run: (command) => {
          ran.push(command);
          if (command === 'boom') throw new Error('exit 1');
        },
      },
    );

    expect(code).toBe(1);
    expect(ran).toEqual(['echo one', 'boom']);
    expect(err).toHaveBeenCalledWith('\nverify: second failed\n');
    expect(out).not.toHaveBeenCalledWith('\nverify: all checks passed\n');
  });

  it('announces each step before running it', () => {
    verify([['lint', 'echo lint']], { run: () => {} });
    expect(out).toHaveBeenCalledWith('\nverify: lint\n');
  });

  it('passes trivially on an empty list', () => {
    expect(verify([], { run: () => {} })).toBe(0);
  });
});

describe('shell', () => {
  it('runs a command', () => {
    expect(() => shell(`"${process.execPath}" -e "0"`)).not.toThrow();
  });

  it('throws when the command fails, which is what verify catches', () => {
    expect(() => shell(`"${process.execPath}" -e "process.exit(3)"`)).toThrow();
  });
});
