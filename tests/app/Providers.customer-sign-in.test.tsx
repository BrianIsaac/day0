/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from '../fixtures/dom/axe';
import { mount, unmountAll } from '../fixtures/dom/press';
import { syncServer, type SyncServer } from '../fixtures/convex/sync-socket';

/**
 * Under the customer-local profile the browser signs in through the customer's issuer: Convex on
 * the token route's ID token, a gate like the no-auth one, and Clerk never loaded (Q16).
 */
vi.mock('@clerk/nextjs', () => ({
  ClerkProvider: (): never => {
    throw new Error('Clerk must never load under the customer-local profile');
  },
  useAuth: (): never => {
    throw new Error('Clerk must never load under the customer-local profile');
  },
  useClerk: (): never => {
    throw new Error('Clerk must never load under the customer-local profile');
  },
}));
vi.mock('convex/react-clerk', () => ({
  ConvexProviderWithClerk: (): never => {
    throw new Error('Clerk must never load under the customer-local profile');
  },
}));
vi.mock('next/navigation', () => ({ usePathname: (): string => '/agent/j57agent' }));

/** An ID token the fake deployment reads the subject of. */
function idToken(sub: string): string {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ sub, iat: now, exp: now + 3600 })}.c2ln`;
}

/** Let every message between the client and the deployment land. */
async function exchange(server: SyncServer): Promise<void> {
  let seen = -1;
  for (let turn = 0; turn < 200; turn += 1) {
    await act(async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (server.quiet() && server.sent.length === seen) return;
    seen = server.sent.length;
  }
  throw new Error('the exchange with the deployment was still going');
}

function customerProfile(): void {
  vi.stubEnv('NEXT_PUBLIC_DAY0_PROFILE', 'customer-local');
  vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://customer-test.convex.cloud');
}

/** The token route as the test sets it: each call answers with the next response. */
function tokenRoute(...answers: Array<() => Response>): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  let call = 0;
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.endsWith('/api/auth/oidc/token')) throw new Error(`unexpected fetch ${url}`);
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return answer();
    },
  );
  return bodies;
}

function signedInAnswer(): Response {
  return Response.json({
    token: idToken('https://issuer.acme.test|fake-oidc|priya'),
    expiresAt: Date.now() + 3_600_000,
    account: { name: 'Priya Raman', email: 'priya@acme.test' },
  });
}

async function mountProviders(): Promise<{ container: HTMLElement; server: SyncServer }> {
  const server = syncServer(() => undefined);
  vi.stubGlobal('WebSocket', server.Socket);
  const { Providers, SessionGate } = await import('../../app/Providers');
  const view = mount(
    <Providers>
      <SessionGate fallback={<p>loading your employees…</p>}>
        <p>owned</p>
      </SessionGate>
    </Providers>,
  );
  await exchange(server);
  return { container: view.container, server };
}

afterEach((): void => {
  unmountAll();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the customer-local providers', (): void => {
  it('draws the customer gate, never Clerk, under the profile', async (): Promise<void> => {
    customerProfile();
    const { Providers } = await import('../../app/Providers');
    const html = renderToStaticMarkup(
      <Providers>
        <p>owned</p>
      </Providers>,
    );
    expect(html).toMatch(/^<main id="main" tabindex="-1"/);
    expect(html).toContain('Signing you in');
    expect(html).not.toContain('owned');
  });

  it('lets the pages in once Convex holds the ID token the token route hands over', async (): Promise<void> => {
    customerProfile();
    const asked = tokenRoute(signedInAnswer);
    const { container } = await mountProviders();
    expect(container.textContent).toBe('owned');
    expect(asked[0]).toEqual({ force: false });
  });

  it('says the person is signed out, with the way back to the page they were on, when the route has no session', async (): Promise<void> => {
    customerProfile();
    tokenRoute(() => Response.json({ signedOut: true }, { status: 401 }));
    const { container } = await mountProviders();
    expect(container.querySelector('h1')?.textContent).toBe('You are signed out');
    const signIn = container.querySelector('a');
    expect(signIn?.getAttribute('href')).toBe('/api/auth/oidc/login?returnTo=%2Fagent%2Fj57agent');
    expect(signIn?.className).toContain('min-h-11');
    expect(await axeViolations(container)).toEqual([]);
  });

  it('asks again before giving up when the sign-in service is briefly unreachable', async (): Promise<void> => {
    customerProfile();
    const asked = tokenRoute(
      () => Response.json({ error: 'try again' }, { status: 503 }),
      signedInAnswer,
    );
    const { container, server } = await mountProviders();
    await act(async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    });
    await exchange(server);
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toBe('owned');
  });

  it('passes an owned page straight through its own session gate, as the whole tree is held above', async (): Promise<void> => {
    customerProfile();
    const { SessionGate } = await import('../../app/Providers');
    const html = renderToStaticMarkup(
      <SessionGate fallback={<p>held</p>}>
        <p>owned</p>
      </SessionGate>,
    );
    expect(html).toBe('<p>owned</p>');
  });

  it('has a pending frame axe passes', async (): Promise<void> => {
    customerProfile();
    tokenRoute(() => new Response(null, { status: 500 }));
    const { Providers } = await import('../../app/Providers');
    const holder = document.createElement('div');
    holder.innerHTML = renderToStaticMarkup(
      <Providers>
        <p>owned</p>
      </Providers>,
    );
    document.body.append(holder);
    expect(await axeViolations(holder)).toEqual([]);
    holder.remove();
  });
});
