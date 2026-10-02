'use client';

import { ClerkProvider, useAuth, useClerk } from '@clerk/nextjs';
import { ConvexProviderWithAuth, ConvexReactClient, useConvexAuth } from 'convex/react';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { usePathname } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  CUSTOMER_SIGN_IN,
  CUSTOMER_SIGN_OUT_ROUTE,
  CUSTOMER_TOKEN_ROUTE,
  customerSignInHref,
  type SessionAccount,
} from '@/lib/customer-sign-in';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { errorMessage } from '@/lib/errors';
import { log } from '@/lib/logger';
import { Button, ButtonLink, buttonClass } from './components/Button';

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
 *
 * A customer-local build (`NEXT_PUBLIC_DAY0_PROFILE=customer-local`) is the
 * third shape: Convex on the ID token the customer's own issuer signed, which
 * the token route hands over from the sealed session, and Clerk never loaded
 * (Q16).
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

  if (CUSTOMER_SIGN_IN) {
    return <CustomerSignInProvider client={client}>{children}</CustomerSignInProvider>;
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

/** How the last token fetch Convex made through Clerk for the session settled. */
interface TokenFetch {
  readonly hadToken: boolean;
}

/**
 * The session's token fetch as `SessionGate` reads it: null while none has settled for the
 * session Clerk holds, undefined where no Clerk provider records one (the gate then reads Convex
 * alone, as it did before).
 */
const TokenFetchContext = createContext<TokenFetch | null | undefined>(undefined);

/** Records how a token fetch settled; stable for the provider's life. */
const RecordTokenFetchContext = createContext<(settled: TokenFetch) => void>(() => undefined);

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
  const [tokenFetch, setTokenFetch] = useState<TokenFetch | null>(null);
  // Convex fetches again at every renewal; an answer like the last changes nothing on the page.
  const recordTokenFetch = useCallback(
    (settled: TokenFetch): void =>
      setTokenFetch((last) => (last?.hadToken === settled.hadToken ? last : settled)),
    [],
  );
  // Kept from the previous render in state, as React's docs set out. A new session has fetched
  // no token yet, whatever an earlier one fetched.
  if (sessionId && sessionId !== epoch.last) {
    setEpoch({ last: sessionId, changes: epoch.last === null ? epoch.changes : epoch.changes + 1 });
    setTokenFetch(null);
  }
  return (
    <RecordTokenFetchContext.Provider value={recordTokenFetch}>
      <TokenFetchContext.Provider value={tokenFetch}>
        <ConvexProviderWithClerk key={epoch.changes} client={client} useAuth={useSettledClerkAuth}>
          {children}
        </ConvexProviderWithClerk>
      </TokenFetchContext.Provider>
    </RecordTokenFetchContext.Provider>
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
 *
 * Every fetch Convex makes through it is recorded as it settles, so `SessionGate` can tell a
 * session whose token is still on its way from one the deployment refused (decision 6).
 */
function useSettledClerkAuth(): ClerkAuth {
  const auth = useAuth();
  const [settled, setSettled] = useState<ClerkAuth | null>(null);
  // Kept from the previous render in state, as React's docs set out, so a re-resolve can use it.
  if (auth.isLoaded && !sameSession(auth, settled)) setSettled(auth);
  const answer = auth.isLoaded || settled === null ? auth : settled;
  const record = useContext(RecordTokenFetchContext);
  const clerkGetToken = answer.getToken;
  // A provider keyed away for a new session may still have a fetch in flight; what it brings is
  // the old session's and is not recorded for the new one.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Convex keeps the token fetcher it built while signed out, which calls this function (it
  // rebuilds the fetcher only when the organisation changes), so it is kept stable.
  const getToken = useCallback<ClerkAuth['getToken']>(
    async (options) => {
      let token: string | null = null;
      try {
        token = await clerkGetToken(options);
        return token;
      } finally {
        if (mounted.current) record({ hadToken: token !== null });
      }
    },
    [clerkGetToken, record],
  );
  return useMemo((): ClerkAuth => ({ ...answer, getToken }), [answer, getToken]);
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

/**
 * How long an owned page waits, once Clerk's token for a new session has been fetched, for the
 * deployment to confirm it before it says the sign-in was refused: one round trip on any
 * connection that serves the page, with room for a slow one.
 */
export const SIGN_IN_CONFIRM_MS = 5_000;

/** What `SessionGate` is given: the owned page, and what stands in its place until it may run. */
export interface SessionGateProps {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
  /**
   * Drawn in place of every state but open (waiting, unconfirmed, signed out), for a gate inside
   * the header, where a page-scale notice has no room: the header's own signed-out controls say
   * the rest. Absent, a page's gate says each state at page scale.
   */
  readonly closed?: ReactNode;
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
 * hide their served HTML from every visitor until Clerk loaded. In no-auth dev mode and under the
 * customer-local profile the whole tree is already held above, so the page passes straight through.
 *
 * Once Convex has answered that nobody is signed in, the owned page is taken away and the gate
 * says so (`SignedOut`): a sign-out in another tab, or a token the deployment would not accept,
 * would otherwise leave the manager's rows, address and controls drawn under a header that says
 * "Sign in" (the second review's x1).
 */
export function SessionGate({ children, fallback, closed }: SessionGateProps) {
  if (DEV_NO_AUTH || CUSTOMER_SIGN_IN) return <>{children}</>;
  return (
    <ClerkSessionGate fallback={fallback} closed={closed}>
      {children}
    </ClerkSessionGate>
  );
}

function ClerkSessionGate({ children, fallback, closed }: SessionGateProps) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { status } = useClerk();
  const { isSignedIn } = useAuth();
  const tokenFetch = useContext(TokenFetchContext);
  // A visit going from signed out to signed in: Convex keeps its last "nobody" until the backend
  // confirms the new session, so Clerk signed in with Convex not yet is not a refusal until the
  // session's token fetch has settled and the backend has had its moment to answer (the wave 9
  // review's stage 6, decision 6). A fetch that brought no token is refused at once.
  const unconfirmed = !isLoading && !isAuthenticated && isSignedIn === true;
  const awaitingToken = unconfirmed && tokenFetch === null;
  const confirming = unconfirmed && tokenFetch?.hadToken === true;
  // A header's gate waits silently: the page's own gate times the wait and says it.
  const timed = status !== 'error' && closed === undefined;
  const overdue = useOverdue((isLoading || awaitingToken) && timed, SESSION_WAIT_MS);
  const confirmOverdue = useOverdue(confirming && timed, SIGN_IN_CONFIRM_MS);
  // A Clerk that failed to load never answers; the page is let through to say what it can.
  if (status === 'error') return <>{closed ?? children}</>;
  if (closed !== undefined && !(isAuthenticated && !isLoading)) return <>{closed}</>;
  if (isLoading || awaitingToken) return overdue ? <SessionUnconfirmed /> : <>{fallback}</>;
  if (confirming && !confirmOverdue) return <>{fallback}</>;
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

/** What the customer sign-in knows about who this browser is signed in as. */
export type CustomerAccountState =
  | { readonly status: 'resolving' }
  | { readonly status: 'signed-in'; readonly account: SessionAccount }
  | { readonly status: 'signed-out' }
  /** The token route could not reach the issuer, after asking again. */
  | { readonly status: 'unavailable' };

const RESOLVING_ACCOUNT: CustomerAccountState = { status: 'resolving' };

const CustomerAccountContext = createContext<CustomerAccountState>(RESOLVING_ACCOUNT);

const RecordCustomerAccountContext = createContext<(state: CustomerAccountState) => void>(
  () => undefined,
);

/**
 * Who the customer sign-in says this browser is: the account the session's ID token names, read
 * by the header's menu and the landing page. Resolving outside the customer-local profile.
 */
export function useCustomerAccount(): CustomerAccountState {
  return useContext(CustomerAccountContext);
}

function sameAccountState(a: CustomerAccountState, b: CustomerAccountState): boolean {
  if (a.status !== b.status) return false;
  if (a.status !== 'signed-in' || b.status !== 'signed-in') return true;
  return a.account.name === b.account.name && a.account.email === b.account.email;
}

/** What the customer sign-in's provider is given: the Convex client and the tree. */
interface CustomerSignInProviderProps {
  readonly client: ConvexReactClient;
  readonly children: ReactNode;
}

/** Convex on the customer's ID token, and the account it names for the header. */
function CustomerSignInProvider({ client, children }: CustomerSignInProviderProps) {
  const [account, setAccount] = useState<CustomerAccountState>(RESOLVING_ACCOUNT);
  // Convex fetches again at every renewal; an answer like the last changes nothing on the page.
  const record = useCallback(
    (next: CustomerAccountState): void =>
      setAccount((last) => (sameAccountState(last, next) ? last : next)),
    [],
  );
  return (
    <RecordCustomerAccountContext.Provider value={record}>
      <CustomerAccountContext.Provider value={account}>
        <ConvexProviderWithAuth client={client} useAuth={useCustomerSignIn}>
          <CustomerSignInGate>{children}</CustomerSignInGate>
        </ConvexProviderWithAuth>
      </CustomerAccountContext.Provider>
    </RecordCustomerAccountContext.Provider>
  );
}

/** How long the browser waits before asking the token route again after it could not answer. */
const TOKEN_RETRY_DELAYS_MS = [500, 1_500] as const;

/** What one token request came to. */
type CustomerTokenAnswer =
  | { readonly kind: 'token'; readonly token: string; readonly account: SessionAccount }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'unavailable' };

function isIssuedToken(body: unknown): body is { token: string; account?: SessionAccount } {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { token?: unknown }).token === 'string'
  );
}

/** One answer from the token route, read; anything but a token or a 401 is a failure to answer. */
async function askTokenRoute(force: boolean): Promise<CustomerTokenAnswer | undefined> {
  let response: Response;
  try {
    response = await fetch(CUSTOMER_TOKEN_ROUTE, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force }),
    });
  } catch (err) {
    log.warn('company sign-in token route unreachable', { reason: errorMessage(err) });
    return undefined;
  }
  if (response.status === 401) return { kind: 'signed-out' };
  if (!response.ok) return undefined;
  // A body that is not JSON is no token: read as the route failing to answer, which is retried.
  const body: unknown = await response.json().catch((): undefined => undefined);
  if (!isIssuedToken(body)) return undefined;
  return { kind: 'token', token: body.token, account: body.account ?? {} };
}

