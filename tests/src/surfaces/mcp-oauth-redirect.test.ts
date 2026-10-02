import { describe, expect, it } from 'vitest';
import { mcpAuthorisationLanding, readMcpRedirect } from '../../../src/surfaces/mcp-oauth-redirect';

const ORIGIN = 'https://day0.acme.test';

describe('reading the authorisation response', (): void => {
  it('hands on the state with the code or the error and the iss, never the description', (): void => {
    expect(
      readMcpRedirect(new URLSearchParams({ state: 's', code: 'c', iss: 'https://a.test' })),
    ).toEqual({ state: 's', code: 'c', iss: 'https://a.test' });
    expect(
      readMcpRedirect(
        new URLSearchParams({ state: 's', error: 'access_denied', error_description: 'x' }),
      ),
    ).toEqual({ state: 's', error: 'access_denied' });
  });

  it('refuses a response that names the state, the code, the iss or the error twice', (): void => {
    for (const repeated of ['state', 'code', 'iss', 'error']) {
      const params = new URLSearchParams({ state: 's', code: 'c', iss: 'i' });
      params.append(repeated, 'again');
      params.append(repeated, 'and again');
      expect(readMcpRedirect(params)).toBeUndefined();
    }
  });

  it('refuses a response with no state, or with neither a code nor an error', (): void => {
    expect(readMcpRedirect(new URLSearchParams({ code: 'c' }))).toBeUndefined();
    expect(readMcpRedirect(new URLSearchParams({ state: 's', iss: 'i' }))).toBeUndefined();
  });
});

describe('where the browser lands', (): void => {
  it('lands on the card when the deployment names it, with its reason on a failure', (): void => {
    const landed = mcpAuthorisationLanding(ORIGIN, {
      ok: false,
      agentId: 'j57 agent',
      surfaceSlug: 'docs',
      reason: 'Declined.',
    });
    expect(landed.pathname).toBe('/agent/j57%20agent');
    expect(Object.fromEntries(landed.searchParams)).toEqual({
      authorisation: 'failed',
      surface: 'docs',
      reason: 'Declined.',
    });
    expect(landed.hash).toBe('#surfaces');
  });

  it('lands on the dashboard for a response refused before the deployment, or a card it could not name', (): void => {
    expect(mcpAuthorisationLanding(ORIGIN, 'invalid').href).toBe(
      `${ORIGIN}/?authorisation=invalid#surfaces`,
    );
    expect(mcpAuthorisationLanding(ORIGIN, { ok: false, reason: 'Expired.' }).pathname).toBe('/');
  });

  it('carries no reason on a success', (): void => {
    const landed = mcpAuthorisationLanding(ORIGIN, {
      ok: true,
      agentId: 'a',
      surfaceSlug: 'docs',
      reason: 'ignored',
    });
    expect(landed.searchParams.get('reason')).toBeNull();
    expect(landed.searchParams.get('authorisation')).toBe('authorised');
  });
});
