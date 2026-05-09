'use client';

import { ClerkProvider } from '@clerk/nextjs';
import { ReactNode } from 'react';

/**
 * Phase 2: Clerk only. Convex provider wraps in alongside ClerkProvider in
 * Phase 3 once the deployment + schema are wired.
 */
export function Providers({ children }: { children: ReactNode }) {
  return <ClerkProvider>{children}</ClerkProvider>;
}
