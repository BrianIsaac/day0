'use client';

import type { ReactElement } from 'react';
import { DEV_BOSS_EMAIL, DEV_BOSS_FIRST_NAME, DEV_NO_AUTH } from '@/lib/dev-auth';
import { useAccount } from './account';
import { SignedInDashboard } from './home/SignedInDashboard';
import { MarketingLanding } from './marketing/MarketingLanding';
import { SessionGate, SessionPending } from './Providers';

/**
 * `/` serves both audiences from one route (decision N29): the marketing page to a signed-out
 * visitor, the company dashboard to a signed-in manager, and neither until the browser knows
 * which it has (`useAccount`). No-auth dev mode always has its local manager signed in.
 */
export default function LandingPage() {
  return (
    <div className="min-h-[calc(100vh-3.25rem)] flex flex-col">
      {DEV_NO_AUTH ? (
        <SignedInDashboard boss={{ email: DEV_BOSS_EMAIL, firstName: DEV_BOSS_FIRST_NAME }} />
      ) : (
        <ClerkLanding />
      )}
    </div>
  );
}

function ClerkLanding(): ReactElement | null {
  const account = useAccount();
  switch (account.kind) {
    case 'resolving':
      return null;
    case 'signed-out':
      return <MarketingLanding />;
    case 'signed-in':
      // The dashboard reads the manager's rows; until Convex holds the token it says what loads.
      return (
        <SessionGate fallback={<SessionPending>loading your employees…</SessionPending>}>
          <SignedInDashboard boss={account.boss} />
        </SessionGate>
      );
  }
}
