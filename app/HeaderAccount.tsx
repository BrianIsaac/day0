'use client';

import { Show, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import { useEffect, useId, useRef, useState, type FocusEvent as ReactFocusEvent } from 'react';
import { CUSTOMER_SIGN_IN, type SessionAccount } from '@/lib/customer-sign-in';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { useAccount } from './account';
import { clerkAppearance, clerkSignInAppearance } from './clerk-appearance';
import { CustomerSignOutButton, useCustomerAccount } from './Providers';

/** Every control in the slot sits in its one grid cell, so the cell is as large as the largest. */
const LAYER = '[grid-area:1/1]';
const SIGNED_OUT_ROW = `${LAYER} flex items-center gap-2`;
// The account menu's box is the header's 44 px target (N14), whatever size Clerk draws the avatar.
const ACCOUNT_MENU_BOX = `${LAYER} grid size-11 place-items-center`;

/**
 * The account controls in the header. Clerk's `Show`/`UserButton` need a
 * `ClerkProvider` above them, which no-auth dev mode deliberately doesn't
 * render - so that mode gets a badge instead, both to keep the header honest
 * and to make it obvious at a glance that authentication is off. A
 * customer-local build has no Clerk either: its menu is drawn from the
 * session's claims.
 */
export function HeaderAccount(): React.ReactElement {
  if (CUSTOMER_SIGN_IN) return <CustomerAccountMenu />;
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
/** What `SignedOutControls` is told: whether it is the reserved copy, and whether the hint picks it. */
interface SignedOutControlsProps {
  readonly reserved?: { readonly hinted: boolean };
}

function SignedOutControls({ reserved }: SignedOutControlsProps): React.ReactElement {
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
      <SignInButton mode="modal" appearance={clerkSignInAppearance}>
        {signIn}
      </SignInButton>
      <SignUpButton mode="modal" appearance={clerkSignInAppearance}>
        {createAccount}
      </SignUpButton>
    </div>
  );
}

/**
 * Two letters for the account button: the first letters of the first and last words of the name,
 * else the address's first letter.
 *
 * @param account - The session's account.
 */
export function accountInitials(account: SessionAccount): string {
  const words = (account.name ?? '').split(/\s+/).filter((word) => word !== '');
  const letters =
    words.length > 0
      ? `${words[0][0] ?? ''}${words.length > 1 ? (words[words.length - 1][0] ?? '') : ''}`
      : (account.email?.[0] ?? '?');
  return letters.toUpperCase();
}

/**
 * The customer-local account menu: a 44 px button with the person's initials, opening to their
 * name, address and Sign out (N14). A disclosure rather than an ARIA menu, since it holds text as
 * well as the one control; Escape, a press outside and keyboard focus moving out close it, and
 * Escape gives focus back to the button when it was inside. It opens with a short scale and fade
 * from its corner, none where motion is reduced. The slot keeps its 44 px while the session is
 * read, so the nav never moves.
 */
function CustomerAccountMenu(): React.ReactElement {
  const state = useCustomerAccount();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    function closeOutside(event: PointerEvent): void {
      if (holder.current && !holder.current.contains(event.target as Node)) setOpen(false);
    }
    // On the document, not the menu: a browser that does not focus a pressed button leaves focus
    // outside it, and Escape must still close it. Focus goes back to the button only from inside.
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      const focusInside = holder.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (focusInside) button.current?.focus();
    }
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  if (state.status !== 'signed-in') {
    return <div aria-hidden="true" className="size-11" />;
  }
  const account = state.account;
  const label = account.name ?? account.email;

  // Keyboard focus moving out (Tab past Sign out) closes it, so an open panel never covers the
  // control focus moved to (WCAG 2.4.11). Focus going nowhere is a press on the panel's own text,
  // which the press-outside rule above already answers.
  function closeOnFocusOut(event: ReactFocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget;
    if (next instanceof Node && !event.currentTarget.contains(next)) setOpen(false);
  }

  return (
    <div ref={holder} className="relative" onBlur={closeOnFocusOut}>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={label ? `Account: ${label}` : 'Account menu'}
        onClick={(): void => setOpen((was) => !was)}
        className="group grid size-11 place-items-center rounded-full focus-visible:outline-offset-[-4px]"
      >
        <span
          aria-hidden="true"
          className="grid size-8 place-items-center rounded-full border border-[var(--color-accent-line)] bg-[var(--color-accent-soft)] text-xs font-semibold text-[var(--color-accent)] transition-colors duration-150 group-hover:border-[var(--color-accent)] group-aria-expanded:border-[var(--color-accent)]"
        >
          {accountInitials(account)}
        </span>
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute right-0 top-[calc(100%+0.375rem)] z-20 grid w-64 max-w-[calc(100vw-2rem)] origin-top-right gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4 transition-[opacity,scale] duration-150 ease-out starting:scale-[0.96] starting:opacity-0 motion-reduce:transition-none"
      >
        <div className="grid min-w-0 gap-0.5">
          {account.name && <p className="truncate text-sm font-medium">{account.name}</p>}
          {account.email && (
            <p className="truncate text-xs text-[var(--color-muted)]">{account.email}</p>
          )}
        </div>
        <CustomerSignOutButton />
      </div>
    </div>
  );
}
