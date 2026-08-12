import { NextResponse } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { DEV_NO_AUTH } from '@/lib/dev-auth';

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
 * dependency the rest of that mode has deliberately dropped.
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

export default function proxy(...args: Parameters<typeof clerkProxy>) {
  if (DEV_NO_AUTH) return NextResponse.next();
  return clerkProxy(...args);
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
