'use client';

import { createContext, useContext } from 'react';
import type { Doc, Id } from '@convex/_generated/dataModel';
import type { SurfaceRecord } from '@/surfaces/types';
import type { AuthoringAttempt } from './skills/authoring';

/** What became of a draft the manager sent back, as `charters.requestChanges` answered. */
export interface SentBackOutcome {
  /** The employee is redrafting from its stored transcript and the note, not reopening the talk. */
  readonly redrafting: boolean;
}

/** What the employee page's shell has read and every tab shares. */
export interface Employee {
  readonly agent: Doc<'agents'>;
  /** The newest charter, or null before one is drafted. */
  readonly charter: Doc<'charters'> | null;
  /** The deployment's mode, undefined until the backend has answered. */
  readonly surfaceMode: 'mock' | 'real' | undefined;
  /**
   * Whether the deployment's scheduled work is paused (`DAY0_CRONS_PAUSED`, an upgrade or the
   * operator's own pause), which holds every step at its claim; false until the backend answers.
   */
  readonly scheduledWorkPaused: boolean;
  /** The employee's systems (real mode only; the mock has none). */
  readonly surfaces: SurfaceRecord[];
  /**
   * Whether the page's cards are still arriving: true for the page's first moments only, so a
   * tab's cards rise in with the page and a tab change reveals at once (`useArrival`).
   */
  readonly arriving: boolean;
  /**
   * Tell the shell the manager sent this draft back, and whether the employee is redrafting it
   * from the one-to-one and the note, so that when the one-to-one returns in its place the page
   * says which and gives it focus.
   */
  readonly reportSentBack: (charterId: Id<'charters'>, outcome: SentBackOutcome) => void;
  /**
   * The last authoring run the manager started from the Skills tab, and what it came to; null
   * before one. Held by the shell, so leaving the tab while a skill is being written keeps the
   * notice that it did not finish (A D11, E D9).
   */
  readonly lastAttempt: AuthoringAttempt | null;
  /** File an authoring run's outcome, or clear it (null) as a new run starts. */
  readonly setLastAttempt: (attempt: AuthoringAttempt | null) => void;
}

/** The employee the shell has loaded; a tab renders only once it has. */
export const EmployeeContext = createContext<Employee | null>(null);

/**
 * The employee the page is about, as the shell read it.
 *
 * @throws When called outside the employee page's shell.
 */
export function useEmployee(): Employee {
  const employee = useContext(EmployeeContext);
  if (employee === null) throw new Error('useEmployee is read inside the employee page only');
  return employee;
}
