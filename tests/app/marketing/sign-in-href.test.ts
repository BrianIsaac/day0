import { describe, expect, it } from 'vitest';
import { SIGN_IN_HREF, signInHref } from '../../../app/marketing/sign-in-href';

describe('signInHref', () => {
  it('signs a visitor in to the home when no handover is named', () => {
    expect(signInHref(null)).toBe(SIGN_IN_HREF);
    expect(SIGN_IN_HREF).toBe('/sign-in');
  });

  it('carries a Review link’s handover back to the home through the sign-in', () => {
    const href = signInHref('pd75wvebdzqmgg9bx61nnh3kd58fenm8');
    expect(href).toBe('/sign-in?redirect_url=%2F%3Ftransfer%3Dpd75wvebdzqmgg9bx61nnh3kd58fenm8');
    expect(new URL(href, 'https://day0.invalid').searchParams.get('redirect_url')).toBe(
      '/?transfer=pd75wvebdzqmgg9bx61nnh3kd58fenm8',
    );
  });

  it('carries nothing but an id’s own shape, so the address sends nobody elsewhere', () => {
    for (const value of ['', 'https://evil.example', '../x', 'a'.repeat(65), 'id with space']) {
      expect(signInHref(value), value).toBe(SIGN_IN_HREF);
    }
  });
});
