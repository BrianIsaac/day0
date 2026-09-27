import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { temporaryDirectories } from './temporary-directories';

const temporary = temporaryDirectories();
let first = '';

describe('temporaryDirectories', () => {
  it('makes a directory with the prefix', () => {
    first = temporary('day0-temporary-');
    expect(existsSync(first)).toBe(true);
    expect(first).toMatch(/day0-temporary-[^/]+$/);
  });

  it('has removed it by the next test', () => {
    expect(first).not.toBe('');
    expect(existsSync(first)).toBe(false);
  });
});
