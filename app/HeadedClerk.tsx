'use client';

import { useSyncExternalStore, type ReactNode } from 'react';
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

/** The path a headed Clerk widget's first step is drawn at. */
type ClerkBase = '/sign-in' | '/sign-up';

/**
 * Whether Clerk's widget at `base` is on its first step.
 *
 * Clerk routes its steps by path (`/sign-in/factor-one`, `/sign-up/verify-email-address`) through
 * its own copy of `history.pushState`, which neither renders the page again nor moves Next's
 * `usePathname` (seen on the bed, 30 September), so the path is read from the window and followed
 * as Clerk's own router follows it: the Navigation API's entry changes, which the back and forward
 * buttons fire too. A browser without that API is never told of a step, so there every step keeps
 * Clerk's title, never a later step without its instructions, and `StepHeading` steps the page's
 * heading down to match. The server renders with Next's path.
 */
function useFirstStep(base: ClerkBase): boolean {
  const serverPath = usePathname();
  const path = useSyncExternalStore(subscribeToEntry, observablePath, () => serverPath);
  return path === base || path === `${base}/`;
}

/** Clerk's sign-in under the sign-in page's `StepHeading`, its first step's title left out. */
export function HeadedSignIn() {
  return <SignIn appearance={headedClerkAppearance(useFirstStep('/sign-in'))} />;
}

/** Clerk's sign-up under the sign-up page's `StepHeading`, its first step's title left out. */
export function HeadedSignUp() {
  return <SignUp appearance={headedClerkAppearance(useFirstStep('/sign-up'))} />;
}

/** The page heading drawn over a headed Clerk widget. */
interface StepHeadingProps {
  /** The path of the widget's first step. */
  readonly base: ClerkBase;
  /** The heading's classes, kept on every step so it looks the same. */
  readonly className: string;
  /** The heading's words. */
  readonly children: ReactNode;
}

/**
 * The page's heading over a Clerk widget, which reads the widget's step as the widget does: the
 * page's one h1 on the first step, where the widget leaves its own title out, and on a later
 * step, where Clerk's title ("Enter your password") is the h1, the same words and look in a
 * paragraph, so the outline never carries two level-one headings.
 */
export function StepHeading({ base, className, children }: StepHeadingProps) {
  const Heading = useFirstStep(base) ? 'h1' : 'p';
  return <Heading className={className}>{children}</Heading>;
}
