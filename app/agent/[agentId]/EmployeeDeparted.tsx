'use client';

import { useEffect, useMemo } from 'react';
import { useQueries } from 'convex/react';
import { useParams } from 'next/navigation';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { log } from '@/lib/logger';
import { deploymentZone } from '@/lib/zone';
import { ButtonLink } from '../../components/Button';
import { departedLine, departedTitle } from '../../handover-words';
import { Answer, BACK, EmployeePageFailed, NoSuchEmployee } from './NoSuchEmployee';

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
 * it over, and "No such employee" otherwise. The departure is read through `useQueries`, so a
 * failed read is a value: it is logged and the page offers the read again, rather than call an
 * employee the caller may still own "no such employee".
 *
 * @param retry - Loads the page again, from the net above it.
 */
export function NotYourEmployee({ retry }: { retry: () => void }) {
  const { agentId } = useParams<{ agentId: string }>();
  // `useQueries` subscribes by the object's identity, so it is made once per employee.
  const queries = useMemo(
    () => ({
      departure: {
        query: api.managerTransfers.departureOf,
        args: { agentId: agentId as Id<'agents'> },
      },
    }),
    [agentId],
  );
  const { departure }: Record<string, Departure | null | undefined | Error> = useQueries(queries);
  const failed = departure instanceof Error ? departure.message : undefined;
  useEffect(() => {
    if (failed !== undefined) log.warn('departure read failed', { agentId, reason: failed });
  }, [agentId, failed]);
  if (departure === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center text-[var(--color-muted)]">
        loading employee…
      </div>
    );
  }
  if (departure instanceof Error) return <EmployeePageFailed retry={retry} />;
  if (departure === null) return <NoSuchEmployee />;
  return <EmployeeDeparted departure={departure} />;
}
