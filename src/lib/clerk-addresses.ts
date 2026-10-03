/**
 * Where Clerk sends a visitor to sign in and to sign up, and where either lands after, under the
 * hosted Clerk sign-in. Day0's own `/sign-in` and `/sign-up` are the defaults, so a signed-out
 * link to a page that needs a sign-in reaches Day0's page and returns to the page it asked for,
 * whether or not the deployment sets the `NEXT_PUBLIC_CLERK_*_URL` names; a name that is set
 * overrides its default. Without these defaults Clerk sends the visitor to the instance's own
 * Account Portal (round 0141 R-D item 4).
 */

/** The four addresses the proxy and the Clerk provider are given. */
export interface ClerkAddresses {
  readonly signInUrl: string;
  readonly signUpUrl: string;
  readonly signInFallbackRedirectUrl: string;
  readonly signUpFallbackRedirectUrl: string;
}

/** Day0's own pages, used for every address the environment does not name. */
export const DEFAULT_CLERK_ADDRESSES: ClerkAddresses = {
  signInUrl: '/sign-in',
  signUpUrl: '/sign-up',
  signInFallbackRedirectUrl: '/',
  signUpFallbackRedirectUrl: '/',
};

/**
 * The addresses, each the environment's value when it names one and the default otherwise. An
 * empty or blank value names none.
 *
 * @param named - The values the environment holds, any of them unset.
 */
export function clerkAddresses(
  named: Partial<Record<keyof ClerkAddresses, string>>,
): ClerkAddresses {
  const pick = (key: keyof ClerkAddresses): string =>
    named[key]?.trim() || DEFAULT_CLERK_ADDRESSES[key];
  return {
    signInUrl: pick('signInUrl'),
    signUpUrl: pick('signUpUrl'),
    signInFallbackRedirectUrl: pick('signInFallbackRedirectUrl'),
    signUpFallbackRedirectUrl: pick('signUpFallbackRedirectUrl'),
  };
}

/**
 * The deployment's addresses. Each name is read as a literal `process.env.NEXT_PUBLIC_...`
 * expression, the only form Next inlines into the browser bundle.
 */
export function deploymentClerkAddresses(): ClerkAddresses {
  return clerkAddresses({
    signInUrl: process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL,
    signUpUrl: process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL,
    signInFallbackRedirectUrl: process.env.NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL,
    signUpFallbackRedirectUrl: process.env.NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL,
  });
}
