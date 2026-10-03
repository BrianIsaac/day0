import 'server-only';
import { ConvexHttpClient } from 'convex/browser';
import { NextResponse, type NextRequest } from 'next/server';
import { api } from '@convex/_generated/api';
import { serverConvexUrl } from './convex-url';
import {
  CUSTOMER_SIGN_IN,
  customerSignInHref,
  profileMismatch,
  type IssuedToken,
  type SessionAccount,
} from './customer-sign-in';
import {
  CUSTOMER_SIGN_IN_REFUSAL_WORDS,
  customerOidcEmailTrusted,
  type CallerRefusal,
} from './customer-oidc';
import {
  CustomerSignInUnavailable,
  customerSignInSettings,
  finishSignIn,
  issuerSignOutUrl,
  type FinishedSignIn,
  needsRefresh,
  refreshSession,
  revokeRefreshToken,
  safeReturnTo,
  sealedTokenClaims,
  startSignIn,
  type CustomerSignInSettings,
} from './customer-oidc-server';
import { serverEnv, signedOutUriOf } from './customer-sign-in-settings';
import {
  CUSTOMER_SESSION_COOKIE,
  SIGN_IN_TRANSACTION_COOKIE,
  SIGN_IN_TRANSACTION_PATH,
  SIGN_IN_TRANSACTION_SECONDS,
  chunkCookie,
  cookieNames,
  joinCookie,
  openSession,
  openTransaction,
  sealSession,
  sealTransaction,
  type CustomerSession,
} from './customer-session';
import { errorMessage } from './errors';
import { log } from './logger';
import { claimVerdicts, openCheckTicket, type SignInCheckReport } from './sign-in-check';

/**
 * The HTTP half of the customer-local sign-in: what each route under
 * `app/api/auth/oidc/` answers. Each route file exports only its verb, which
 * calls one function here (standard 1.7).
 */

/** Every answer of these routes is about one browser's sign-in and is never cached. */
const NO_STORE = { 'cache-control': 'no-store' } as const;

/** What a sign-in page says: its heading, its sentence and the one way on. */
export interface SignInPage {
  readonly status: number;
  readonly title: string;
  readonly body: string;
  readonly action?: { readonly href: string; readonly label: string };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A page the sign-in routes answer with when there is no app page to land on:
 * a refusal, a sign-in that failed, the signed-out page. Plain HTML in the
 * site's colours, with a 44 px action (N14).
 *
 * @param page - What it says.
 */
export function signInPageResponse(page: SignInPage): NextResponse {
  const action = page.action
    ? `<a class="action" href="${escapeHtml(page.action.href)}">${escapeHtml(page.action.label)}</a>`
    : '';
  const html =
    '<!doctype html><html lang="en-GB"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(page.title)} - Day0</title><style>:root{color-scheme:dark}` +
    'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:0 1.5rem;' +
    'background:#0a0a0b;color:#f4f4f5;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}' +
    'main{max-width:28rem;display:grid;justify-items:center;gap:1rem;text-align:center}' +
    'h1{font-size:1.125rem;font-weight:600;margin:0}p{margin:0;color:#a1a1aa;font-size:.875rem}' +
    '.action{display:inline-flex;align-items:center;min-height:44px;padding:0 1rem;border-radius:.5rem;' +
    'background:#22d3ee;color:#0a0a0b;font-weight:500;font-size:.875rem;text-decoration:none}' +
    '.action:focus-visible{outline:2px solid #f4f4f5;outline-offset:2px}.action:hover{opacity:.9}' +
    '@media (prefers-reduced-motion:no-preference){.action{transition:opacity 180ms,transform 120ms ease-out}' +
    '.action:active{transform:scale(.97)}}' +
    '.brand{color:#22d3ee;font-size:.75rem;font-weight:500;letter-spacing:.2em;text-transform:uppercase}' +
    '</style></head><body><main id="main"><p class="brand" aria-hidden="true">Day0</p>' +
    `<h1>${escapeHtml(page.title)}</h1>` +
    `<p>${escapeHtml(page.body)}</p>${action}</main></body></html>`;
  return new NextResponse(html, {
    status: page.status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE },
  });
}

