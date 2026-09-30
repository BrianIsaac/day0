/** @vitest-environment jsdom */

import type { ReactNode } from 'react';
import { act, useSyncExternalStore } from 'react';
import { ConvexProviderWithAuth, ConvexReactClient } from 'convex/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmountAll } from '../fixtures/dom/press';
import { syncServer } from '../fixtures/convex/sync-socket';

const recorded = vi.hoisted(() => ({ clerkStatus: 'ready' }));

vi.mock('@clerk/nextjs', () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
  useClerk: () => ({ status: recorded.clerkStatus }),
}));
vi.mock('next/navigation', () => ({ usePathname: (): string => '/agent/j57agent' }));

/** Convex's auth as the test sets it: loading until the test says Clerk has answered. */
const auth = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let state = { isLoading: true, isAuthenticated: false };
  return {
    read: () => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settle: (next: { isLoading: boolean; isAuthenticated: boolean }): void => {
      state = next;
      for (const listener of listeners) listener();
    },
  };
});

/** Convex's `useAuth` as the test's store answers it. */
function useAuthState() {
  const state = useSyncExternalStore(auth.subscribe, auth.read, auth.read);
  return { ...state, fetchAccessToken: async (): Promise<string | null> => null };
}

let client: ConvexReactClient | undefined;

beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('WebSocket', syncServer(() => undefined).Socket);
  vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', undefined);
});

afterEach(async (): Promise<void> => {
  unmountAll();
  vi.useRealTimers();
  await client?.close();
  client = undefined;
  auth.settle({ isLoading: true, isAuthenticated: false });
  recorded.clerkStatus = 'ready';
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function mountGate(): Promise<{ container: HTMLElement; waitMs: number }> {
  const { SessionGate, SESSION_WAIT_MS } = await import('../../app/Providers');
  client = new ConvexReactClient('https://session-wait-test.convex.cloud');
  const view = mount(
    <ConvexProviderWithAuth client={client} useAuth={useAuthState}>
      <SessionGate fallback={<p>loading employee…</p>}>
        <p>owned</p>
      </SessionGate>
    </ConvexProviderWithAuth>,
  );
  return { container: view.container, waitMs: SESSION_WAIT_MS };
}

async function advance(ms: number): Promise<void> {
  await act(async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('the owned page while Convex never confirms the sign-in', (): void => {
  it('holds its fallback up to the wait, then says the sign-in has not been confirmed', async (): Promise<void> => {
    const { container, waitMs } = await mountGate();
    await advance(waitMs - 1);
    expect(container.textContent).toBe('loading employee…');

    await advance(1);
    expect(container.querySelector('h1')?.textContent).toBe('Day0 has not confirmed your sign-in');
    expect(container.textContent).not.toContain('loading employee…');
    expect(container.textContent).not.toContain('owned');
    expect([...container.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Try again',
    ]);
  });

  it('leaves the overdue line as soon as Convex answers, and times a later wait afresh', async (): Promise<void> => {
    const { container, waitMs } = await mountGate();
    await advance(waitMs);
    expect(container.querySelector('h1')?.textContent).toBe('Day0 has not confirmed your sign-in');

    act((): void => auth.settle({ isLoading: false, isAuthenticated: false }));
    await advance(0);
    // Clerk still holds the session here, so the settled answer is the refused sign-in's.
    expect(container.querySelector('h1')?.textContent).toBe('Day0 could not confirm your sign-in');

    act((): void => auth.settle({ isLoading: true, isAuthenticated: false }));
    await advance(waitMs - 1);
    expect(container.textContent).toBe('loading employee…');
    await advance(1);
    expect(container.querySelector('h1')?.textContent).toBe('Day0 has not confirmed your sign-in');
  });

  it('starts no wait when Clerk failed to load, which lets the page through to say what it can', async (): Promise<void> => {
    recorded.clerkStatus = 'error';
    const { container, waitMs } = await mountGate();
    await advance(waitMs * 2);
    expect(container.textContent).toBe('owned');
  });
});
