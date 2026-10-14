'use client';

import { useEffect, useRef, useState } from 'react';
import { useAction, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { log } from '@/lib/logger';
import type { OwnerMetrics } from '@/metrics/types';
import type { CompanyCoverage } from './company-coverage';

/** How long the home waits after the first change it has not read before it reads every employee again. */
export const WHOLE_COMPANY_REREAD_MS = 2_000;

/**
 * How long after a read of every employee fails before it is tried again with nothing changed;
 * the wait doubles at each failure in a row, up to {@link WHOLE_COMPANY_RETRY_MAX_MS}.
 */
export const WHOLE_COMPANY_RETRY_MS = 30_000;

/** The longest the home waits before it tries a failed read again. */
const WHOLE_COMPANY_RETRY_MAX_MS = 8 * 60_000;

/**
 * How many times a failed read is tried again by itself before the home stops and says so
 * (W17-R28): a change still reads, but a company where the read keeps failing is not read every
 * few minutes for as long as the page is open.
 */
export const WHOLE_COMPANY_RETRIES = 3;

/**
 * The least time between the end of one read of every employee and the start of the next (W17-R28):
 * under constant change the reads followed one another with no rest, each a walk of every
 * employee's records.
 */
export const WHOLE_COMPANY_COOL_DOWN_MS = 10_000;

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
  /** Whether the subscribed read leaves employees out, so they are wanted by pages. */
  wanted: boolean;
  /** Whether the first read since they were wanted has been asked for. */
  started: boolean;
  /** Whether a read is on its way: there is never a second beside it. */
  running: boolean;
  /** Whether something changed that the read on its way may not have seen. */
  again: boolean;
  /** When the last read ended, which the next waits a cool-down after. */
  endedAt: number | undefined;
  /** The wait before the next read, from the first change not yet read. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The wait before a failed read is tried again with nothing changed. */
  retry: ReturnType<typeof setTimeout> | undefined;
  /** How many reads have failed in a row. */
  failures: number;
  /**
   * How many times the employees stopped being wanted by pages: a read that began before the
   * company was back within the bound answers for a company that is gone (the second pass).
   */
  generation: number;
}

/** Drop both waits: a read is starting, or the page has no more use for one. */
function dropWaits(at: ReadsByPages): void {
  clearTimeout(at.timer);
  clearTimeout(at.retry);
  at.timer = undefined;
  at.retry = undefined;
}

/** How long is left of the cool-down after the last read, or nothing. */
function coolDownLeft(at: ReadsByPages): number {
  return at.endedAt === undefined
    ? 0
    : Math.max(0, at.endedAt + WHOLE_COMPANY_COOL_DOWN_MS - Date.now());
}

/** What the read by pages has answered since the employees were last wanted by pages. */
type EveryRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'read'; readonly figures: OwnerMetrics }
  | { readonly kind: 'failed'; readonly tries: number };

/**
 * The company's figures for the home (wave 17, 17-F; RM33 (a), F-2). The subscribed read
 * (`metrics:forOwner`) is bounded and answers at once; where it says it left employees out, every
 * employee is read by pages (`metrics:forOwnerByPages`) and those figures take its place. Until
 * they arrive the bounded ones are drawn, and said to be so.
 *
 * The read by pages is no subscription: it is made again when the subscribed read or `changes`
 * moves, `WHOLE_COMPANY_REREAD_MS` after the first change it has not read, however many follow,
 * and never sooner than `WHOLE_COMPANY_COOL_DOWN_MS` after the last read ended (W17-R28), so a
 * company at work is read again every so often, never left waiting for a quiet moment, and never
 * walked back to back. One read is on its way at a time, each answer is drawn when it comes, and
 * the figures last answered stay drawn meanwhile. A read that fails is tried again by itself,
 * `WHOLE_COMPANY_RETRY_MS` later and twice as long after each further failure, at most
 * `WHOLE_COMPANY_RETRIES` times, and then the figures say the rest could not be read until a change
 * reads them again. Once the subscribed read covers the company again nothing more is asked for,
 * and what was read by pages is let go, so a company that grows back past twenty is not drawn
 * from figures read before it shrank. Nothing is asked for once the page is gone.
 *
 * @param changes - Anything whose change means an employee's records may have moved: the home
 *   passes its roster, which is subscribed for every employee.
 */
