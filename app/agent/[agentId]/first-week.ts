import type { Doc } from '@convex/_generated/dataModel';
import type { EmployeeState } from '@/work/state-labels';
import type { RailStep } from '../../components/FirstWeekRail';
import { clockTime } from './time';

/** What the first week's steps are read from. */
export interface FirstWeekFacts {
  readonly deployedAt: number;
  /** The state the page shows (`shownEmployeeState`). */
  readonly state: EmployeeState;
  readonly charter: Pick<Doc<'charters'>, 'version'> | null;
  /** Whether a write has landed: approved by the manager or, with autonomy on, on its own. */
  readonly writeLanded: boolean;
  /** Whether a write is held for the manager now. */
  readonly writeHeld: boolean;
  readonly zone: string | undefined;
}

/**
 * The five steps of an employee's first week and where each stands (round two section 3.3):
 * deployed, the Day-1 one-to-one, the charter approved, the first supervised write, working.
 *
 * @param facts - What the page has read.
 */
export function firstWeekSteps(facts: FirstWeekFacts): RailStep[] {
  const talked = facts.state === 'charter-pending' || facts.state === 'active';
  const approved = facts.state === 'active';
  return [
    { title: 'Deployed', detail: clockTime(facts.deployedAt, facts.zone), status: 'done' },
    {
      title: 'Day-1 one-to-one',
      detail: talked
        ? 'done'
        : facts.state === 'day-one-in-progress'
          ? 'in progress'
          : 'not started',
      status: talked ? 'done' : 'now',
    },
    {
      title: 'Charter approved',
      detail: approved
        ? `version ${facts.charter?.version ?? '1'}`
        : talked
          ? 'waiting for your review'
          : 'after the one-to-one',
      status: approved ? 'done' : talked ? 'now' : 'next',
    },
    {
      title: 'First supervised write',
      detail: facts.writeLanded
        ? 'landed'
        : !approved
          ? 'after approval'
          : facts.writeHeld
            ? 'held for you'
            : 'after the first plan',
      status: facts.writeLanded ? 'done' : approved ? 'now' : 'next',
    },
    {
      title: 'Working',
      detail: facts.writeLanded ? 'in the queue' : '',
      status: facts.writeLanded ? 'now' : 'next',
    },
  ];
}

/** Where the first week stands, as the index of its current step. */
export function currentStep(steps: readonly RailStep[]): number {
  return steps.findIndex((step) => step.status === 'now');
}
