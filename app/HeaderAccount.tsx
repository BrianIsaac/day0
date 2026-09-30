'use client';

import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { useAccount } from './account';
import { clerkAppearance } from './clerk-appearance';

/** Every control in the slot sits in its one grid cell, so the cell is as large as the largest. */
const LAYER = '[grid-area:1/1]';
const SIGNED_OUT_ROW = `${LAYER} flex items-center gap-2`;
// The account menu's box is the header's 44 px target (N14), whatever size Clerk draws the avatar.
const ACCOUNT_MENU_BOX = `${LAYER} grid size-11 place-items-center`;

/**
 * The account controls in the header. Clerk's `Show`/`UserButton` need a
 * `ClerkProvider` above them, which no-auth dev mode deliberately doesn't
 * render - so that mode gets a badge instead, both to keep the header honest
 * and to make it obvious at a glance that authentication is off.
 */
export function HeaderAccount(): React.ReactElement {
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

  return <AccountSlot />;
}

/**
 * The slot the account controls mount in, holding their room from the first paint.
 *
 * Clerk draws nothing until its script has loaded, well after the page has painted, and the
 * header's nav sits in the space the slot leaves; a slot that grew when Clerk answered moved the
 * nav 90 px (30 September). So the slot holds an invisible copy of the controls Clerk will mount,
 * drawn from the same markup, and the live ones mount over it in the same grid cell. Until Clerk
 * answers both copies are drawn and the session hint the head's script wrote before the first
 * paint picks one (`app/session-hint.ts`, `app/globals.css`); once it has, its answer does. The
 * controls themselves stay hidden until Clerk answers (the neutral shell, wave 5 D2).
 */
function AccountSlot(): React.ReactElement {
  const account = useAccount();
  // Only an unanswered slot is the hint's to choose: signed in or out inside the page, the hint on
  // <html> is stale and Clerk's answer is not.
  const hinted = account.kind === 'resolving';
  return (
    <div className="grid items-center justify-items-end">
      {account.kind !== 'signed-in' && <SignedOutControls reserved={{ hinted }} />}
      {account.kind !== 'signed-out' && (
        <div
          aria-hidden="true"
          data-account-reserve={hinted ? 'signed-in' : undefined}
          className={ACCOUNT_MENU_BOX}
        />
      )}
      <Show when="signed-out">
        <SignedOutControls />
      </Show>
      <Show when="signed-in">
        <div className={ACCOUNT_MENU_BOX}>
          <UserButton
            appearance={clerkAppearance}
            userProfileProps={{ appearance: clerkAppearance }}
          />
        </div>
      </Show>
    </div>
  );
}

/**
 * Sign in and Create account, which open Clerk's modals. Reserved, the same two buttons are drawn
 * invisible and out of reach of a pointer, a keyboard and assistive technology, so the room they
 * hold is exactly the live buttons' at every width and in every font; `hinted` while the head's
 * hint, not Clerk, decides whether they are the room to hold.
 */
function SignedOutControls({
  reserved,
}: {
  readonly reserved?: { readonly hinted: boolean };
}): React.ReactElement {
  const signIn = (
    <button
      type="button"
      className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-border)] px-3 text-xs hover:border-[var(--color-accent)]"
    >
      Sign in
    </button>
  );
  const createAccount = (
    <button
      type="button"
      className="inline-flex min-h-11 items-center rounded-lg bg-[var(--color-accent)] px-3 text-xs font-medium text-[var(--color-bg)] hover:opacity-90"
    >
      Create account
    </button>
  );
  if (reserved) {
    return (
      <div
        aria-hidden="true"
        inert
        data-account-reserve={reserved.hinted ? 'signed-out' : undefined}
        className={`${SIGNED_OUT_ROW} invisible`}
      >
        {signIn}
        {createAccount}
      </div>
    );
  }
  return (
    <div className={SIGNED_OUT_ROW}>
      <SignInButton mode="modal" appearance={clerkAppearance}>
        {signIn}
      </SignInButton>
      <SignUpButton mode="modal" appearance={clerkAppearance}>
        {createAccount}
      </SignUpButton>
    </div>
  );
}
