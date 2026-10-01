import { describe, expect, it } from 'vitest';
import { reviewHref, TRANSFER_PARAMETER } from '../../../app/home/transfer-link';

describe('transfer-link', () => {
  it('names the request on the home, which opens the acceptance dialog', () => {
    expect(TRANSFER_PARAMETER).toBe('transfer');
    expect(reviewHref('pd75wvebdzqmgg9bx61nnh3kd58fenm8')).toBe(
      '/?transfer=pd75wvebdzqmgg9bx61nnh3kd58fenm8',
    );
  });

  it('encodes what it is given, so an id never changes the address it sits in', () => {
    expect(reviewHref('a&b=c')).toBe('/?transfer=a%26b%3Dc');
  });
});