/**
 * Why these routes do not answer on this server, or undefined when they do:
 * a build without the customer sign-in has no such routes, and a server whose
 * profile differs from the build's cannot serve them.
 */
function unavailableHere(): NextResponse | undefined {
  if (!CUSTOMER_SIGN_IN) {
    return NextResponse.json(
      { error: 'the company sign-in is off in this build' },
      { status: 404 },
    );
  }
  const mismatch = profileMismatch(process.env.DAY0_PROFILE);
  if (mismatch) {
    return signInPageResponse({
      status: 503,
      title: 'Day0 is not set up to sign you in',
      body: mismatch,
    });
  }
  return undefined;
}

/** The settings, or the page that says the install is not finished. */
function settingsOrPage(): CustomerSignInSettings | NextResponse {
  try {
    return customerSignInSettings();
  } catch (err) {
    if (!(err instanceof CustomerSignInUnavailable)) throw err;
    log.warn('customer sign-in not configured', { gaps: err.gaps.length });
    return signInPageResponse({
      status: 503,
      title: 'Day0 is not set up to sign you in',
      body:
        'The company sign-in is not finished on this installation. Whoever installed Day0 can ' +
        'see what is missing with pnpm check:setup.',
    });
  }
}

/**
 * The cookie attributes every sign-in cookie shares: httpOnly, `SameSite=Lax`
 * (the issuer's redirect back is a top-level navigation from another site,
 * which `Strict` would strip), and `Secure` whenever the public origin is
 * https.
 *
 * @param settings - The sign-in's settings.
 */
export function cookieAttributes(settings: CustomerSignInSettings): {
  readonly httpOnly: true;
  readonly sameSite: 'lax';
  readonly secure: boolean;
} {
  return { httpOnly: true, sameSite: 'lax', secure: settings.publicUrl.startsWith('https:') };
}

/**
 * `GET /api/auth/oidc/login`: start a sign-in. Seals the state, nonce and PKCE
 * verifier into a ten-minute cookie sent only to the callback, then sends the
 * browser to the issuer.
 *
 * @param request - The request; `returnTo` names the page to land on afterwards.
 */
export async function signInRoute(request: NextRequest): Promise<NextResponse> {
  const unavailable = unavailableHere();
  if (unavailable) return unavailable;
  const settings = settingsOrPage();
  if (settings instanceof NextResponse) return settings;
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'));
  const ticketText = request.nextUrl.searchParams.get('check');
  const ticket =
    ticketText === null ? undefined : await openCheckTicket(settings.sessionSecret, ticketText);
  if (ticketText !== null && !ticket) {
    return signInPageResponse({
      status: 400,
      title: 'This check link has expired',
      body: 'A sign-in check link works for ten minutes. Run pnpm check:sign-in again for a new one.',
    });
  }
  let started: Awaited<ReturnType<typeof startSignIn>>;
  try {
    started = await startSignIn(settings, {
      returnTo,
      switchAccount: request.nextUrl.searchParams.get('switch') === '1',
      ...(ticket ? { check: { id: ticket.checkId, reportTo: ticket.reportTo } } : {}),
    });
  } catch (err) {
    log.warn('customer sign-in could not reach the issuer', { reason: errorMessage(err) });
    return signInPageResponse({
      status: 502,
      title: 'Day0 cannot reach your sign-in service',
      body: 'Your company sign-in did not answer. Try again in a moment; if it keeps failing, tell whoever installed Day0.',
      action: {
        href: `/api/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}`,
        label: 'Try again',
      },
    });
  }
  const response = NextResponse.redirect(started.location, { status: 302, headers: NO_STORE });
  response.cookies.set(
    SIGN_IN_TRANSACTION_COOKIE,
    await sealTransaction(settings.sessionSecret, started.transaction),
    {
      ...cookieAttributes(settings),
      path: SIGN_IN_TRANSACTION_PATH,
      maxAge: SIGN_IN_TRANSACTION_SECONDS,
    },
  );
  return response;
}

