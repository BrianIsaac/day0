import { describe, expect, it } from 'vitest';
import {
  linearInstallLanding,
  LINEAR_INSTALL_UNAVAILABLE,
  readLinearRedirect,
} from '../../../../src/surfaces/identity-issuers/linear-redirect';

const ORIGIN = 'https://day0.acme.test';

describe('reading the installation redirect', (): void => {
  it('reads a code or an error with its state, never the description', (): void => {
    expect(readLinearRedirect(new URLSearchParams('state=s&code=c&error_description=x'))).toEqual({
      state: 's',
      code: 'c',
    });
    expect(readLinearRedirect(new URLSearchParams('state=s&error=access_denied'))).toEqual({
      state: 's',
      error: 'access_denied',
    });
  });

  it('refuses no state, neither a code nor an error, and a repeated parameter', (): void => {
    expect(readLinearRedirect(new URLSearchParams('code=c'))).toBeUndefined();
    expect(readLinearRedirect(new URLSearchParams('state=s'))).toBeUndefined();
    expect(readLinearRedirect(new URLSearchParams('state=s&code=a&code=b'))).toBeUndefined();
    expect(readLinearRedirect(new URLSearchParams('state=a&state=b&code=c'))).toBeUndefined();
  });
});

describe('where the browser lands', (): void => {
  it("is the employee's Surfaces tab with the outcome, or the dashboard when no card was named", (): void => {
    expect(
      linearInstallLanding(ORIGIN, {
        ok: true,
        agentId: 'j57 agent',
        surfaceSlug: 'linear',
      }).toString(),
    ).toBe(`${ORIGIN}/agent/j57%20agent?install=installed&surface=linear#surfaces`);
    expect(
      linearInstallLanding(ORIGIN, { ok: false, reason: LINEAR_INSTALL_UNAVAILABLE }).toString(),
    ).toBe(
      `${ORIGIN}/?install=failed&reason=${encodeURIComponent(LINEAR_INSTALL_UNAVAILABLE).replace(/%20/g, '+')}#surfaces`,
    );
    expect(linearInstallLanding(ORIGIN, 'invalid').toString()).toBe(
      `${ORIGIN}/?install=invalid#surfaces`,
    );
  });
});
