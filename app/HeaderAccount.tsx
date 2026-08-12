'use client';

import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import { DEV_NO_AUTH } from '@/lib/dev-auth';

/**
 * The account controls in the header. Clerk's `Show`/`UserButton` need a
 * `ClerkProvider` above them, which no-auth dev mode deliberately doesn't
 * render — so that mode gets a badge instead, both to keep the header honest
 * and to make it obvious at a glance that authentication is off.
 */
export function HeaderAccount() {
  if (DEV_NO_AUTH) {
    return (
      <span
        className="text-[10px] uppercase tracking-[0.18em] px-2.5 py-1 rounded-md border border-[var(--color-warn)]/40 text-[var(--color-warn)] bg-[var(--color-warn)]/10"
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
          <SignInButton mode="modal">
            <button className="text-xs px-3 py-1.5 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)]">
              Sign in
            </button>
          </SignInButton>
          <SignUpButton mode="modal">
            <button className="text-xs px-3 py-1.5 rounded-lg bg-[var(--color-accent)] text-[var(--color-bg)] font-medium hover:opacity-90">
              Create account
            </button>
          </SignUpButton>
        </div>
      </Show>
      <Show when="signed-in">
        <UserButton
          appearance={{
            variables: {
              colorBackground: '#18181b',
              colorText: '#f4f4f5',
              colorPrimary: '#22d3ee',
            },
          }}
        />
      </Show>
    </>
  );
}
