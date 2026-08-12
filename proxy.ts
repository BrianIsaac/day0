import { NextResponse, type NextRequest } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { DEV_NO_AUTH, isLoopbackHostHeader } from '@/lib/dev-auth';
import {
  DEV_NO_AUTH_COOKIE,
  DEV_NO_AUTH_UNLOCK_PARAM,
  devNoAuthKeyGaps,
  isDevNoAuthSecret,
} from '@/lib/dev-auth-server';

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts`. Public routes
 * include Clerk's own sign-in/sign-up pages plus webhook endpoints
 * called by external services.
 *
 * `auth.protect()` only fires when Clerk has a real publishable key in
 * the environment. Keyless dev mode bootstraps keys on the client but
 * not on the server, so the middleware passes through until the user
 * claims their Clerk keys. Routes that spend the owner's provider keys
 * must therefore establish the caller in their own handler as well, and
 * never treat this file as their only boundary.
 *
 * In no-auth dev mode Clerk's middleware never runs at all — invoking it
 * without a `ClerkProvider` anywhere in the app would only manufacture a
 * dependency the rest of that mode has deliberately dropped. What runs
 * in its place is the boundary that mode actually claims: the caller must
 * hold this machine's unlock secret, so the one synthetic user is only
 * ever handed to somebody who read it off this machine's terminal.
 */
const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/voice/elevenlabs/webhook(.*)',
  '/api/seed(.*)',
  '/api/onboarding/synthesise(.*)',
]);

const isApiRoute = createRouteMatcher(['/api/(.*)']);

const clerkProxy = clerkMiddleware(async (auth, req) => {
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

  await auth.protect();
});

/**
 * The one route that is meant to be reached from off this machine even in
 * no-auth mode. ElevenLabs posts call transcripts to it and it carries no
 * caller identity, so the route authenticates the delivery itself: it verifies
 * the elevenlabs-signature HMAC over the raw body and refuses every request
 * when ELEVENLABS_WEBHOOK_SECRET is unset. Behind it, the Convex action binds
 * the transcript to a voice session by a per-session token minted by
 * `voice.start` - the agent id alone proves nothing. A tunnel pointed at it
 * grants nothing that the deployed Vercel app does not already expose.
 */
const isExternallyCalledRoute = createRouteMatcher(['/api/voice/elevenlabs/webhook(.*)']);

export default function proxy(...args: Parameters<typeof clerkProxy>) {
  if (DEV_NO_AUTH) {
    const [request] = args;
    return isExternallyCalledRoute(request) ? NextResponse.next() : devNoAuthGate(request);
  }
  return clerkProxy(...args);
}

const COOKIE_LIFETIME_SECONDS = 60 * 60 * 24 * 30;

function refuse(message: string, status = 403): NextResponse {
  return new NextResponse(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Refuses anyone who cannot show the unlock secret. The secret arrives once on
 * the URL `pnpm dev` prints and is kept in an httpOnly cookie from then on;
 * no refusal here ever echoes it back, so a caller guessing at the boundary
 * learns only that it was wrong.
 */
function devNoAuthGate(request: NextRequest): NextResponse {
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
    unlocked.cookies.set(DEV_NO_AUTH_COOKIE, offered, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: COOKIE_LIFETIME_SECONDS,
    });
    return unlocked;
  }

  if (!isDevNoAuthSecret(request.cookies.get(DEV_NO_AUTH_COOKIE)?.value)) {
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

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