/**
 * The ID token Convex receives, from the token route, asking again twice when the route cannot
 * reach the issuer: a moment's outage is not a sign-out.
 */
async function fetchCustomerToken(force: boolean): Promise<CustomerTokenAnswer> {
  for (const delay of [0, ...TOKEN_RETRY_DELAYS_MS]) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const answer = await askTokenRoute(force);
    if (answer) return answer;
  }
  return { kind: 'unavailable' };
}

/**
 * The customer sign-in's equivalent of Clerk's `useAuth`, shaped like `useDevNoAuth`: the token
 * route answers only for a browser holding a session the install sealed, so a null token means
 * this browser is not signed in. Every answer is recorded for the header's account menu.
 */
function useCustomerSignIn() {
  const record = useContext(RecordCustomerAccountContext);
  const [state, setState] = useState({ isLoading: true, isAuthenticated: false });

  const fetchAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken: boolean }): Promise<string | null> => {
      const answer = await fetchCustomerToken(forceRefreshToken);
      switch (answer.kind) {
        case 'token':
          record({ status: 'signed-in', account: answer.account });
          return answer.token;
        case 'signed-out':
          record({ status: 'signed-out' });
          return null;
        case 'unavailable':
          record({ status: 'unavailable' });
          return null;
        default: {
          const unknown: never = answer;
          throw new Error(`unhandled token answer ${String(unknown)}`);
        }
      }
    },
    [record],
  );

  useEffect(() => {
    let current = true;
    fetchAccessToken({ forceRefreshToken: false })
      // A token the route refuses, or cannot be reached for, is "not signed in": the gate says
      // which, and offers the way on.
      .catch((): null => null)
      .then((token) => {
        if (current) setState({ isLoading: false, isAuthenticated: token !== null });
      });
    return () => {
      current = false;
    };
  }, [fetchAccessToken]);

  return useMemo(() => ({ ...state, fetchAccessToken }), [state, fetchAccessToken]);
}