/** Expire the sign-in transaction, on the one path its cookie was set for. */
function clearTransaction(response: NextResponse, settings: CustomerSignInSettings): void {
  response.cookies.set(SIGN_IN_TRANSACTION_COOKIE, '', {
    ...cookieAttributes(settings),
    path: SIGN_IN_TRANSACTION_PATH,
    maxAge: 0,
  });
}

/** What `writeSession` writes: the session, for which browser, under which settings, and when. */
export interface SessionWrite {
  /** The request, for the cookies the browser holds now. */
  readonly request: NextRequest;
  readonly settings: CustomerSignInSettings;
  readonly session: CustomerSession;
  /** The current time in milliseconds. */
  readonly now?: number;
}

/**
 * Write a session onto a response: sealed, split across numbered cookies when
 * it is long, every chunk an earlier and longer session left expired, and the
 * cookies kept exactly as long as the session lasts.
 *
 * @param response - The response to set the cookies on.
 * @param write - The session and where it goes.
 */
export async function writeSession(response: NextResponse, write: SessionWrite): Promise<void> {
  const { request, settings, session, now = Date.now() } = write;
  const chunks = chunkCookie(
    CUSTOMER_SESSION_COOKIE,
    await sealSession(settings.sessionSecret, session),
  );
  const maxAge = Math.max(0, Math.floor((session.expiresAt - now) / 1000));
  for (const chunk of chunks) {
    response.cookies.set(chunk.name, chunk.value, {
      ...cookieAttributes(settings),
      path: '/',
      maxAge,
    });
  }
  const written = new Set(chunks.map((chunk) => chunk.name));
  for (const name of cookieNames(CUSTOMER_SESSION_COOKIE)) {
    if (!written.has(name) && request.cookies.has(name)) {
      response.cookies.set(name, '', { ...cookieAttributes(settings), path: '/', maxAge: 0 });
    }
  }
}

/**
 * Expire every cookie of the session the browser holds.
 *
 * @param response - The response to clear them on.
 * @param request - The request, for the cookies the browser holds now.
 * @param settings - The sign-in's settings.
 */
export function clearSession(
  response: NextResponse,
  request: NextRequest,
  settings: CustomerSignInSettings,
): void {
  for (const name of cookieNames(CUSTOMER_SESSION_COOKIE)) {
    if (request.cookies.has(name)) {
      response.cookies.set(name, '', { ...cookieAttributes(settings), path: '/', maxAge: 0 });
    }
  }
}

/**
 * `GET /api/auth/oidc/callback`: finish a sign-in. Opens the transaction the
 * login route sealed, exchanges the code with its PKCE verifier, checks the
 * state, the nonce and the ID token, applies the domain rule, then seals the
 * session and sends the person back to the page they asked for. Every refusal
 * clears the transaction and says why, never repeating what the issuer or the
 * browser sent beyond an error code.
 *
 * @param request - The issuer's redirect back.
 */
