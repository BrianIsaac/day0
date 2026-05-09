import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

/**
 * Next.js 16 renamed `middleware.ts` to `proxy.ts`. Public routes include
 * Clerk's own sign-in/sign-up pages plus webhook endpoints called by external
 * services (added phase-by-phase as their routes land). `auth.protect()` only
 * fires when Clerk has a real publishable key in the environment — keyless
 * dev mode bootstraps keys on the client but not on the server, so the
 * middleware passes through until real keys are wired.
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

export default clerkMiddleware(async (auth, req) => {
  const hasClerkKey = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (hasClerkKey && !isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
