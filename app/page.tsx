'use client';

import { Suspense, type ReactElement } from 'react';
import { useSearchParams } from 'next/navigation';
import { DEV_BOSS_EMAIL, DEV_BOSS_FIRST_NAME, DEV_NO_AUTH } from '@/lib/dev-auth';
import { useAccount } from './account';
import { SignedInDashboard } from './home/SignedInDashboard';
import { TRANSFER_PARAMETER } from './home/transfer-link';
import { MarketingLanding } from './marketing/MarketingLanding';
import { signInHref } from './marketing/sign-in-href';
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
        // Held above by the no-auth gate, which the session gate passes straight through; wrapped
        // all the same, so every owned root is behind the gate whichever mode builds it.
        <SessionGate fallback={<Pending />}>
          <SignedInDashboard boss={{ email: DEV_BOSS_EMAIL, firstName: DEV_BOSS_FIRST_NAME }} />
        </SessionGate>
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
      // The address is read on the client only, so the page is served as it was without it.
      return (
        <Suspense fallback={<MarketingLanding />}>
          <ReviewAwareLanding />
        </Suspense>
      );
    case 'signed-in':
      // The dashboard reads the manager's rows; until Convex holds the token it says what loads.
      return (
        <SessionGate fallback={<Pending />}>
          <SignedInDashboard boss={account.boss} />
        </SessionGate>
      );
  }
}

/**
 * The marketing page for a signed-out visitor, its sign-in carrying the handover a Review link
 * named, so the acceptance dialog opens once they are signed in (the wave 9 review's U4-m2).
 */
function ReviewAwareLanding(): ReactElement {
  const parameters = useSearchParams();
  return <MarketingLanding signIn={signInHref(parameters.get(TRANSFER_PARAMETER))} />;
}

/** What `/` draws while Convex confirms the manager's sign-in. */
function Pending(): ReactElement {
  return <SessionPending>loading your employees…</SessionPending>;
}
