'use client';

import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { clerkAppearance } from './clerk-appearance';

/**
 * The account controls in the header. Clerk's `Show`/`UserButton` need a
 * `ClerkProvider` above them, which no-auth dev mode deliberately doesn't
 * render - so that mode gets a badge instead, both to keep the header honest
 * and to make it obvious at a glance that authentication is off.
 */
export function HeaderAccount() {
  if (DEV_NO_AUTH) {
    return (
      <span
        className="text-xs uppercase tracking-[0.18em] px-2.5 py-1 rounded-md border border-[var(--color-warn)]/40 text-[var(--color-warn)] bg-[var(--color-warn)]/10"
        title="NEXT_PUBLIC_DEV_NO_AUTH is on: Clerk is skipped and every request runs as one local boss. Development only."
      >
        No-auth dev mode
      </span>
    );
  }

  return (
    <>
      <Show when="signed-out">
        <div className="flex items-center gap-2">
          <SignInButton mode="modal" appearance={clerkAppearance}>
            <button className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-border)] px-3 text-xs hover:border-[var(--color-accent)]">
              Sign in
            </button>
          </SignInButton>
          <SignUpButton mode="modal" appearance={clerkAppearance}>
            <button className="inline-flex min-h-11 items-center rounded-lg bg-[var(--color-accent)] px-3 text-xs font-medium text-[var(--color-bg)] hover:opacity-90">
              Create account
            </button>
          </SignUpButton>
        </div>
      </Show>
      <Show when="signed-in">
        <UserButton
          appearance={clerkAppearance}
          userProfileProps={{ appearance: clerkAppearance }}
        />
      </Show>
    </>
  );
}
