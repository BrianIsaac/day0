'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DEV_NO_AUTH } from '@/lib/dev-auth';
import { useAccount } from '../account';
import { GitHubMark } from './GitHubMark';

const TONE =
  'rounded-md text-[var(--color-muted)] transition-colors duration-150 hover:text-[var(--color-fg)]';
// Each link is a 44 px target inside the 56 px header (N14).
const LINK = `${TONE} inline-flex min-h-11 items-center px-2.5 text-[13px]`;

/**
 * The public site navigation in the header, shown exactly when `/` shows the marketing page:
 * to a visitor the browser knows is signed out, never while that is still being resolved. No-auth dev mode always has its local manager signed
 * in, so it never shows. Hidden below the `md` width, where the page itself links onwards.
 */
export function SiteNav() {
  if (DEV_NO_AUTH) return null;
  return <SignedOutNav />;
}

function SignedOutNav() {
  const account = useAccount();
  const pathname = usePathname();
  if (account.kind !== 'signed-out') return null;
  return (
    <nav aria-label="Site" className="hidden items-center gap-1.5 md:flex">
      <Link href="/#how" className={LINK}>
        How it works
      </Link>
      <Link href="/#evidence" className={LINK}>
        Evidence
      </Link>
      <Link
        href="/walkthrough"
        aria-current={pathname === '/walkthrough' ? 'page' : undefined}
        className={LINK}
      >
        Walkthrough
      </Link>
      <GitHubMark className={`${TONE} inline-flex size-11 items-center justify-center`} />
    </nav>
  );
}
