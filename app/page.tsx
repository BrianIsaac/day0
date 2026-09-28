'use client';

import { useUser } from '@clerk/nextjs';
import { DEV_BOSS_EMAIL, DEV_BOSS_FIRST_NAME, DEV_NO_AUTH } from '@/lib/dev-auth';
import { SignedInDashboard } from './home/SignedInDashboard';
import { MarketingLanding } from './marketing/MarketingLanding';

/**
 * `/` serves both audiences from one route (decision N29): the marketing page to a visitor with
 * no signed-in user, the company dashboard to a signed-in manager. No-auth dev mode always has
 * its local manager signed in.
 */
export default function LandingPage() {
  return (
    <main className="min-h-[calc(100vh-3.25rem)] flex flex-col">
      {DEV_NO_AUTH ? (
        <SignedInDashboard boss={{ email: DEV_BOSS_EMAIL, firstName: DEV_BOSS_FIRST_NAME }} />
      ) : (
        <ClerkLanding />
      )}
    </main>
  );
}

function ClerkLanding() {
  const { user } = useUser();
  if (!user) return <MarketingLanding />;
  return (
    <SignedInDashboard
      boss={{
        email: user?.primaryEmailAddress?.emailAddress,
        firstName: user?.firstName ?? undefined,
      }}
    />
  );
}