/** The frame the customer gate stands in for the whole page with. */
function CustomerGateFrame({ children }: { readonly children: ReactNode }) {
  return (
    <main
      id="main"
      tabIndex={-1}
      className="grid min-h-[calc(100vh-3.25rem)] place-items-center px-6 outline-none"
    >
      <div className="grid max-w-md justify-items-center gap-4 text-center">
        {/* The header is held with the rest of the tree, so the frame names the app itself; the
            page's title already says it to assistive technology. */}
        <p
          aria-hidden="true"
          className="text-xs font-medium uppercase tracking-[0.2em] text-[var(--color-accent)]"
        >
          Day0
        </p>
        {children}
      </div>
    </main>
  );
}

/**
 * The control that ends the customer session: a form posting to the sign-out route, which ends
 * the issuer's session as well when it can. A form, so it works before any script has run.
 */
export function CustomerSignOutButton({
  variant = 'secondary',
  label = 'Sign out',
}: {
  readonly variant?: 'secondary' | 'quiet' | 'primary';
  readonly label?: string;
}) {
  return (
    <form method="post" action={CUSTOMER_SIGN_OUT_ROUTE}>
      <Button type="submit" variant={variant}>
        {label}
      </Button>
    </form>
  );
}

/**
 * Holds the app until the deployment has accepted the customer's ID token, as `DevNoAuthGate`
 * does for the local key, and says what stands in the way when it has not: nobody signed in, a
 * sign-in service that does not answer, or a token the deployment would not accept.
 */
