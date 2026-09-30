'use client';

import { useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { SignIn, SignUp } from '@clerk/nextjs';
import { headedClerkAppearance } from './clerk-appearance';

/** The browser's Navigation API, where it has one. */
function navigationApi(): Navigation | null {
  return 'navigation' in window ? window.navigation : null;
}

/** Call `onChange` whenever the window's entry changes, however it was changed. */
function subscribeToEntry(onChange: () => void): () => void {
  const navigation = navigationApi();
  navigation?.addEventListener('currententrychange', onChange);
  return () => navigation?.removeEventListener('currententrychange', onChange);
}

/** The window's path, or null where no event says when Clerk changes it. */
function observablePath(): string | null {
  return navigationApi() === null ? null : window.location.pathname;
}

/**
 * Whether Clerk's widget at `base` is on its first step.
 *
 * Clerk routes its steps by path (`/sign-in/factor-one`, `/sign-up/verify-email-address`) through
 * its own copy of `history.pushState`, which neither renders the page again nor moves Next's
 * `usePathname` (seen on the bed, 30 September), so the path is read from the window and followed
 * as Clerk's own router follows it: the Navigation API's entry changes, which the back and forward
 * buttons fire too. A browser without that API is never told of a step, so there the first step
 * keeps its title too: a second h1, never a later step without its instructions. The server
 * renders with Next's path.
 */
function useFirstStep(base: string): boolean {
  const serverPath = usePathname();
  const path = useSyncExternalStore(subscribeToEntry, observablePath, () => serverPath);
  return path === base || path === `${base}/`;
}

/** Clerk's sign-in under the sign-in page's own h1, its first step's title left out. */
export function HeadedSignIn() {
  return <SignIn appearance={headedClerkAppearance(useFirstStep('/sign-in'))} />;
}

/** Clerk's sign-up under the sign-up page's own h1, its first step's title left out. */
export function HeadedSignUp() {
  return <SignUp appearance={headedClerkAppearance(useFirstStep('/sign-up'))} />;
}
