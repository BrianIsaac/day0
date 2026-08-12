import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';

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

export default clerkMiddleware(async (auth, req) => {
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

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