function CustomerSignInGate({ children }: { readonly children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const account = useCustomerAccount();
  const pathname = usePathname();
  if (isAuthenticated) return <>{children}</>;
  if (isLoading || account.status === 'resolving') {
    return (
      <CustomerGateFrame>
        <p role="status" className="text-sm text-[var(--color-muted)]">
          Signing you in…
        </p>
      </CustomerGateFrame>
    );
  }
  switch (account.status) {
    case 'signed-out':
      return (
        <CustomerGateFrame>
          <h1 className="text-lg font-semibold">You are signed out</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Sign in with your work account to carry on where you were.
          </p>
          <a href={customerSignInHref(pathname)} className={buttonClass('primary')}>
            Sign in
          </a>
        </CustomerGateFrame>
      );
    case 'unavailable':
      return (
        <CustomerGateFrame>
          <h1 className="text-lg font-semibold">Day0 cannot reach your sign-in service</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Your company sign-in is not answering. Try again in a moment; if it keeps failing, tell
            whoever installed Day0.
          </p>
          <Button variant="primary" onClick={(): void => window.location.reload()}>
            Try again
          </Button>
        </CustomerGateFrame>
      );
    case 'signed-in':
      return (
        <CustomerGateFrame>
          <h1 className="text-lg font-semibold">Day0 could not confirm your sign-in</h1>
          <p className="text-sm text-[var(--color-muted)]">
            Your company sign-in let you in, but Day0 would not accept it. Sign out and try again;
            if it keeps happening, ask whoever installed Day0 to run <code>pnpm check:sign-in</code>
            .
          </p>
          <CustomerSignOutButton variant="primary" label="Sign out and try again" />
        </CustomerGateFrame>
      );
    default: {
      const unknown: never = account;
      throw new Error(`unhandled account state ${String(unknown)}`);
    }
  }
}
