'use client';

import { ClerkProvider, useAuth } from '@clerk/nextjs';
import { ConvexProviderWithAuth, ConvexReactClient, useConvexAuth } from 'convex/react';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { DEV_NO_AUTH } from '@/lib/dev-auth';

/**
 * Wraps with Clerk + Convex. Clerk auto-provisions keyless dev keys when
 * `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is unset, so we don't need to
 * special-case the unconfigured path.
 *
 * In no-auth dev mode Clerk is left out of the tree entirely, but Convex still
 * gets a real token: this machine mints one for the fixed local subject and the
 * deployment verifies its signature. The browser can only obtain one after it
 * has been unlocked with the local key, so the same provider shape serves both
 * modes and only the issuer differs.
 */
export function Providers({ children }: { children: ReactNode }) {
  const client = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) {
      throw new Error('NEXT_PUBLIC_CONVEX_URL is not set — run `pnpm convex:dev` first');
    }
    return new ConvexReactClient(url);
  }, []);

  if (DEV_NO_AUTH) {
    return (
      <ConvexProviderWithAuth client={client} useAuth={useDevNoAuth}>
        <DevNoAuthGate>{children}</DevNoAuthGate>
      </ConvexProviderWithAuth>
    );
  }

  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

/**
 * The no-auth equivalent of Clerk's `useAuth`. `/api/dev-auth/token` answers
 * only for a browser holding the unlock cookie, so a null token here means this
 * browser has no business acting as the local boss.
 */
function useDevNoAuth() {
  const [state, setState] = useState({ isLoading: true, isAuthenticated: false });

  const fetchAccessToken = useCallback(async () => {
    const res = await fetch('/api/dev-auth/token', { method: 'POST', cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    return typeof body.token === 'string' ? body.token : null;
  }, []);

  useEffect(() => {
    let current = true;
    fetchAccessToken()
      .catch(() => null)
      .then((token) => {
        if (current) setState({ isLoading: false, isAuthenticated: token !== null });
      });
    return () => {
      current = false;
    };
  }, [fetchAccessToken]);

  return { ...state, fetchAccessToken };
}

/**
 * Holds the app back until the deployment has accepted the local token. Without
 * it every query on the first render would run unauthenticated and throw, which
 * reads as a broken app rather than a locked one.
 */
function DevNoAuthGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();

  if (isAuthenticated) return <>{children}</>;

  return (
    <main className="min-h-[calc(100vh-3.25rem)] grid place-items-center px-6">
      <p className="max-w-md text-center text-sm text-[var(--color-muted)]">
        {isLoading
          ? 'Unlocking this machine’s local session…'
          : 'This browser could not obtain a local session key. Open the unlock URL that `pnpm dev` printed, and check that the Convex deployment has DEV_NO_AUTH_JWKS set.'}
      </p>
    </main>
  );
}
