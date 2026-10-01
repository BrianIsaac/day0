import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { CUSTOMER_SIGN_IN, profileMismatch } from './customer-sign-in';
import { SIGN_IN_REFUSAL_WORDS } from './customer-oidc';
import {
  CustomerSignInUnavailable,
  customerSignInSettings,
  finishSignIn,
  needsRefresh,
  refreshSession,
  safeReturnTo,
  sealedTokenClaims,
  startSignIn,
  type CustomerSignInSettings,
} from './customer-oidc-server';
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
    `<title>${escapeHtml(page.title)} - Day0</title><style>` +
    'body{margin:0;min-height:100vh;display:grid;place-items:center;padding:0 1.5rem;' +
    'background:#0a0a0b;color:#f4f4f5;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}' +
    'main{max-width:28rem;display:grid;justify-items:center;gap:1rem;text-align:center}' +
    'h1{font-size:1.125rem;font-weight:600;margin:0}p{margin:0;color:#a1a1aa;font-size:.875rem}' +
    '.action{display:inline-flex;align-items:center;min-height:44px;padding:0 1rem;border-radius:.5rem;' +
    'background:#22d3ee;color:#0a0a0b;font-weight:500;font-size:.875rem;text-decoration:none}' +
    '.action:focus-visible{outline:2px solid #f4f4f5;outline-offset:2px}' +
    `</style></head><body><main id="main"><h1>${escapeHtml(page.title)}</h1>` +
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
  let started: Awaited<ReturnType<typeof startSignIn>>;
  try {
    started = await startSignIn(settings, { returnTo });
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

/** The link that starts a sign-in afresh, landing on `returnTo` afterwards. */
function signInAgainHref(returnTo: string): string {
  return `/api/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Expire the sign-in transaction, on the one path its cookie was set for. */
function clearTransaction(response: NextResponse, settings: CustomerSignInSettings): void {
  response.cookies.set(SIGN_IN_TRANSACTION_COOKIE, '', {
    ...cookieAttributes(settings),
    path: SIGN_IN_TRANSACTION_PATH,
    maxAge: 0,
  });
}

/**
 * Write a session onto a response: sealed, split across numbered cookies when
 * it is long, every chunk an earlier and longer session left expired, and the
 * cookies kept exactly as long as the session lasts.
 *
 * @param response - The response to set the cookies on.
 * @param request - The request, for the cookies the browser holds now.
 * @param settings - The sign-in's settings.
 * @param session - The session to write.
 * @param now - The current time in milliseconds.
 */
export async function writeSession(
  response: NextResponse,
  request: NextRequest,
  settings: CustomerSignInSettings,
  session: CustomerSession,
  now: number = Date.now(),
): Promise<void> {
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
      action: { href: signInAgainHref('/'), label: 'Sign in again' },
    });
    clearTransaction(response, settings);
    return response;
  }
  const issuerError = request.nextUrl.searchParams.get('error');
  if (issuerError !== null) {
    const code = /^[A-Za-z0-9_.-]{1,64}$/.test(issuerError) ? issuerError : 'an unnamed error';
    log.info('customer sign-in refused by the issuer', { error: code });
    const response = signInPageResponse({
      status: 403,
      title: 'Your company sign-in did not let you in',
      body:
        `It answered ${code}. Your account may not be assigned to Day0 yet: ask your ` +
        'administrator, then try again.',
      action: { href: signInAgainHref(transaction.returnTo), label: 'Try again' },
    });
    clearTransaction(response, settings);
    return response;
  }
  const finished = await finishSignIn(settings, transaction, request.nextUrl.search);
  switch (finished.kind) {
    case 'failed': {
      log.warn('customer sign-in failed at the callback', { reason: finished.detail });
      const response = signInPageResponse({
        status: 400,
        title: 'Day0 could not sign you in',
        body:
          'The answer from your company sign-in did not check out, so nothing was signed in. ' +
          'Start again; if it keeps happening, tell whoever installed Day0.',
        action: { href: signInAgainHref(transaction.returnTo), label: 'Sign in again' },
      });
      clearTransaction(response, settings);
      return response;
    }
    case 'refused': {
      log.info('customer sign-in refused by the domain rule', { reason: finished.reason });
      const response = signInPageResponse({
        status: 403,
        title: 'Day0 is not open to this account',
        body: SIGN_IN_REFUSAL_WORDS[finished.reason],
        action: { href: signInAgainHref(transaction.returnTo), label: 'Use another account' },
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
      await writeSession(response, request, settings, finished.session);
      return response;
    }
    default: {
      const unknown: never = finished;
      throw new Error(`unhandled sign-in outcome ${String(unknown)}`);
    }
  }
}

/** The account a session names, as the header's menu shows it. */
export interface SessionAccount {
  readonly name?: string;
  readonly email?: string;
}

/** What the token route answers a signed-in browser with. */
export interface IssuedToken {
  readonly token: string;
  /** The token's expiry, in milliseconds. */
  readonly expiresAt: number;
  readonly account: SessionAccount;
}

/** How long a token must still be good for to be handed out when the issuer cannot refresh it. */
const STILL_GOOD_MS = 30_000;

/**
 * Whether a state-changing request comes from the app's own pages: its
 * `Origin` is the public origin, or the browser marks it same-origin. The
 * session cookie is `SameSite=Lax`, so another site's POST does not carry it;
 * this is the second lock on the same door.
 *
 * @param request - The request.
 * @param settings - The sign-in's settings.
 */
export function fromOwnPages(request: NextRequest, settings: CustomerSignInSettings): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === settings.publicUrl;
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

/** The account a token names: its `name` (else `given_name`) and `email`, when they are strings. */
function accountOf(idToken: string): SessionAccount {
  const claims = sealedTokenClaims(idToken) ?? {};
  const name =
    typeof claims.name === 'string' && claims.name.trim() !== ''
      ? claims.name.trim()
      : typeof claims.given_name === 'string' && claims.given_name.trim() !== ''
        ? claims.given_name.trim()
        : undefined;
  const email = typeof claims.email === 'string' ? claims.email.trim() : undefined;
  return { ...(name ? { name } : {}), ...(email ? { email } : {}) };
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
      await writeSession(response, request, settings, outcome.session, now);
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
