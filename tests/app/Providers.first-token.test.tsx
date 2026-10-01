/** @vitest-environment jsdom */

import type { ReactNode } from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmountAll } from '../fixtures/dom/press';
import { syncServer, type SyncServer } from '../fixtures/convex/sync-socket';

/**
 * Clerk as a visit going from signed out to signed in sees it, without a reload: its token for the
 * new session is fetched only once the test lets it through, as the token route answers after
 * the redirect (the wave 9 review's stage 6, decision 6).
 */
const clerk = vi.hoisted(() => {
  interface ClerkAuth {
    readonly isLoaded: boolean;
    readonly isSignedIn?: boolean;
    readonly sessionId?: string;
    readonly getToken: () => Promise<string | null>;
  }
  const listeners = new Set<() => void>();
  let release: ((token: string | null) => void) | undefined;
  const getToken = async (): Promise<string | null> =>
    await new Promise<string | null>((resolve) => {
      release = resolve;
    });
  let auth: ClerkAuth = { isLoaded: true, isSignedIn: false, getToken };
  return {
    getToken,
    read: (): ClerkAuth => auth,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    answer: (next: Omit<ClerkAuth, 'getToken'>): void => {
      auth = { ...next, getToken };
      for (const listener of listeners) listener();
    },
    /** Let the pending token fetch answer, with a token or with none. */
    release: (token: string | null): void => {
      release?.(token);
    },
  };
});

vi.mock('@clerk/nextjs', async () => {
  const { useSyncExternalStore } = await import('react');
  const useClerkAuth = () => useSyncExternalStore(clerk.subscribe, clerk.read, clerk.read);
  return {
    ClerkProvider: ({ children }: { children: ReactNode }) => children,
    useAuth: useClerkAuth,
    useClerk: () => ({ status: 'ready', signOut: async (): Promise<void> => undefined }),
  };
});
vi.mock('next/navigation', () => ({ usePathname: (): string => '/' }));

/** A token the fake deployment reads the subject of. */
function token(sub: string): string {
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

async function mountGate(): Promise<{ container: HTMLElement; server: SyncServer }> {
  const server = syncServer(() => undefined);
  vi.stubGlobal('WebSocket', server.Socket);
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://first-token-test.convex.cloud');
  vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
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
  clerk.answer({ isLoaded: true, isSignedIn: false });
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the first frame after a sign-in, before Convex has the new session’s token (decision 6, X-m1)', (): void => {
  it('holds the page as pending, never as a refused sign-in, until the token is fetched and confirmed', async (): Promise<void> => {
    const { container, server } = await mountGate();
    expect(container.querySelector('h1')?.textContent).toBe('You are signed out');

    act((): void => clerk.answer({ isLoaded: true, isSignedIn: true, sessionId: 'sess_a' }));
    await act(async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toBe('loading your employees…');
    expect(container.textContent).not.toContain('could not confirm');

    act((): void => clerk.release(token('user_1')));
    await exchange(server);
    expect(container.textContent).toBe('owned');
  });

  it('says the sign-in could not be confirmed once the fetch settles with no token', async (): Promise<void> => {
    const { container, server } = await mountGate();
    act((): void => clerk.answer({ isLoaded: true, isSignedIn: true, sessionId: 'sess_a' }));
    await act(async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toBe('loading your employees…');

    act((): void => clerk.release(null));
    await exchange(server);
    expect(container.querySelector('h1')?.textContent).toBe('Day0 could not confirm your sign-in');
  });
});
