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
    <ViewTransition key={pathname} enter="day0-main-enter" exit="day0-main-exit" default="none">
      <main id="main" tabIndex={-1} className="outline-none">
        {children}
      </main>
    </ViewTransition>
  );
}
