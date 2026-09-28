'use client';

import Link from 'next/link';
import { useUser } from '@clerk/nextjs';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { GitHubMark } from './GitHubMark';

const TONE =
  'rounded-md text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-fg)]';
const LINK = `${TONE} px-2.5 py-2 text-[13px]`;

/**
 * The public site navigation in the header, shown exactly when `/` shows the marketing page:
 * to a visitor with no signed-in user. No-auth dev mode always has its local manager signed
 * in, so it never shows. Hidden below the `md` width, where the page itself links onwards.
 */
export function SiteNav() {
  if (DEV_NO_AUTH) return null;
  return <SignedOutNav />;
}

function SignedOutNav() {
  const { user } = useUser();
  if (user) return null;
  return (
    <nav aria-label="Site" className="hidden items-center gap-1.5 md:flex">
      <Link href="/#how" className={LINK}>
        How it works
      </Link>
      <Link href="/#evidence" className={LINK}>
        Evidence
      </Link>
      {/* Not prefetched: until its route lands a prefetch would reach the proxy's sign-in wall. */}
      <Link href="/walkthrough" prefetch={false} className={LINK}>
        Walkthrough
      </Link>
      <GitHubMark className={`${TONE} inline-flex items-center p-2`} />
    </nav>
  );
}
