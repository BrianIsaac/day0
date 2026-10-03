import { NextResponse, type NextRequest } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { deploymentClerkAddresses } from '@/lib/clerk-addresses';
import { DEV_NO_AUTH, isLoopbackHostHeader } from '@/lib/dev-auth';
import { CUSTOMER_SESSION_COOKIE, joinCookie, openSession } from '@/lib/customer-session';
import { CUSTOMER_SIGN_IN, profileMismatch } from '@/lib/customer-sign-in';
import { publicOrigin } from '@/lib/customer-sign-in-settings';
import {
  DEV_NO_AUTH_COOKIE,
  DEV_NO_AUTH_SESSION_SECONDS,
  DEV_NO_AUTH_UNLOCK_PARAM,
  devNoAuthKeyGaps,
  isDevNoAuthSecret,
  isDevNoAuthSession,
  mintDevNoAuthSession,
} from '@/lib/dev-auth-server';

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts`. Public routes
 * include Clerk's own sign-in/sign-up pages, the two routes the landing
 * page sends a signed-out visitor to, plus webhook endpoints called by
 * external services.
 *
 * `/walkthrough` renders a recorded run that ships with the build and
 * `/setup` is static prose; neither reads a row, so neither needs a
 * caller. The old `/demo` needs no entry: `next.config.mjs` redirects it
 * to the walkthrough before this proxy runs.
 *
 * `auth.protect()` only fires when Clerk has a real publishable key in
 * the environment. Keyless dev mode bootstraps keys on the client but
 * not on the server, so the middleware passes through until the user
 * claims their Clerk keys. Routes that spend the owner's provider keys
 * must therefore establish the caller in their own handler as well, and
 * never treat this file as their only boundary.
 *
 * In no-auth dev mode Clerk's middleware never runs at all - invoking it
 * without a `ClerkProvider` anywhere in the app would only manufacture a
 * dependency the rest of that mode has deliberately dropped. What runs
 * in its place is the boundary that mode actually claims: the caller must
 * hold this machine's unlock secret, so the one synthetic user is only
 * ever handed to somebody who read it off this machine's terminal.
 *
 * A customer-local build (`NEXT_PUBLIC_DAY0_PROFILE=customer-local`) runs
 * neither: people sign in through the customer's own issuer, and
 * `customerSignInGate` below holds every route to the session that sign-in
 * seals.
 */
const isPublicRoute = createRouteMatcher([
  '/',
  '/walkthrough',
  '/setup',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/voice/elevenlabs/webhook(.*)',
  '/api/oauth/slack(.*)',
  '/api/oauth/linear',
  '/api/seed(.*)',
  '/api/onboarding/synthesise(.*)',
]);

const isApiRoute = createRouteMatcher(['/api/(.*)']);

/**
 * Whether the App Router sent the request from a page already open: a prefetch of a link, or a
 * client-side navigation, as opposed to a full page load or a server action. Next strips its
 * flight headers (`rsc`, `next-router-prefetch`) before this proxy runs, so the mark is
 * `next-url`, the one Clerk itself reads to treat a request as an in-app navigation.
 */
function isRouterFetch(req: NextRequest): boolean {
  return req.headers.has('next-url') && !req.headers.has('next-action');
}

const { signInUrl, signUpUrl } = deploymentClerkAddresses();

const clerkProxy = clerkMiddleware(
  async (auth, req) => {
    const hasClerkKey = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    if (!hasClerkKey || isPublicRoute(req)) return;

    // `auth.protect()` answers a signed-out fetch with a 404 page, which the
    // browser client cannot tell apart from a deleted endpoint. API callers
    // get a 401 so they know to send the user through sign-in.
    if (isApiRoute(req)) {
      const { userId } = await auth();
      if (!userId) {
        return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
      }
      return;
    }

    // A prefetch or a client-side navigation carries no fresh session while the page's token
    // is being renewed, and a redirect to the sign-in would be kept as that link's page (the
    // v0.14.0 redeploy saw a signed-in home's prefetch sent to the Account Portal). It is
    // answered with no page instead: the router then loads the address whole when the link is
    // followed, and that load signs in, renews the session or reaches the sign-in page.
    if (isRouterFetch(req)) {
      const { userId } = await auth();
      if (!userId) {
        return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      }
    }

    await auth.protect();
  },
  { signInUrl, signUpUrl },
);

/**
 * The three routes that are meant to be reached from off this machine even in
 * no-auth mode. Each carries no caller identity and authenticates the
 * delivery itself rather than the caller, so none is exempt from a boundary:
 * each simply has a different one from the unlock cookie.
 *
 * ElevenLabs posts call transcripts to the first: it verifies the
 * elevenlabs-signature HMAC over the raw body and refuses every request when
 * ELEVENLABS_WEBHOOK_SECRET is unset, and behind it the Convex action binds the
 * transcript to a voice session by a per-session token minted by `voice.start`.
 *
 * Slack redirects a completed app install to the second. The administrator who
 * clicks the install link is not signed in to Day0 and often is not the
 * manager, so requiring the unlock cookie or a loopback host would make the
 * documented install procedure impossible rather than safer. What the route
 * requires instead is the `state` this deployment signed: bound to one surface,
 * expiring in fifteen minutes, and single-use because the surface holds the
 * nonce. Without one it exchanges nothing and writes nothing.
 *
 * Linear redirects an employee's own app's installation to the third, for the
 * same reason: installing with `actor=app` needs a Linear administrator, who is
 * often not the manager. It requires the same signed, single-use state, and a
 * PKCE verifier the card holds sealed.
 *
 * A tunnel pointed at any of them grants nothing that the deployed Vercel app does
 * not already expose.
 */
const isExternallyCalledRoute = createRouteMatcher([
  '/api/voice/elevenlabs/webhook(.*)',
  '/api/oauth/slack(.*)',
  '/api/oauth/linear',
]);

export default function proxy(...args: Parameters<typeof clerkProxy>) {
  // A build and a server that disagree on the profile refuse every request, whichever of the two
  // asked for the customer sign-in (the wave 10 review, S-m1): the browser and the server would
  // sign people in two different ways.
  const mismatch = profileMismatch(process.env.DAY0_PROFILE);
  if (mismatch) return refuse(mismatch, 503);
  if (CUSTOMER_SIGN_IN) {
    const [request] = args;
    return customerSignInGate(request);
  }
  if (DEV_NO_AUTH) {
    const [request] = args;
    return isExternallyCalledRoute(request) ? NextResponse.next() : devNoAuthGate(request);
  }
  return clerkProxy(...args);
}

function refuse(message: string, status = 403): NextResponse {
  return new NextResponse(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Refuses anyone who cannot show the unlock secret. The secret arrives once on
 * the URL `pnpm dev` prints and is exchanged for a session of this browser's
 * own, signed with the secret, in an httpOnly cookie; the secret itself is
 * never stored in the browser. No refusal here ever echoes it back, so a
 * caller guessing at the boundary learns only that it was wrong.
 *
 * The cookie stays `SameSite=Lax` rather than `Strict`: Slack's install
 * redirect lands the manager back on the dashboard as a cross-site navigation,
 * which `Strict` would refuse. Lax already keeps the session off cross-site
 * POSTs, and a page on another localhost port is same-site to either value,
 * which is why the two POST routes also check `Origin`.
 */
async function devNoAuthGate(request: NextRequest): Promise<NextResponse> {
  const gaps = devNoAuthKeyGaps();
  if (gaps) {
    return refuse(
      'NEXT_PUBLIC_DEV_NO_AUTH=true serves every request as one fixed user, so it is ' +
        `refused until this machine has a local key. Missing: ${gaps.join(', ')}. Run ` +
        '`pnpm dev:no-auth-key`, then `./scripts/sync-convex-env.sh`, then restart `pnpm dev`.',
      503,
    );
  }

  const offered = request.nextUrl.searchParams.get(DEV_NO_AUTH_UNLOCK_PARAM);
  if (offered !== null) {
    if (!isDevNoAuthSecret(offered)) {
      return refuse('That is not the no-auth key for this machine.');
    }
    const cleaned = request.nextUrl.clone();
    cleaned.searchParams.delete(DEV_NO_AUTH_UNLOCK_PARAM);
    const unlocked = NextResponse.redirect(cleaned);
    unlocked.cookies.set(DEV_NO_AUTH_COOKIE, await mintDevNoAuthSession(), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: DEV_NO_AUTH_SESSION_SECONDS,
    });
    return unlocked;
  }

  if (!(await isDevNoAuthSession(request.cookies.get(DEV_NO_AUTH_COOKIE)?.value))) {
    return refuse(
      'NEXT_PUBLIC_DEV_NO_AUTH=true serves every request as one fixed user with no ' +
        'sign-in, so it is refused for callers who cannot show the no-auth key for this ' +
        'machine. Open the unlock URL `pnpm dev` printed on the machine running this ' +
        'server, or turn the flag off and use Clerk.',
    );
  }

  if (!isLoopbackHostHeader(request.headers.get('host'))) {
    return refuse(
      'This request holds the no-auth key but arrived for ' +
        `"${request.headers.get('host') ?? '(no host header)'}" rather than localhost. ` +
        'Reach the app on http://localhost instead.',
    );
  }

  return NextResponse.next();
}

/** The company sign-in's own routes, which a signed-out browser must reach to sign in. */
const isCustomerSignInRoute = createRouteMatcher(['/api/auth/oidc/(.*)']);

/** Clerk's pages, which a customer-local build never draws. */
const isClerkPage = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)']);

/**
 * A redirect to the company sign-in, on the public origin people reach Day0 on
 * (`DAY0_PUBLIC_URL`), else the request's own: Next's server refuses a relative
 * `Location` from the proxy, and behind the customer's proxy the request's own
 * host may be an internal one.
 */
function toCompanySignIn(request: NextRequest, returnTo: string): NextResponse {
  const origin = publicOrigin(process.env.DAY0_PUBLIC_URL);
  const base = 'origin' in origin ? origin.origin : request.nextUrl.origin;
  const location = new URL('/api/auth/oidc/login', base);
  location.searchParams.set('returnTo', returnTo);
  return NextResponse.redirect(location, { status: 307, headers: { 'cache-control': 'no-store' } });
}

/**
 * The customer-local profile's gate (A7): every page and API route needs a
 * session this install sealed, except the sign-in's own routes and the two
 * that are called from outside (the voice webhook and Slack's install
 * redirect, each with its own boundary, above). A signed-out page request is
 * sent to the company sign-in and brought back afterwards; a signed-out API
 * call is answered 401. Clerk's pages are never drawn.
 *
 * This is the optimistic check Next's guide describes (O2): it reads the
 * sealed cookie on the Node runtime and nothing else. Authorisation stays on
 * the deployment, where `getCaller` checks the ID token's signature and the
 * allowed domains again.
 */
async function customerSignInGate(request: NextRequest): Promise<NextResponse> {
  if (isCustomerSignInRoute(request) || isExternallyCalledRoute(request)) {
    return NextResponse.next();
  }
  if (isClerkPage(request)) return toCompanySignIn(request, '/');
  const session = await openSession(
    process.env.DAY0_SESSION_SECRET,
    joinCookie(CUSTOMER_SESSION_COOKIE, (name) => request.cookies.get(name)?.value),
  );
  if (session) return NextResponse.next();
  if (isApiRoute(request) || (request.method !== 'GET' && request.method !== 'HEAD')) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }
  return toCompanySignIn(request, `${request.nextUrl.pathname}${request.nextUrl.search}`);
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
