'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAction, useQueries, type RequestForQueries } from 'convex/react';
import { ConvexError } from 'convex/values';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { FIGURES_READ_BY_PAGES } from '@/metrics/figures-output';
import type { AgentMetrics } from '@/metrics/types';

/**
 * How often an employee's figures read by pages are read again while its page stays open: the
 * read is no subscription, so a page that stays open is not left on its first answer, and a walk
 * of every record is not made more often than this.
 */
export const EMPLOYEE_FIGURES_REREAD_MS = 60_000;

/** Whether a read's refusal is `metrics:forAgent`'s: the employee's figures are read by pages. */
export function readByPages(read: unknown): boolean {
  return read instanceof ConvexError && read.data === FIGURES_READ_BY_PAGES;
}

/** What the read by pages has answered for one employee and day. */
interface PagedRead {
  readonly key: string;
  readonly figures: AgentMetrics | Error;
}

/**
 * One employee's figures for its page (C1; wave 18, 18-F): the subscribed read
 * (`metrics:forAgent`) through `useQueries`, so a refused read comes back as a value and the page
 * draws without its figures; and, for an employee whose records pass what that read holds (it
 * refuses in {@link FIGURES_READ_BY_PAGES}'s words), the same figures read by pages
 * (`metrics:forAgentByPages`), read again every {@link EMPLOYEE_FIGURES_REREAD_MS} while the page
 * stays open, one read at a time.
 *
 * @param agentId - The employee, or undefined while the page has none to read.
 * @param day - The employee's own today, for the rail's day figures.
 * @returns The figures, undefined while they are on their way, or the `Error` the read failed with.
 */
export function useEmployeeFigures(
  agentId: Id<'agents'> | undefined,
  day?: string,
): AgentMetrics | undefined | Error {
  const query = useMemo(
    (): RequestForQueries =>
      agentId === undefined
        ? {}
        : {
            figures: {
              query: api.metrics.forAgent,
              args: day === undefined ? { agentId } : { agentId, day },
            },
          },
    [agentId, day],
  );
  const { figures }: Record<string, AgentMetrics | undefined | Error> = useQueries(query);
  const readEvery = useAction(api.metrics.forAgentByPages);
  const past = readByPages(figures);
  const key = `${agentId ?? ''}\0${day ?? ''}`;
  const [paged, setPaged] = useState<PagedRead | undefined>(undefined);
  const running = useRef(false);

  useEffect(() => {
    if (!past || agentId === undefined) return;
    let live = true;
    const read = (): void => {
      if (running.current) return;
      running.current = true;
      // Not awaited: an effect and a timer return nothing. Both outcomes are drawn: the figures,
      // or the refusal as the page's figures that could not be read.
      void Promise.resolve()
        .then(async () => await readEvery(day === undefined ? { agentId } : { agentId, day }))
        .then(
          (answer): void => {
            if (live) setPaged({ key, figures: answer });
          },
          (error: unknown): void => {
            if (live) {
              setPaged({
                key,
                figures: error instanceof Error ? error : new Error('the figures were not read'),
              });
            }
          },
        )
        .finally((): void => {
          running.current = false;
        });
    };
    read();
    const again = setInterval(read, EMPLOYEE_FIGURES_REREAD_MS);
    return (): void => {
      live = false;
      clearInterval(again);
    };
  }, [past, agentId, day, key, readEvery]);

  if (!past) return figures;
  return paged?.key === key ? paged.figures : undefined;
}
