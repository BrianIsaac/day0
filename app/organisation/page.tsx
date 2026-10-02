import type { Metadata } from 'next';
import { SessionGate, SessionPending } from '../Providers';
import { OrganisationPage } from './OrganisationPage';

/** The page's title in the tab. */
export const metadata: Metadata = { title: 'Organisation' };

/**
 * The organisation page (B8), drawn once Convex holds the signed-in person's token: the
 * administrators' connections, or the words that refuse anyone else. An access request's link
 * names the card an employee's own Linear app is recorded for (`?card=<surfaceId>`).
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const { card } = await searchParams;
  return (
    <SessionGate fallback={<SessionPending>loading the organisation…</SessionPending>}>
      <OrganisationPage cardId={typeof card === 'string' && card !== '' ? card : undefined} />
    </SessionGate>
  );
}
