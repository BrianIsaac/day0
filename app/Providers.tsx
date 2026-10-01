'use client';

import { ClerkProvider, useAuth, useClerk } from '@clerk/nextjs';
import { ConvexProviderWithAuth, ConvexReactClient, useConvexAuth } from 'convex/react';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { usePathname } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { errorMessage } from '@/lib/errors';
import { log } from '@/lib/logger';
import { Button, ButtonLink } from './components/Button';

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
    return url ? new ConvexReactClient(url) : null;
  }, []);

  // Prerender can run before local setup; backend-dependent children need
  // both providers and must wait until a configured build serves them. The
  // address is inlined at build time, so a production build needs rebuilding,
  // not restarting, once the setup has written it.
  if (!client) {
    return (
      <main
        id="main"
        tabIndex={-1}
        className="min-h-screen grid place-items-center px-6 outline-none"
      >
        <p className="max-w-md text-center text-sm text-[var(--color-muted)]">
          Day0 is not configured yet. Complete the local setup, then build and start the app again.
        </p>
      </main>
    );
  }

  if (DEV_NO_AUTH) {
    return (
      <ConvexProviderWithAuth client={client} useAuth={useDevNoAuth}>
        <DevNoAuthGate>{children}</DevNoAuthGate>
      </ConvexProviderWithAuth>
    );
  }

  return (
    <ClerkProvider>
      <ClerkConvexProvider client={client}>{children}</ClerkConvexProvider>
    </ClerkProvider>
  );
}

/** The session the page last held, and how many times it has since changed to another. */
interface SessionEpoch {
  readonly last: string | null;
  readonly changes: number;
}

/**
 * Convex on Clerk's settled answer (`useSettledClerkAuth`), started afresh when the signed-in
 * session changes to another.
 *
 * Holding Clerk's answer through a re-resolve also holds it through a switch from one session to
 * another, where Clerk answers "not loaded" between the two: Convex would keep the first
 * session's token until it next renewed it, under a page drawing the second (second pass M4). So
 * a new session after an earlier one keys the provider anew, which clears the token and fetches
 * the new session's; the first session of a visit and a sign-out change nothing here.
 */
function ClerkConvexProvider({
  client,
  children,
}: {
  readonly client: ConvexReactClient;
  readonly children: ReactNode;
}) {
  const { sessionId } = useAuth();
  const [epoch, setEpoch] = useState<SessionEpoch>({ last: null, changes: 0 });
  // Kept from the previous render in state, as React's docs set out.
  if (sessionId && sessionId !== epoch.last) {
    setEpoch({ last: sessionId, changes: epoch.last === null ? epoch.changes : epoch.changes + 1 });
  }
  return (
    <ConvexProviderWithClerk key={epoch.changes} client={client} useAuth={useSettledClerkAuth}>
      {children}
    </ConvexProviderWithClerk>
  );
}

/** Clerk's answer about the session, as `useAuth` gives it. */
type ClerkAuth = ReturnType<typeof useAuth>;

/**
 * Clerk's `useAuth` for Convex, holding its last settled answer while Clerk re-resolves a session
 * mid-visit.
 *
 * Refreshing an expiring session, Clerk answers "not loaded" again for a moment. Handed on as it
 * is, Convex takes that for a sign-out: it clears the token and reruns every query as nobody, so
 * each owned one throws into the page's error boundary, or `SessionGate` takes the page away for
 * the moment. Held, Convex keeps the token it has and fetches the next through the same
 * `getToken`, as `useAccount` holds the dashboard. Only Clerk's own settled answer replaces it.
 */
function useSettledClerkAuth(): ClerkAuth {
  const auth = useAuth();
  const [settled, setSettled] = useState<ClerkAuth | null>(null);
  // Kept from the previous render in state, as React's docs set out, so a re-resolve can use it.
  if (auth.isLoaded && !sameSession(auth, settled)) setSettled(auth);
  return auth.isLoaded || settled === null ? auth : settled;
}

/** Whether two of Clerk's answers name the same session, as far as Convex's token depends on it. */
function sameSession(a: ClerkAuth, b: ClerkAuth | null): boolean {
  return (
    b !== null &&
    a.isSignedIn === b.isSignedIn &&
    a.sessionId === b.sessionId &&
    a.orgId === b.orgId &&
    a.orgRole === b.orgRole
  );
}

/**
 * How long an owned page waits for Convex to confirm the manager's sign-in before it says so: a
 * load takes one to four seconds on the hosted demo, and a deployment that does not answer, or a
 * Clerk whose token endpoint keeps failing, never settles at all.
 */
export const SESSION_WAIT_MS = 20_000;

/** What `SessionGate` is given: the owned page, and what stands in its place until it may run. */
export interface SessionGateProps {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
}

/**
 * Holds a page that reads the manager's own rows until Convex holds the manager's token.
 *
 * Clerk's script loads after the page has hydrated, and until it has answered Convex has no token
 * to send: a query the page subscribed to in the meantime runs as nobody, throws "not
 * authenticated", and the page lands in its error boundary (the hosted walk's M2, 30 September;
 * two full loads in fourteen). So an owned page renders `fallback` while Convex's own auth state
 * is loading and mounts once it has answered, as `DevNoAuthGate` does for no-auth dev mode.
 *
 * It goes round the owned pages rather than the whole tree: the header and the public pages
 * (`/setup`, `/walkthrough`, the marketing landing) read no owned row, and holding them would
 * hide their served HTML from every visitor until Clerk loaded. In no-auth dev mode the whole tree
 * is already held above, so the page passes straight through.
 *
 * Once Convex has answered that nobody is signed in, the owned page is taken away and the gate
 * says so (`SignedOut`): a sign-out in another tab, or a token the deployment would not accept,
 * would otherwise leave the manager's rows, address and controls drawn under a header that says
 * "Sign in" (the second review's x1).
 */
