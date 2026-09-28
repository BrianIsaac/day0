import { describe, expect, it } from 'vitest';
import { escapeRegExp } from '../../../src/lib/regex';

describe('escapeRegExp', (): void => {
  it('makes every metacharacter match itself', (): void => {
    const value = 'a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o';
    expect(new RegExp(`^${escapeRegExp(value)}$`).test(value)).toBe(true);
    expect(new RegExp(`^${escapeRegExp('a.c')}$`).test('abc')).toBe(false);
  });

  it('leaves a plain word alone', (): void => {
    expect(escapeRegExp('linear')).toBe('linear');
  });
});
