'use client';

import { ClerkProvider, useAuth } from '@clerk/nextjs';
import { ConvexReactClient } from 'convex/react';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { ReactNode, useMemo } from 'react';

/**
 * Wraps the app in Clerk + Convex. Clerk auto-provisions keyless dev
 * keys when `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is unset. Convex needs
 * a real deployment URL — run `pnpm convex:dev` once to provision one.
 */
export function Providers({ children }: { children: ReactNode }) {
  const client = useMemo(() => {
    const url = process.env.NEXT_PUBLIC_CONVEX_URL;
    if (!url) {
      throw new Error(
        'NEXT_PUBLIC_CONVEX_URL is not set — run `pnpm convex:dev` first.',
      );
    }
    return new ConvexReactClient(url);
  }, []);

  return (
    <ClerkProvider>
      <ConvexProviderWithClerk client={client} useAuth={useAuth}>
        {children}
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
