'use client';

import { useEffect, useMemo } from 'react';
import { useQueries } from 'convex/react';
import { useParams } from 'next/navigation';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { log } from '@/lib/logger';
import { deploymentZone } from '@/lib/zone';
import { ButtonLink } from '../../components/Button';
import { departedLine, departedTitle, departedTabTitle } from '../../handover-words';
import { Answer, BACK, EmployeePageFailed, NoSuchEmployee } from './NoSuchEmployee';

/** What the employee page draws for its reader, as `transferDepartures.employeePage` answers it. */
type EmployeePage = FunctionReturnType<typeof api.transferDepartures.employeePage>;

/** Where an employee the caller handed over went, and what became of it since. */
type Departure = Extract<EmployeePage, { page: 'departed' }>['departure'];

/**
 * The employee page for an employee the caller handed over to another manager (the transfer
 * plan, section 7.4): whom it reports to and since when, or that it was retired or moved on
 * since, in place of "not yours", since its record went with it and the caller's record of the
 * handover is on their home. The heading takes focus: the page may have changed under the manager
 * when the new one accepted. The browser tab says so too: the title the page was served with
 * named the tab of an employee that is no longer the manager's.
 *
 * @param departure - Where it went.
 */
export function EmployeeDeparted({ departure }: { departure: Departure }) {
  const title = departedTabTitle(departure.agentName);
  useEffect(() => {
    document.title = title;
  }, [title]);
  return (
    <Answer title={departedTitle(departure.agentName)} focus>
      <p className="text-[var(--color-fg-2)]">
        {departedLine({
          name: departure.agentName,
          to: departure.toAddress,
          since: departure.decidedAt,
          zone: deploymentZone(),
          afterwards: departure.afterwards,
        })}
      </p>
      <ButtonLink href="/" variant="text">
        {BACK}
      </ButtonLink>
    </Answer>
  );
}

/**
 * The employee page for an employee the caller does not own, when the shell's read refused it
 * after all (the page's first read answered before a handover landed): where it went, when the
 * caller handed it over, and "No such employee" otherwise. The answer is read through
 * `useQueries`, so a failed read is a value: it is logged and the page offers the read again,
 * rather than call an employee the caller may still own "no such employee".
 *
 * @param retry - Loads the page again, from the net above it.
 */
export function NotYourEmployee({ retry }: { retry: () => void }) {
  const { agentId } = useParams<{ agentId: string }>();
  // `useQueries` subscribes by the object's identity, so it is made once per employee.
  const queries = useMemo(
    () => ({
      page: { query: api.transferDepartures.employeePage, args: { agentId } },
    }),
    [agentId],
  );
  const { page }: Record<string, EmployeePage | undefined | Error> = useQueries(queries);
  const failed = page instanceof Error ? page.message : undefined;
  useEffect(() => {
    if (failed !== undefined) log.warn('departure read failed', { agentId, reason: failed });
  }, [agentId, failed]);
  if (page === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center text-[var(--color-muted)]">
        loading employee…
      </div>
    );
  }
  if (page instanceof Error) return <EmployeePageFailed retry={retry} />;
  if (page.page === 'departed') return <EmployeeDeparted departure={page.departure} />;
  return <NoSuchEmployee />;
}
