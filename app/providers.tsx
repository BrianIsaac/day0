'use client';

import { ClerkProvider, useAuth } from '@clerk/nextjs';
import { ConvexProvider, ConvexReactClient } from 'convex/react';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { ReactNode, useMemo } from 'react';
import { DEV_NO_AUTH } from '@/lib/dev-auth';

/**
 * Wraps with Clerk + Convex. Clerk auto-provisions keyless dev keys when
 * `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is unset, so we don't need to
 * special-case the unconfigured path.
 *
 * In no-auth dev mode Clerk is left out of the tree entirely and Convex gets a
 * plain provider — the backend mints the caller identity itself, so there is no
 * token to hand it.
 */
export function Providers({ children }: { children: ReactNode }) {
  const client = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) {
      throw new Error('NEXT_PUBLIC_CONVEX_URL is not set — run `pnpm convex:dev` first');
    }
    return new ConvexReactClient(url);
  }, []);

  if (DEV_NO_AUTH) {
    return <ConvexProvider client={client}>{children}</ConvexProvider>;
  }

  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
