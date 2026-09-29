'use client';

import { usePathname } from 'next/navigation';
import { ViewTransition, type ReactNode } from 'react';

/**
 * The page's one `<main>`, entering and leaving as a View Transition on every navigation (N29,
 * UX 11). Keyed on the pathname, so the old main exits from where the reader saw it and the new
 * one enters under the header: nothing slides, as a single named main would from a scrolled page
 * (the wave 5 M handover, finding 2). The stylesheet plays the exit and the entry one after the
 * other and holds the header still; under reduced motion the swap is instant.
 */
export function MainTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <ViewTransition
      key={pageKey(pathname)}
      enter="day0-main-enter"
      exit="day0-main-exit"
      default="none"
    >
      <main id="main" tabIndex={-1} className="outline-none">
        {children}
      </main>
    </ViewTransition>
  );
}

/** Routes whose own widget walks through sub-paths: Clerk's catch-all sign-in and sign-up. */
const STEPPED_ROUTES: ReadonlySet<string> = new Set(['sign-in', 'sign-up']);

/**
 * Which page a pathname is, for the transition: the pathname itself, except that a step inside
 * Clerk's sign-in or sign-up (`/sign-in/factor-one`) is the same page, so the widget is not torn
 * down and the page does not play out and in at each step, and an employee's tab
 * (`/agent/<id>/work`) is the employee's page, so its shell stays mounted and a tab change
 * reveals at once (round two section 4.4).
 *
 * @param pathname - The current pathname; null outside the app router.
 */
export function pageKey(pathname: string | null): string {
  const [, first = '', second] = pathname?.split('/') ?? [];
  if (STEPPED_ROUTES.has(first)) return `/${first}`;
  if (first === 'agent' && second !== undefined) return `/agent/${second}`;
  return pathname ?? '';
}
