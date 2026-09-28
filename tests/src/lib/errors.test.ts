import { describe, expect, it } from 'vitest';
import { errorMessage } from '../../../src/lib/errors';

describe('errorMessage', (): void => {
  it("reads an Error's message", (): void => {
    expect(errorMessage(new Error('socket hang up'))).toBe('socket hang up');
  });

  it('renders a thrown string or object as text, and falls back when there is nothing to read', (): void => {
    expect(errorMessage('refused')).toBe('refused');
    expect(errorMessage({ code: 7 })).toBe('[object Object]');
    expect(errorMessage(new Error(''))).toBe('unknown error');
    expect(errorMessage(undefined, 'no reason given')).toBe('no reason given');
  });
});
