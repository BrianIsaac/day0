import { describe, expect, it } from 'vitest';
import { personNameKey } from '../../../src/people/vocabulary';

describe('people vocabulary', (): void => {
  it('keys a name by its words alone, so case, spacing and accents never make two people of one', (): void => {
    expect(personNameKey('  Priya   Shah ')).toBe('priya shah');
    expect(personNameKey('PRIYA SHAH')).toBe('priya shah');
    expect(personNameKey('Zoë Müller')).toBe('zoe muller');
    expect(personNameKey('Ｐｒｉｙａ')).toBe('priya');
  });

  it('keys a name with no letters or digits as empty, so it matches nobody', (): void => {
    expect(personNameKey(' - ')).toBe('');
    expect(personNameKey('')).toBe('');
  });

  it('keeps the letters of a script without case, and the digits of a name', (): void => {
    expect(personNameKey('李 明')).toBe('李 明');
    expect(personNameKey('Agent 007')).toBe('agent 007');
  });
});
