import { NextResponse } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { DEV_NO_AUTH, isLoopbackHostHeader } from '@/lib/dev-auth';

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts`. Public routes
 * include Clerk's own sign-in/sign-up pages plus webhook endpoints
 * called by external services.
 *
 * `auth.protect()` only fires when Clerk has a real publishable key in
 * the environment. Keyless dev mode bootstraps keys on the client but
 * not on the server, so the middleware passes through until the user
 * claims their Clerk keys.
 *
 * In no-auth dev mode Clerk's middleware never runs at all — invoking it
 * without a `ClerkProvider` anywhere in the app would only manufacture a
 * dependency the rest of that mode has deliberately dropped. What runs
 * in its place is the boundary that mode actually claims: every request
 * must have arrived for a loopback host, so the one synthetic user is
 * only ever handed to somebody sitting at this machine.
 */
const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/voice/elevenlabs/webhook(.*)',
  '/api/seed(.*)',
  '/api/onboarding/synthesise(.*)',
  '/api/voice/elevenlabs/start(.*)',
  '/api/voice/chat(.*)',
]);

const clerkProxy = clerkMiddleware(async (auth, req) => {
  const hasClerkKey = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (hasClerkKey && !isPublicRoute(req)) {
    await auth.protect();
  }
});

/**
 * The one route that is meant to be reached from off this machine even in
 * no-auth mode. ElevenLabs posts call transcripts to it, it carries no caller
 * identity, and the Convex action behind it authenticates the payload by
 * matching (agentId, conversationId) against an active voice session rather
 * than by trusting the caller - so a tunnel pointed at it grants nothing that
 * the deployed Vercel app does not already expose.
 */
const isExternallyCalledRoute = createRouteMatcher(['/api/voice/elevenlabs/webhook(.*)']);

export default function proxy(...args: Parameters<typeof clerkProxy>) {
  if (DEV_NO_AUTH) {
    const [request] = args;
    if (!isLoopbackHostHeader(request.headers.get('host')) && !isExternallyCalledRoute(request)) {
      return new NextResponse(
        'NEXT_PUBLIC_DEV_NO_AUTH=true serves every request as one fixed user with no ' +
          'sign-in, so it is refused for any host other than localhost. This request ' +
          `arrived for "${request.headers.get('host') ?? '(no host header)'}". Reach the ` +
          'app on http://localhost instead, or turn the flag off and use Clerk.',
        { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }
    return NextResponse.next();
  }
  return clerkProxy(...args);
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