export function SessionGate({ children, fallback }: SessionGateProps) {
  if (DEV_NO_AUTH) return <>{children}</>;
  return <ClerkSessionGate fallback={fallback}>{children}</ClerkSessionGate>;
}

function ClerkSessionGate({ children, fallback }: SessionGateProps) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { status } = useClerk();
  const { isSignedIn } = useAuth();
  const overdue = useOverdue(isLoading && status !== 'error', SESSION_WAIT_MS);
  // A Clerk that failed to load never answers; the page is let through to say what it can.
  if (status === 'error') return <>{children}</>;
  if (isLoading) return overdue ? <SessionUnconfirmed /> : <>{fallback}</>;
  if (!isAuthenticated) return <SignedOut refused={isSignedIn === true} />;
  return <>{children}</>;
}

/**
 * Whether a wait has gone on longer than `limitMs`. False again as soon as the wait ends, and a
 * later wait is timed afresh.
 */
function useOverdue(waiting: boolean, limitMs: number): boolean {
  const [overdue, setOverdue] = useState(false);
  // Kept from the previous render in state, as React's docs set out: a wait that ended forgets it.
  if (!waiting && overdue) setOverdue(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      log.warn('sign-in not confirmed in time', { waitedMs: limitMs });
      setOverdue(true);
    }, limitMs);
    return () => clearTimeout(timer);
  }, [waiting, limitMs]);
  return waiting && overdue;
}

/** What `SessionPending` is given: the line saying what loads. */
export interface SessionPendingProps {
  readonly children: ReactNode;
}

/** What an owned page shows while Convex confirms the sign-in: one quiet line saying what loads. */
export function SessionPending({ children }: SessionPendingProps) {
  return (
    <div
      role="status"
      className="flex min-h-[calc(100vh-3.25rem)] items-center justify-center px-6 text-sm text-[var(--color-muted)]"
    >
      {children}
    </div>
  );
}

/**
 * What an owned page shows once Convex has not confirmed the sign-in within `SESSION_WAIT_MS`:
 * the deployment is not answering, or Clerk's token endpoint keeps failing. The page still comes
 * in by itself if the answer arrives; Try again loads it afresh.
 */
export function SessionUnconfirmed() {
  return (
    // Inside the page's own `main` (`MainTransition`), as the owned page it stands in for is.
    <div className="grid min-h-[calc(100vh-3.25rem)] place-items-center px-6">
      <div className="grid max-w-md justify-items-center gap-4 text-center">
        <h1 className="text-lg font-semibold">Still waiting for Day0 to confirm your sign-in</h1>
        <p className="text-sm text-[var(--color-muted)]">
          This is taking longer than it should: Day0 or the sign-in service is not answering. Check
          your connection, then try again. The page carries on by itself if the answer arrives.
        </p>
        <Button variant="primary" onClick={(): void => window.location.reload()}>
          Try again
        </Button>
      </div>
    </div>
  );
}

/** What `SignedOut` is told: whether Clerk still holds the session the deployment refused. */
export interface SignedOutProps {
  readonly refused: boolean;
}

/**
 * What an owned page shows once Convex has settled with nobody signed in: the manager signed out
 * (here or in another tab), or Clerk holds a session whose token the deployment refused. Either
 * way the page's rows are gone, and signing in again brings the manager back to this page.
 *
 * A refused session is ended first: Clerk's sign-in page sends a signed-in visitor straight on to
 * `redirect_url`, which is this page, and Convex would refuse the same session again.
 */
export function SignedOut({ refused }: SignedOutProps) {
  const pathname = usePathname();
  const clerk = useClerk();
  const signIn = `/sign-in?redirect_url=${encodeURIComponent(pathname)}`;
  function signInAgain(): void {
    // The chain ends in its own rejection handler: a sign-out that fails still leaves by a full load.
    void clerk.signOut({ redirectUrl: signIn }).catch((err: unknown): void => {
      log.warn('refused session not signed out', { reason: errorMessage(err) });
      window.location.assign(signIn);
    });
  }
  return (
    // Inside the page's own `main` (`MainTransition`), as the owned page it stands in for was.
    <div className="grid min-h-[calc(100vh-3.25rem)] place-items-center px-6">
      <div className="grid max-w-md justify-items-center gap-4 text-center">
        <h1 className="text-lg font-semibold">
          {refused ? 'Day0 could not confirm your sign-in' : 'You are signed out'}
        </h1>
        <p className="text-sm text-[var(--color-muted)]">
          Sign in again to carry on where you were.
        </p>
        {refused ? (
          <Button variant="primary" onClick={signInAgain}>
            Sign in again
          </Button>
        ) : (
          <ButtonLink href={signIn} variant="primary">
            Sign in
          </ButtonLink>
        )}
      </div>
    </div>
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
      // A token the server refuses, or cannot be reached for, is "not signed
      // in": the gate below says so, and the unlock link is the way back.
      .catch((): null => null)
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
    <main
      id="main"
      tabIndex={-1}
      className="min-h-[calc(100vh-3.25rem)] grid place-items-center px-6 outline-none"
    >
      <p className="max-w-md text-center text-sm text-[var(--color-muted)]">
        {isLoading
          ? 'Unlocking this machine’s local session…'
          : 'This browser could not obtain a local session key. Open the unlock URL that `pnpm dev` printed, and check that the Convex deployment has DEV_NO_AUTH_JWKS set.'}
      </p>
    </main>
  );
}
