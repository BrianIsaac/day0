'use client';

import { useState, useSyncExternalStore } from 'react';
import { useClerk, useUser } from '@clerk/nextjs';
import type { Boss } from './home/types';

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

/**
 * Clerk's client cookie, `__client_uat` (suffixed per instance in newer SDKs), holds the time of
 * the browser's last sign-in and `0` once it has signed out. It is set by Clerk on this origin and
 * readable by script; with none above zero, this browser has no session for Clerk to resolve.
 */
const CLIENT_UAT = /(?:^|;\s*)__client_uat(?:_[^=]*)?=(\d+)/g;

/** Whether this browser holds a Clerk session to resolve: `unknown` until the page has hydrated. */
type SessionHint = 'unknown' | 'none' | 'present';

function readSessionHint(): SessionHint {
  const stamps = [...document.cookie.matchAll(CLIENT_UAT)].map((match) => Number(match[1]));
  return stamps.some((stamp) => stamp > 0) ? 'present' : 'none';
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
 * Resolve who `/` is for (decision D2 (a) of the wave 5 review).
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
export function useAccount(): Account {
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
