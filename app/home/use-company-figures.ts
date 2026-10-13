'use client';

import { useEffect, useRef, useState } from 'react';
import { useAction, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { log } from '@/lib/logger';
import type { OwnerMetrics } from '@/metrics/types';
import type { CompanyCoverage } from './company-coverage';

/** How long the home waits after the first change it has not read before it reads every employee again. */
export const WHOLE_COMPANY_REREAD_MS = 2_000;

/** The company's figures as the home draws them, and which employees they cover. */
export interface CompanyFigures {
  /** The figures to draw, or undefined while nothing has been read. */
  readonly figures: OwnerMetrics | undefined;
  readonly coverage: CompanyCoverage;
}

/** What the reads by pages are doing, kept outside the render: a read answers after it returns. */
interface ReadsByPages {
  /** Whether the page is still there to draw an answer. */
  mounted: boolean;
  /** Whether the first read has been asked for. */
  started: boolean;
  /** Whether a read is on its way: there is never a second beside it. */
  running: boolean;
  /** Whether something changed that the read on its way may not have seen. */
  again: boolean;
  /** The wait before the next read, from the first change not yet read. */
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The company's figures for the home (wave 17, 17-F; RM33 (a), F-2). The subscribed read
 * (`metrics:forOwner`) is bounded and answers at once; where it says it left employees out, every
 * employee is read by pages (`metrics:forOwnerByPages`) and those figures take its place. Until
 * they arrive the bounded ones are drawn, and said to be so.
 *
 * The read by pages is no subscription: it is made again when the subscribed read or `changes`
 * moves, `WHOLE_COMPANY_REREAD_MS` after the first change it has not read, however many follow,
 * so a company at work is read again every so often and never left waiting for a quiet moment.
 * One read is on its way at a time, each answer is drawn when it comes, and the figures last
 * answered stay drawn meanwhile.
 *
 * @param changes - Anything whose change means an employee's records may have moved: the home
 *   passes its roster, which is subscribed for every employee.
 */
export function useCompanyFigures(changes: unknown): CompanyFigures {
  const bounded = useQuery(api.metrics.forOwner);
  const readEvery = useAction(api.metrics.forOwnerByPages);
  const [every, setEvery] = useState<OwnerMetrics | 'failed' | undefined>(undefined);
  const reads = useRef<ReadsByPages>({
    mounted: true,
    started: false,
    running: false,
    again: false,
    timer: undefined,
  });
  const past = bounded !== undefined && bounded.omittedEmployees > 0;

  useEffect(() => {
    const at = reads.current;
    at.mounted = true;
    return (): void => {
      at.mounted = false;
      clearTimeout(at.timer);
      at.timer = undefined;
    };
  }, []);

  useEffect(() => {
    if (!past) return;
    const at = reads.current;
    const read = (): void => {
      at.timer = undefined;
      if (at.running) {
        // The read on its way may have passed the row that changed: one more once it is back.
        at.again = true;
        return;
      }
      at.running = true;
      // Not awaited: an effect and a timer return nothing. Both outcomes are handled here, a
      // refusal as the figures of the most recent employees with the count of the rest.
      void readEvery({})
        .then(
          (figures): void => {
            if (at.mounted) setEvery(figures);
          },
          (error: unknown): void => {
            log.warn('the company figures could not be read by pages', {
              reason: error instanceof Error ? error.message : 'unknown',
            });
            // Figures already read stay drawn; with none, the bounded ones say what they cover.
            if (at.mounted) setEvery((kept) => kept ?? 'failed');
          },
        )
        .finally((): void => {
          at.running = false;
          if (at.mounted && at.again) {
            at.again = false;
            read();
          }
        });
    };
    if (!at.started) {
      at.started = true;
      read();
      return;
    }
    at.timer ??= setTimeout(read, WHOLE_COMPANY_REREAD_MS);
  }, [past, bounded, changes, readEvery]);

  if (bounded === undefined) return { figures: undefined, coverage: { kind: 'all' } };
  if (!past) return { figures: bounded, coverage: { kind: 'all' } };
  const read = bounded.company.employees;
  const of = read + bounded.omittedEmployees;
  if (every === undefined) return { figures: bounded, coverage: { kind: 'reading', read, of } };
  if (every === 'failed') return { figures: bounded, coverage: { kind: 'recent', read, of } };
  return { figures: every, coverage: { kind: 'every', employees: every.company.employees } };
}