export async function callbackRoute(request: NextRequest): Promise<NextResponse> {
  const unavailable = unavailableHere();
  if (unavailable) return unavailable;
  const settings = settingsOrPage();
  if (settings instanceof NextResponse) return settings;
  const transaction = await openTransaction(
    settings.sessionSecret,
    request.cookies.get(SIGN_IN_TRANSACTION_COOKIE)?.value,
  );
  if (!transaction) {
    const response = signInPageResponse({
      status: 400,
      title: 'This sign-in has expired',
      body: 'It took longer than ten minutes, or it was started in another browser or tab. Start it again.',
      action: { href: customerSignInHref('/'), label: 'Sign in again' },
    });
    clearTransaction(response, settings);
    return response;
  }
  const issuerError = request.nextUrl.searchParams.get('error');
  if (issuerError !== null) {
    const code = /^[A-Za-z0-9_.-]{1,64}$/.test(issuerError) ? issuerError : 'an unnamed error';
    log.info('customer sign-in refused by the issuer', { error: code });
    if (transaction.check) {
      // The live check waits for a report: an issuer's refusal (most often a test person not
      // assigned to the app) is one, not ten minutes of silence.
      const report: SignInCheckReport = {
        version: 1,
        checkId: transaction.check.id,
        checkedAt: Date.now(),
        verdicts: [],
        whoAmI: {
          status: 'gap',
          detail: `The issuer refused the sign-in (${code}): the test person may not be assigned to the app.`,
        },
      };
      await deliverReport(transaction.check.reportTo, report);
      const page = checkPageResponse(report);
      clearTransaction(page, settings);
      return page;
    }
    const response = signInPageResponse({
      status: 403,
      title: 'Your company sign-in did not let you in',
      body:
        `It answered ${code}. Your account may not be assigned to Day0 yet: ask your ` +
        'administrator, then try again.',
      action: { href: customerSignInHref(transaction.returnTo), label: 'Try again' },
    });
    clearTransaction(response, settings);
    return response;
  }
  const finished = await finishSignIn(settings, transaction, request.nextUrl.search);
  if (transaction.check) {
    const report = await checkReport(settings, transaction.check.id, finished);
    await deliverReport(transaction.check.reportTo, report);
    const response = checkPageResponse(report);
    clearTransaction(response, settings);
    return response;
  }
  switch (finished.kind) {
    case 'failed': {
      log.warn('customer sign-in failed at the callback', { reason: finished.detail });
      const response = signInPageResponse({
        status: 400,
        title: 'Day0 could not sign you in',
        body:
          'The answer from your company sign-in did not check out, so nothing was signed in. ' +
          'Start again; if it keeps happening, tell whoever installed Day0.',
        action: { href: customerSignInHref(transaction.returnTo), label: 'Sign in again' },
      });
      clearTransaction(response, settings);
      return response;
    }
    case 'refused': {
      log.info('customer sign-in refused', { reason: finished.reason });
      const address = typeof finished.claims.email === 'string' ? finished.claims.email : '';
      const response = signInPageResponse({
        status: 403,
        title: 'Day0 is not open to this account',
        body: `${address ? `You signed in as ${address}. ` : ''}${CUSTOMER_SIGN_IN_REFUSAL_WORDS[finished.reason]}`,
        action: {
          href: customerSignInHref(transaction.returnTo, { switchAccount: true }),
          label: 'Use another account',
        },
      });
      clearTransaction(response, settings);
      return response;
    }
    case 'signed-in': {
      const response = NextResponse.redirect(`${settings.publicUrl}${transaction.returnTo}`, {
        status: 302,
        headers: NO_STORE,
      });
      clearTransaction(response, settings);
      await writeSession(response, { request, settings, session: finished.session });
      return response;
    }
    default: {
      const unknown: never = finished;
      throw new Error(`unhandled sign-in outcome ${String(unknown)}`);
    }
  }
}

/**
 * How long a token must still be good for to be handed out when the issuer cannot refresh it.
 * Convex asks for a fresh token ten seconds before expiry, always forced, so anything longer
 * would end a live page at the first moment the issuer is down; a token past this is the
 * deployment's to refuse, which sends Convex back for another.
 */
const STILL_GOOD_MS = 2_000;

/**
 * Whether a state-changing request comes from the app's own pages: its
 * `Origin` is the public origin or the origin the request was sent to (a
 * customer's proxy may serve another name than `DAY0_PUBLIC_URL`), or the
 * browser marks it same-origin. The session cookie is `SameSite=Lax`, so
 * another site's POST does not carry it; this is the second lock on the door.
 *
 * @param request - The request.
 * @param settings - The sign-in's settings.
 */
export function fromOwnPages(request: NextRequest, settings: CustomerSignInSettings): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === settings.publicUrl || origin === request.nextUrl.origin;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/**
 * The session the browser holds, or undefined.
 *
 * @param request - The request carrying the session's cookies.
 * @param settings - The sign-in's settings.
 * @param now - The current time in milliseconds.
 */
export async function sessionOf(
  request: NextRequest,
  settings: CustomerSignInSettings,
  now: number = Date.now(),
): Promise<CustomerSession | undefined> {
  const sealed = joinCookie(CUSTOMER_SESSION_COOKIE, (name) => request.cookies.get(name)?.value);
  return openSession(settings.sessionSecret, sealed, now);
}

