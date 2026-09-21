import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isEntry } from './entry.js';

describe('isEntry', () => {
  const script = pathToFileURL('/repo/packages/tooling/verify.ts').href;

  it('is true for the file Node was asked to run', () => {
    expect(isEntry(script, '/repo/packages/tooling/verify.ts')).toBe(true);
  });

  it('is false for a module that was only imported', () => {
    expect(isEntry(script, '/repo/node_modules/vitest/vitest.mjs')).toBe(false);
  });

  it('is false when there is no script at all, as in a REPL', () => {
    expect(isEntry(script, undefined)).toBe(false);
    expect(isEntry(script, '')).toBe(false);
  });
});
