import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The ElevenLabs start route under the customer-local profile (the wave 10 review, M7): the
 * caller is the session the company sign-in sealed, and Clerk is never asked. Every day-zero page
 * asks this route whether voice is configured, so a route that asked Clerk answered 500 there.
 */

const SECRET = 'c'.repeat(43);

/** The route under the profile, with the browser holding `cookie` as its session, if any. */
async function startUnderProfile(cookie: string | undefined): Promise<Response> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_DAY0_PROFILE', 'customer-local');
  vi.stubEnv('DAY0_PROFILE', 'customer-local');
  vi.stubEnv('DAY0_SESSION_SECRET', SECRET);
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://customer-test.convex.cloud');
  vi.stubEnv('ELEVENLABS_API_KEY', '');
  vi.stubEnv('ELEVENLABS_AGENT_ID', '');
  vi.doMock('next/headers', () => ({
    cookies: async (): Promise<{ get: (name: string) => { value: string } | undefined }> => ({
      get: (name: string): { value: string } | undefined =>
        name === 'day0_session' && cookie ? { value: cookie } : undefined,
    }),
  }));
  vi.doMock('@clerk/nextjs/server', () => ({
    auth: (): never => {
      throw new Error('Clerk must not be asked under the customer-local profile');
    },
  }));
  const { GET } = await import('../../../../../../app/api/voice/elevenlabs/start/route');
  return await GET(new Request('http://localhost:3000/api/voice/elevenlabs/start?probe=1'));
}

/** A session the company sign-in sealed, with an ID token good for a minute. */
async function signedInSession(): Promise<string> {
  const { sealSession } = await import('../../../../../../src/lib/customer-session');
  return await sealSession(SECRET, {
    version: 1,
    idToken: 'header.claims.signature',
    idTokenExpiresAt: Date.now() + 60_000,
    startedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  });
}

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.doUnmock('next/headers');
  vi.doUnmock('@clerk/nextjs/server');
  vi.resetModules();
});

describe('the ElevenLabs start route under the customer-local profile (the wave 10 review, M7)', (): void => {
  it('answers the probe for a signed-in company session, never asking Clerk', async (): Promise<void> => {
    const response = await startUnderProfile(await signedInSession());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: false });
  });

  it('refuses with 401 when the browser holds no session', async (): Promise<void> => {
    const response = await startUnderProfile(undefined);

    expect(response.status).toBe(401);
  });
});
