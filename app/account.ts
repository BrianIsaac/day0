'use client';

import { useState, useSyncExternalStore } from 'react';
import { useClerk, useUser } from '@clerk/nextjs';
import { CUSTOMER_SIGN_IN } from '@/lib/customer-sign-in';
import type { Boss } from './home/types';
import { useCustomerAccount } from './Providers';
import { holdsClerkSession } from './session-hint';

/**
 * Who `/` is for, as far as the browser knows: nobody yet, a visitor, or a signed-in manager.
 * The page and the header branch on this, never on Clerk's `user` alone (decision N29's split).
 */
export type Account =
  | { readonly kind: 'resolving' }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'signed-in'; readonly boss: Boss };

const RESOLVING: Account = { kind: 'resolving' };
const SIGNED_OUT: Account = { kind: 'signed-out' };

/** Whether this browser holds a Clerk session to resolve: `unknown` until the page has hydrated. */
type SessionHint = 'unknown' | 'none' | 'present';

function readSessionHint(): SessionHint {
  return holdsClerkSession(document.cookie) ? 'present' : 'none';
}

/** The server, and the first render that hydrates its HTML, cannot read a cookie. */
function serverSessionHint(): SessionHint {
  return 'unknown';
}

/** Cookies announce no change; the hint is re-read on every render, which is all it needs. */
function noSubscription(): () => void {
  return () => undefined;
}

function sameBoss(a: Boss | null, b: Boss | null): boolean {
  // A manager with neither an email nor a first name is still somebody, never the same as nobody.
  if (a === null || b === null) return a === b;
  return a.email === b.email && a.firstName === b.firstName;
}

/**
 * Who `/` is for under the customer-local profile: the person the session's ID token names
 * (`useCustomerAccount`), never Clerk. The whole tree is held until the deployment accepts the
 * token, so a page reading this has a signed-in person by then.
 */
function useCustomerSignInAccount(): Account {
  const state = useCustomerAccount();
  switch (state.status) {
    case 'signed-in':
      return {
        kind: 'signed-in',
        boss: { email: state.account.email, firstName: state.account.firstName },
      };
    case 'resolving':
      return RESOLVING;
    case 'signed-out':
    case 'unavailable':
      return SIGNED_OUT;
    default: {
      const unknown: never = state;
      throw new Error(`unhandled account state ${String(unknown)}`);
    }
  }
}

/**
 * Who `/` is for under Clerk, the hosted demo's sign-in (decision D2 (a) of the wave 5 review).
 *
 * Until Clerk has answered the answer is `resolving`, and the page shows a neutral shell: the
 * served HTML is the same for both audiences, so a signed-in manager never sees the marketing
 * page first. It becomes `signed-out` early when this browser holds no Clerk session at all (a
 * first visit, or one that signed out), or when Clerk's script failed to load, so a visitor is
 * not held on an empty page for Clerk's fifteen-second load timeout.
 *
 * Clerk's `isLoaded` can turn false again while it re-resolves a session mid-visit; the last
 * signed-in answer is held through that, so the dashboard is never swapped for the marketing
 * page in place. Only Clerk's own resolved answer of "no user" ends it.
 */
function useClerkAccount(): Account {
  const { isLoaded, user } = useUser();
  const clerk = useClerk();
  const hint = useSyncExternalStore(noSubscription, readSessionHint, serverSessionHint);
  const [held, setHeld] = useState<Boss | null>(null);

  const resolved: Boss | null | undefined = !isLoaded
    ? undefined
    : user
      ? { email: user.primaryEmailAddress?.emailAddress, firstName: user.firstName ?? undefined }
      : null;
  // Kept from the previous render in state, as React's docs set out, so a re-resolve can use it.
  if (resolved !== undefined && !sameBoss(resolved, held)) setHeld(resolved);

  if (resolved) return { kind: 'signed-in', boss: resolved };
  if (resolved === null) return SIGNED_OUT;
  if (held) return { kind: 'signed-in', boss: held };
  if (clerk.status === 'error' || hint === 'none') return SIGNED_OUT;
  return RESOLVING;
}

/**
 * Who `/` is for: the customer sign-in's person in a customer-local build, else Clerk's answer.
 * Chosen once per build, so every render calls the same hooks.
 */
export const useAccount: () => Account = CUSTOMER_SIGN_IN
  ? useCustomerSignInAccount
  : useClerkAccount;