export function useCompanyFigures(changes: unknown): CompanyFigures {
  const bounded = useQuery(api.metrics.forOwner);
  const readEvery = useAction(api.metrics.forOwnerByPages);
  const [every, setEvery] = useState<EveryRead>({ kind: 'none' });
  const reads = useRef<ReadsByPages>({
    mounted: true,
    wanted: false,
    started: false,
    running: false,
    again: false,
    endedAt: undefined,
    timer: undefined,
    retry: undefined,
    failures: 0,
    generation: 0,
  });
  const past = bounded !== undefined && bounded.omittedEmployees > 0;
  // What was read by pages is the company's while it stays past the bound: once the bounded read
  // covers it again, the answer is let go (state derived while rendering).
  const [wasPast, setWasPast] = useState(past);
  if (wasPast !== past) {
    setWasPast(past);
    if (!past) setEvery({ kind: 'none' });
  }

  useEffect(() => {
    const at = reads.current;
    at.mounted = true;
    return (): void => {
      at.mounted = false;
      dropWaits(at);
    };
  }, []);

  useEffect(() => {
    const at = reads.current;
    at.wanted = past;
    if (!past) {
      // The bounded read covers the company again: nothing waits to be read by pages, and the
      // next time the company passes the bound starts afresh.
      dropWaits(at);
      at.started = false;
      at.again = false;
      at.failures = 0;
      at.generation += 1;
      return;
    }
    const read = (): void => {
      // A read that starts now follows every change so far: the waits set for them are dropped.
      dropWaits(at);
      if (!at.mounted || !at.wanted) return;
      if (at.running) {
        // The read on its way may have passed the row that changed: one more once it is back.
        at.again = true;
        return;
      }
      const resting = coolDownLeft(at);
      if (resting > 0) {
        // A wait set while the last read was on its way ends inside its cool-down: wait it out.
        at.timer = setTimeout(read, resting);
        return;
      }
      at.running = true;
      const generation = at.generation;
      const current = (): boolean => at.mounted && at.wanted && at.generation === generation;
      // Not awaited: an effect and a timer return nothing. Both outcomes are handled here, a
      // refusal as the figures of the most recent employees with the count of the rest; the call
      // is made inside the chain, so one that throws before it answers is a refusal like any other.
      void Promise.resolve()
        .then(async () => await readEvery({}))
        .then(
          (figures): void => {
            // An answer for a company since back within the bound is not kept, nor counted.
            if (!current()) return;
            at.failures = 0;
            setEvery({ kind: 'read', figures });
          },
          (error: unknown): void => {
            if (!current()) return;
            at.failures += 1;
            log.warn('the company figures could not be read by pages', {
              reason: error instanceof Error ? error.message : 'unknown',
            });
            // Figures already read stay drawn; with none, the bounded ones say what they cover.
            const tries = at.failures;
            setEvery((kept) => (kept.kind === 'read' ? kept : { kind: 'failed', tries }));
          },
        )
        .finally((): void => {
          at.running = false;
          at.endedAt = Date.now();
          if (!at.mounted || !at.wanted) return;
          if (at.again) {
            at.again = false;
            at.timer ??= setTimeout(read, coolDownLeft(at));
            return;
          }
          if (at.failures > 0 && at.failures <= WHOLE_COMPANY_RETRIES) {
            at.retry = setTimeout(
              read,
              Math.max(
                coolDownLeft(at),
                Math.min(
                  WHOLE_COMPANY_RETRY_MS * 2 ** (at.failures - 1),
                  WHOLE_COMPANY_RETRY_MAX_MS,
                ),
              ),
            );
          }
        });
    };
    if (!at.started) {
      at.started = true;
      read();
      return;
    }
    at.timer ??= setTimeout(read, Math.max(WHOLE_COMPANY_REREAD_MS, coolDownLeft(at)));
  }, [past, bounded, changes, readEvery]);

  if (bounded === undefined) return { figures: undefined, coverage: { kind: 'all' } };
  if (!past) return { figures: bounded, coverage: { kind: 'all' } };
  const read = bounded.company.employees;
  const of = read + bounded.omittedEmployees;
  switch (every.kind) {
    case 'none':
      return { figures: bounded, coverage: { kind: 'reading', read, of } };
    case 'failed':
      return {
        figures: bounded,
        coverage:
          every.tries > WHOLE_COMPANY_RETRIES
            ? { kind: 'stopped', read, of, tries: every.tries }
            : { kind: 'recent', read, of },
      };
    case 'read':
      return {
        figures: every.figures,
        coverage: { kind: 'every', employees: every.figures.company.employees },
      };
    default: {
      const unknown: never = every;
      throw new Error(`unhandled read ${String(unknown)}`);
    }
  }
}
