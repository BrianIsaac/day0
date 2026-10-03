import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clerkAddresses,
  DEFAULT_CLERK_ADDRESSES,
  deploymentClerkAddresses,
} from '../../../src/lib/clerk-addresses';

afterEach((): void => {
  vi.unstubAllEnvs();
});

describe('clerkAddresses', (): void => {
  it("is Day0's own sign-in and sign-up pages when nothing is named", (): void => {
    expect(clerkAddresses({})).toEqual({
      signInUrl: '/sign-in',
      signUpUrl: '/sign-up',
      signInFallbackRedirectUrl: '/',
      signUpFallbackRedirectUrl: '/',
    });
  });

  it('reads an empty or blank value as naming nothing', (): void => {
    expect(clerkAddresses({ signInUrl: '', signUpUrl: '   ' })).toEqual(DEFAULT_CLERK_ADDRESSES);
  });

  it('takes each named value over its default and leaves the others', (): void => {
    expect(clerkAddresses({ signInUrl: '/enter', signUpFallbackRedirectUrl: '/welcome' })).toEqual({
      ...DEFAULT_CLERK_ADDRESSES,
      signInUrl: '/enter',
      signUpFallbackRedirectUrl: '/welcome',
    });
  });
});

describe('deploymentClerkAddresses', (): void => {
  it('reads the four NEXT_PUBLIC_CLERK names the deployment sets', (): void => {
    vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_IN_URL', '/in');
    vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_UP_URL', '/up');
    vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL', '/after-in');
    vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL', '/after-up');
    expect(deploymentClerkAddresses()).toEqual({
      signInUrl: '/in',
      signUpUrl: '/up',
      signInFallbackRedirectUrl: '/after-in',
      signUpFallbackRedirectUrl: '/after-up',
    });
  });

  it('falls back to the defaults on a deployment that sets none of them, as Vercel production does', (): void => {
    vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_IN_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_UP_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL', undefined);
    vi.stubEnv('NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL', undefined);
    expect(deploymentClerkAddresses()).toEqual(DEFAULT_CLERK_ADDRESSES);
  });
});
