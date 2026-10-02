'use client';

import { UserButton } from '@clerk/nextjs';
import Link from 'next/link';
import { clerkAppearance } from '../clerk-appearance';
import {
  ORGANISATION_HREF,
  ORGANISATION_LINK,
  useCallerIsAdministrator,
} from './use-administrator';

/*
 * The organisation page's ways in from the header's account menu (B8), each drawn for an
 * administrator only. They ask who the caller is, so the header renders them behind its session
 * gate (`HeaderAccount.tsx`), never before Convex holds the token.
 */

/** Clerk's account menu with the organisation page's way in for an administrator only (B8). */
export function AdministeredAccountMenu(): React.ReactElement {
  const administrator = useCallerIsAdministrator();
  return (
    <UserButton appearance={clerkAppearance} userProfileProps={{ appearance: clerkAppearance }}>
      {administrator ? (
        <UserButton.MenuItems>
          <UserButton.Link
            label={ORGANISATION_LINK}
            labelIcon={<OrganisationIcon />}
            href={ORGANISATION_HREF}
          />
        </UserButton.MenuItems>
      ) : null}
    </UserButton>
  );
}

/** The organisation link's icon in Clerk's menu: a building, drawn in the text's colour. */
function OrganisationIcon(): React.ReactElement {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none">
      <path
        d="M3 14V3.5L9 2v12M9 6h4v8M2 14h12M5 5.5h2M5 8h2M5 10.5h2M11 8.5h0M11 11h0"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The organisation page's way in, inside the customer-local account menu: for an administrator
 * only (B8), a 44 px link like the menu's other control.
 */
export function OrganisationMenuLink(): React.ReactElement | null {
  const administrator = useCallerIsAdministrator();
  if (!administrator) return null;
  return (
    <Link
      href={ORGANISATION_HREF}
      className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-border)] px-3 text-sm text-[var(--color-fg)] no-underline hover:border-[var(--color-accent)]"
    >
      {ORGANISATION_LINK}
    </Link>
  );
}
