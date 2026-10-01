import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { CUSTOMER_SIGN_IN, profileMismatch } from './customer-sign-in';
import {
  CustomerSignInUnavailable,
  customerSignInSettings,
  safeReturnTo,
  startSignIn,
  type CustomerSignInSettings,
} from './customer-oidc-server';
import {
  SIGN_IN_TRANSACTION_COOKIE,
  SIGN_IN_TRANSACTION_PATH,
  SIGN_IN_TRANSACTION_SECONDS,
  sealTransaction,
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
