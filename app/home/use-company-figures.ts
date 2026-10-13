'use client';

import { useEffect, useRef, useState } from 'react';
import { useAction, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { log } from '@/lib/logger';
import type { OwnerMetrics } from '@/metrics/types';
import type { CompanyCoverage } from './company-coverage';

/** How long the home waits after a change before it reads every employee again. */
export const WHOLE_COMPANY_REREAD_MS = 2_000;

/** The company's figures as the home draws them, and which employees they cover. */
export interface CompanyFigures {
  /** The figures to draw, or undefined while nothing has been read. */
  readonly figures: OwnerMetrics | undefined;
  readonly coverage: CompanyCoverage;
}

/**
 * The company's figures for the home (wave 17, 17-F; RM33 (a), F-2). The subscribed read
 * (`metrics:forOwner`) is bounded and answers at once; where it says it left employees out, every
 * employee is read by pages (`metrics:forOwnerByPages`) and those figures take its place. Until
 * they arrive the bounded ones are drawn, and said to be so.
 *
 * The read by pages is no subscription: it is made again, a moment after the last change, when
 * the subscribed read or `changes` moves, and the figures it last answered stay drawn meanwhile.
 *
 * @param changes - Anything whose change means an employee's records may have moved: the home
 *   passes its roster, which is subscribed for every employee.
 */
export function useCompanyFigures(changes: unknown): CompanyFigures {
  const bounded = useQuery(api.metrics.forOwner);
  const readEvery = useAction(api.metrics.forOwnerByPages);
  const [every, setEvery] = useState<OwnerMetrics | 'failed' | undefined>(undefined);
  const first = useRef(true);
  const past = bounded !== undefined && bounded.omittedEmployees > 0;

  useEffect(() => {
    if (!past) return undefined;
    let current = true;
    const wait = first.current ? 0 : WHOLE_COMPANY_REREAD_MS;
    first.current = false;
    const timer = setTimeout((): void => {
      // Not awaited: a timer's callback returns nothing. Both outcomes are handled here, a
      // refusal as the figures of the most recent employees with the count of the rest.
      void readEvery({}).then(
        (figures): void => {
          if (current) setEvery(figures);
        },
        (error: unknown): void => {
          log.warn('the company figures could not be read by pages', {
            reason: error instanceof Error ? error.message : 'unknown',
          });
          // Figures already read stay drawn; with none, the bounded ones say what they cover.
          if (current) setEvery((kept) => kept ?? 'failed');
        },
      );
    }, wait);
    return (): void => {
      current = false;
      clearTimeout(timer);
    };
  }, [past, bounded, changes, readEvery]);

  if (bounded === undefined) return { figures: undefined, coverage: { kind: 'all' } };
  if (!past) return { figures: bounded, coverage: { kind: 'all' } };
  const read = bounded.company.employees;
  const of = read + bounded.omittedEmployees;
  if (every === undefined) return { figures: bounded, coverage: { kind: 'reading', read, of } };
  if (every === 'failed') return { figures: bounded, coverage: { kind: 'recent', read, of } };
  return { figures: every, coverage: { kind: 'every', employees: every.company.employees } };
}
