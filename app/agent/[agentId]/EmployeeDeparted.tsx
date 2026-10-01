'use client';

import { useQueries } from 'convex/react';
import { useParams } from 'next/navigation';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { deploymentZone } from '@/lib/zone';
import { ButtonLink } from '../../components/Button';
import { departedLine, departedTitle } from '../../handover-words';
import { Answer, BACK, NoSuchEmployee } from './NoSuchEmployee';

/** Where an employee the caller handed over went, as `managerTransfers.departureOf` answers it. */
type Departure = NonNullable<FunctionReturnType<typeof api.managerTransfers.departureOf>>;

/**
 * The employee page for an employee the caller handed over to another manager (the transfer
 * plan, section 7.4): whom it reports to and since when, in place of "not yours", since its
 * record went with it and the caller's record of the handover is on their home. The heading takes
 * focus: the page may have changed under the manager when the new one accepted.
 *
 * @param departure - Where it went.
 */
export function EmployeeDeparted({ departure }: { departure: Departure }) {
  return (
    <Answer title={departedTitle(departure.agentName)} focus>
      <p className="text-[var(--color-fg-2)]">
        {departedLine(
          departure.agentName,
          departure.toAddress,
          departure.decidedAt,
          deploymentZone(),
        )}
      </p>
      <ButtonLink href="/" variant="text">
        {BACK}
      </ButtonLink>
    </Answer>
  );
}

/**
 * The employee page for an employee the caller does not own: where it went, when the caller handed
 * it over, and "No such employee" otherwise. The departure is read through `useQueries`, so a link
 * whose id the backend refuses reads as no such employee rather than failing again.
 */
export function NotYourEmployee() {
  const { agentId } = useParams<{ agentId: string }>();
  const { departure }: Record<string, Departure | null | undefined | Error> = useQueries({
    departure: {
      query: api.managerTransfers.departureOf,
      // The backend validates the id; one that names no employee is refused as a value.
      args: { agentId: agentId as Id<'agents'> },
    },
  });
  if (departure === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center text-[var(--color-muted)]">
        loading employee…
      </div>
    );
  }
  if (departure === null || departure instanceof Error) return <NoSuchEmployee />;
  return <EmployeeDeparted departure={departure} />;
}
