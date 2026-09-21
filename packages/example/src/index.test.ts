import { describe, expect, it } from 'vitest';
import { greet } from './index.js';

describe('greet', () => {
  it('greets by name', () => {
    expect(greet('Ada')).toBe('Hello, Ada.');
  });

  it('can be excited about it', () => {
    expect(greet('Ada', { excited: true })).toBe('Hello, Ada!');
  });

  it('trims the name', () => {
    expect(greet('  Ada  ')).toBe('Hello, Ada.');
  });

  it('refuses an empty name', () => {
    expect(() => greet('   ')).toThrow(TypeError);
  });
});
