'use client';

import Link from 'next/link';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';

/**
 * The header's link to the documentation page, shown once the backend says it
 * runs in real mode.
 *
 * The mode is the backend's to report: the root layout used to import the
 * surface mode gate itself, which evaluates the Next process's own environment
 * at import and so threw on every page of a `next start` in real mode.
 *
 * Not prefetched: the route is protected, so a signed-out visitor's prefetch of
 * it is a bounce to the sign-in page from every public page.
 */
export function DocumentationLink(): React.ReactElement | null {
  const config = useQuery(api.config.surfaceMode);
  if (config?.mode !== 'real') return null;
  return (
    <Link
      href="/documentation"
      prefetch={false}
      className="text-xs text-[var(--color-muted)] hover:text-[var(--color-accent)]"
    >
      Documentation
    </Link>
  );
}