/** A claim's trimmed text, or undefined when it is not a non-empty string. */
function claimText(claims: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** The account a token names: its `name` (else `given_name`), first name and `email`. */
export function accountOf(idToken: string): SessionAccount {
  const claims = sealedTokenClaims(idToken) ?? {};
  const name = claimText(claims, 'name') ?? claimText(claims, 'given_name');
  const firstName = claimText(claims, 'given_name') ?? name?.split(/\s+/)[0];
  const email = claimText(claims, 'email');
  return {
    ...(name ? { name } : {}),
    ...(firstName ? { firstName } : {}),
    ...(email ? { email } : {}),
  };
}

function issued(session: CustomerSession): NextResponse {
  const body: IssuedToken = {
    token: session.idToken,
    expiresAt: session.idTokenExpiresAt,
    account: accountOf(session.idToken),
  };
  return NextResponse.json(body, { headers: NO_STORE });
}

function signedOut(
  request: NextRequest,
  settings: CustomerSignInSettings,
  reason: string,
): NextResponse {
  const response = NextResponse.json(
    { signedOut: true, reason },
    { status: 401, headers: NO_STORE },
  );
  clearSession(response, request, settings);
  return response;
}

/** Whether the browser's body asks for a fresh token (Convex's `forceRefreshToken`). */
async function forceAsked(request: NextRequest): Promise<boolean> {
  try {
    const body: unknown = await request.json();
    return (
      typeof body === 'object' && body !== null && (body as { force?: unknown }).force === true
    );
  } catch {
    // No body, or not JSON: an ordinary request for the current token.
    return false;
  }
}

/**
 * `POST /api/auth/oidc/token`: the ID token Convex receives, refreshed with the
 * refresh token when it is in its last minutes or Convex asks for a fresh one.
 * A refresh the issuer refuses ends the session (401, cookies cleared); an
 * issuer that cannot be reached leaves it standing, handing out the current
 * token while it is still good and answering 503 once it is not, so the
 * browser tries again rather than signing the person out.
 *
 * @param request - The browser's request, with the session's cookies.
 */
export async function tokenRoute(request: NextRequest): Promise<NextResponse> {
  const unavailable = unavailableHere();
  if (unavailable) return unavailable;
  const settings = settingsOrPage();
  if (settings instanceof NextResponse) return settings;
  if (!fromOwnPages(request, settings)) {
    return NextResponse.json({ error: 'not from this site' }, { status: 403, headers: NO_STORE });
  }
  const now = Date.now();
  const session = await sessionOf(request, settings, now);
  if (!session) return signedOut(request, settings, 'no session');
  const force = await forceAsked(request);
  const issuedAt = Number(sealedTokenClaims(session.idToken)?.iat ?? 0) * 1000;
  const stillGood = session.idTokenExpiresAt - now > STILL_GOOD_MS;
  if (!force && !needsRefresh(session, issuedAt, now)) return issued(session);
  if (!session.refreshToken) {
    return stillGood ? issued(session) : signedOut(request, settings, 'no refresh token');
  }
  const outcome = await refreshSession(settings, session, now);
  switch (outcome.kind) {
    case 'refreshed': {
      const response = issued(outcome.session);
      await writeSession(response, { request, settings, session: outcome.session, now });
      return response;
    }
    case 'refused':
      return signedOut(request, settings, 'refresh refused');
    case 'unavailable':
      return stillGood
        ? issued(session)
        : NextResponse.json(
            { error: 'the sign-in service did not answer; try again' },
            { status: 503, headers: NO_STORE },
          );
    default: {
      const unknown: never = outcome;
      throw new Error(`unhandled refresh outcome ${String(unknown)}`);
    }
  }
}

/** How long a session's ID token must still be good for to act on Convex with, unrefreshed. */
const REDIRECT_TOKEN_MARGIN_MS = 10_000;

/** The caller a top-level redirect acts as under the company sign-in, and what it writes back. */
export interface RedirectCaller {
  /** The ID token to act on Convex with, or null when the browser holds no live session. */
  readonly idToken: string | null;
  /** Write onto the redirect what became of the session: refreshed, ended, or nothing. */
  readonly finish: (response: NextResponse) => Promise<void>;
}

/**
 * The caller of a top-level redirect back into Day0 from another site (an MCP server's
 * authorisation), under the company sign-in: the browser's session, its ID token refreshed with
 * the refresh token first when it has lapsed or lapses within seconds, so a consent that took
 * longer than the ID token lives still completes (the wave 11 pre-tag's second pass). A refresh
 * the issuer refuses ends the session as the token route ends it; an issuer that cannot be
 * reached leaves it standing and the redirect acts with no caller. The page's own token fetch is
 * not there to refresh it: the redirect is a navigation, not a page.
 *
 * @param request - The redirect, with the session's cookies.
 * @param now - The current time in milliseconds.
 */
export async function redirectCaller(
  request: NextRequest,
  now: number = Date.now(),
): Promise<RedirectCaller> {
  const nothing: RedirectCaller = { idToken: null, finish: async (): Promise<void> => undefined };
  let settings: CustomerSignInSettings;
  try {
    settings = customerSignInSettings();
  } catch (err) {
    if (!(err instanceof CustomerSignInUnavailable)) throw err;
    return nothing;
  }
  const session = await sessionOf(request, settings, now);
  if (!session) return nothing;
  if (session.idTokenExpiresAt - now > REDIRECT_TOKEN_MARGIN_MS) {
    return { idToken: session.idToken, finish: nothing.finish };
  }
  if (!session.refreshToken) return nothing;
  const outcome = await refreshSession(settings, session, now);
  switch (outcome.kind) {
    case 'refreshed':
      return {
        idToken: outcome.session.idToken,
        finish: async (response: NextResponse): Promise<void> =>
          await writeSession(response, { request, settings, session: outcome.session, now }),
      };
    case 'refused':
      return {
        idToken: null,
        finish: async (response: NextResponse): Promise<void> =>
          clearSession(response, request, settings),
      };
    case 'unavailable':
      log.warn('the sign-in service did not answer a redirect’s refresh', {
        detail: outcome.detail,
      });
      return nothing;
    default: {
      const unknown: never = outcome;
      throw new Error(`unhandled refresh outcome ${String(unknown)}`);
    }
  }
}

/**
 * `POST /api/auth/oidc/logout`: end the session. The refresh token is revoked
 * where the issuer allows it, the cookies are cleared, and the browser is sent
 * to the issuer's `end_session_endpoint` when its metadata
 * names one, which ends the issuer's own session and sends the person back to
 * the signed-out page; without one, straight to that page.
 *
 * @param request - The account menu's Sign out, posted from the app's own pages.
 */
export async function signOutRoute(request: NextRequest): Promise<NextResponse> {
  const unavailable = unavailableHere();
  if (unavailable) return unavailable;
  const settings = settingsOrPage();
  if (settings instanceof NextResponse) return settings;
  if (!fromOwnPages(request, settings)) {
    return NextResponse.json({ error: 'not from this site' }, { status: 403, headers: NO_STORE });
  }
  const session = await sessionOf(request, settings);
  if (session?.refreshToken) await revokeRefreshToken(settings, session.refreshToken);
  const destination =
    (await issuerSignOutUrl(settings, session?.idToken)) ?? signedOutUriOf(settings.publicUrl);
  // 303, so the browser follows the POST with a GET.
  const response = NextResponse.redirect(destination, { status: 303, headers: NO_STORE });
  clearSession(response, request, settings);
  return response;
}

/**
 * `GET /api/auth/oidc/logout`: the signed-out page the issuer sends the
 * person back to. It changes nothing; a link that loads it ends no session.
 */
export function signedOutRoute(): NextResponse {
  const unavailable = unavailableHere();
  if (unavailable) return unavailable;
  return signInPageResponse({
    status: 200,
    title: 'You are signed out',
    body: 'Your session has ended. Sign in with your work account to carry on.',
    action: { href: customerSignInHref('/'), label: 'Sign in' },
  });
}

/** What the live check says of a person the deployment verified and refused, by its reason. */
const WHO_AM_I_REFUSALS: Readonly<Record<CallerRefusal, string>> = {
  'outside-domains':
    'The deployment verified the token and refused the person: outside the allowed ' +
    'domains it holds (DAY0_OIDC_ALLOWED_DOMAINS on the deployment, pnpm sync:env).',
  'unverified-address':
    'The deployment verified the token and refused the person: their address is not verified, ' +
    'and under the generic preset the deployment admits only a verified address (email_verified ' +
    'from the issuer; DAY0_OIDC_EMAIL_TRUSTED only for an issuer that sends no such claim).',
};

/**
 * What the deployment makes of a token: `config.whoAmI` asked with it, as the
 * browser would ask, so the answer says whether the backend verified it
 * against the issuer's keys (V3) and whether `getCaller` admits the person.
 *
 * @param idToken - The ID token the issuer handed over.
 */
async function askWhoAmI(idToken: string): Promise<SignInCheckReport['whoAmI']> {
  try {
    const client = new ConvexHttpClient(serverConvexUrl());
    client.setAuth(idToken);
    const caller = await client.query(api.config.whoAmI, {});
    if (caller === null) {
      return {
        status: 'gap',
        detail:
          'The deployment answered the token as no caller: it holds no issuer that signed it.',
      };
    }
    if ('refused' in caller) return { status: 'gap', detail: WHO_AM_I_REFUSALS[caller.refused] };
    return { status: 'ok', ownerKey: caller.ownerKey, verifiedAddress: caller.verifiedAddress };
  } catch (err) {
    return {
      status: 'gap',
      detail: `The deployment did not accept the token: ${errorMessage(err)}`,
    };
  }
}

/**
 * The live check's report on one sign-in: every claim's verdict and what the
 * deployment made of the token. A sign-in that failed has no claims to judge.
 *
 * @param settings - The sign-in's settings.
 * @param checkId - The check this sign-in answers.
 * @param finished - How the callback's exchange ended.
 */
export async function checkReport(
  settings: CustomerSignInSettings,
  checkId: string,
  finished: FinishedSignIn,
): Promise<SignInCheckReport> {
  const base = { version: 1, checkId, checkedAt: Date.now() } as const;
  switch (finished.kind) {
    case 'failed':
      return {
        ...base,
        verdicts: [],
        whoAmI: { status: 'gap', detail: `The sign-in did not complete: ${finished.detail}` },
      };
    case 'refused':
    case 'signed-in': {
      const idToken = finished.kind === 'signed-in' ? finished.session.idToken : finished.idToken;
      const refreshTokenGranted =
        finished.kind === 'signed-in'
          ? finished.session.refreshToken !== undefined
          : finished.refreshTokenGranted;
      return {
        ...base,
        verdicts: claimVerdicts(finished.claims, {
          issuer: settings.issuer,
          clientId: settings.clientId,
          allowedDomains: settings.allowedDomains,
          emailTrusted: customerOidcEmailTrusted(serverEnv),
          refreshTokenGranted,
        }),
        whoAmI: await askWhoAmI(idToken),
      };
    }
    default: {
      const unknown: never = finished;
      throw new Error(`unhandled sign-in outcome ${String(unknown)}`);
    }
  }
}

/**
 * Post the report to the check waiting on this machine. A check that stopped
 * waiting loses only its terminal copy: the page shows the same lines.
 *
 * @param reportTo - The check's listener, on this machine (`openCheckTicket` refuses any other).
 * @param report - The report.
 */
async function deliverReport(reportTo: string, report: SignInCheckReport): Promise<void> {
  try {
    await fetch(reportTo, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    log.warn('sign-in check report not delivered', { reason: errorMessage(err) });
  }
}

const VERDICT_WORD: Readonly<Record<'ok' | 'warn' | 'gap', string>> = {
  ok: 'pass',
  warn: 'note',
  gap: 'gap',
};

/** The check page's styles: a table on wide screens, one block per claim at phone width. */
const CHECK_PAGE_STYLE =
  ':root{color-scheme:dark}' +
  'body{margin:0;background:#0a0a0b;color:#f4f4f5;font:14px/1.5 ui-sans-serif,system-ui,sans-serif}' +
  'main{max-width:60rem;margin:0 auto;padding:2rem 1rem;display:grid;gap:1rem}' +
  'h1{font-size:1.125rem;margin:0}p{margin:0;color:#a1a1aa}' +
  'table{border-collapse:collapse;width:100%}' +
  'th,td{text-align:left;vertical-align:top;padding:.5rem;border-bottom:1px solid #27272a}' +
  'th,td.verdict{white-space:nowrap}td.value,td.why{overflow-wrap:anywhere}' +
  'thead th{color:#a1a1aa;font-weight:500}.ok{color:#34d399}.warn{color:#f59e0b}.gap{color:#ef4444}' +
  '.brand{color:#22d3ee;font-size:.75rem;font-weight:500;letter-spacing:.2em;text-transform:uppercase}' +
  'code{font-size:.8125rem;overflow-wrap:anywhere}.sr-only{position:absolute;width:1px;height:1px;' +
  'overflow:hidden;clip-path:inset(50%);white-space:nowrap}' +
  // At phone width each claim is a block: its name and verdict on one line, the value, then why.
  '@media (max-width:40rem){thead{position:absolute;width:1px;height:1px;overflow:hidden;' +
  'clip-path:inset(50%)}table,tbody,tr,th,td{display:block}tr{display:grid;' +
  'grid-template-columns:1fr auto;gap:.125rem .75rem;padding:.75rem 0;border-bottom:1px solid #27272a}' +
  'th,td{padding:0;border:0}td.value,td.why{grid-column:1/-1}td.why{color:#a1a1aa}}';

/**
 * The page the live check's sign-in lands on: each claim's verdict, then what
 * the deployment made of the token, then the one way on. Nobody is signed in.
 * The table keeps its semantics by explicit roles, since at phone width its
 * rows are drawn as blocks.
 *
 * @param report - The report.
 */
export function checkPageResponse(report: SignInCheckReport): NextResponse {
  const rows = report.verdicts
    .map(
      (one) =>
        `<tr role="row"><th scope="row" role="rowheader">${escapeHtml(one.claim)}</th>` +
        `<td role="cell" class="verdict ${one.status}">${VERDICT_WORD[one.status]}</td>` +
        `<td role="cell" class="value">${escapeHtml(one.value)}</td>` +
        `<td role="cell" class="why">${escapeHtml(one.note)}</td></tr>`,
    )
    .join('');
  const who = report.whoAmI;
  const result =
    who.status === 'ok'
      ? `<p role="status" class="ok">Pass: the deployment accepted the token. Owner key <code>${escapeHtml(who.ownerKey)}</code>${who.verifiedAddress ? `, verified address ${escapeHtml(who.verifiedAddress)}` : ', no verified address'}.</p>`
      : `<p role="status" class="gap">Gap: ${escapeHtml(who.detail)}</p>`;
  const passed = who.status === 'ok' && report.verdicts.every((one) => one.status !== 'gap');
  const next = passed
    ? '<p>Next: nothing to fix. Keep the terminal’s lines with the install’s support bundle.</p>'
    : '<p>Next: fix each gap above, then run <code>pnpm check:sign-in</code> again.</p>';
  const html =
    '<!doctype html><html lang="en-GB"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>Sign-in check - Day0</title><style>${CHECK_PAGE_STYLE}</style></head><body>` +
    '<main id="main"><p class="brand" aria-hidden="true">Day0</p><h1>Sign-in check</h1>' +
    '<p>This sign-in was a check: nobody was signed in. The terminal that printed the link shows the same lines.</p>' +
    '<div class="table" tabindex="0" role="region" aria-label="Each claim and its verdict">' +
    '<table role="table"><caption class="sr-only">Each claim of the ID token, with its verdict</caption>' +
    '<thead><tr role="row"><th scope="col" role="columnheader">Claim</th>' +
    '<th scope="col" role="columnheader">Verdict</th><th scope="col" role="columnheader">Value</th>' +
    `<th scope="col" role="columnheader">Why</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `${result}${next}</main></body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE },
  });
}
