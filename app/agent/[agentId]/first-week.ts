import type { Doc } from '@convex/_generated/dataModel';
import type { OneToOnePhase } from '@/agent/one-to-one-phase';
import type { EmployeeState } from '@/work/state-labels';
import type { RailStep } from '../../components/FirstWeekRail';
import { clockTime } from '../../components/time';

/** What the first week's steps are read from. */
export interface FirstWeekFacts {
  readonly deployedAt: number;
  /** The state the page shows (`shownEmployeeState`). */
  readonly state: EmployeeState;
  /** Where the one-to-one stands (`oneToOnePhase`): drafting once the transcript is taken for a charter. */
  readonly phase?: OneToOnePhase['kind'];
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
  // A one-to-one whose transcript is being drafted is over: the charter step is the one under way.
  const drafting = facts.state === 'day-one-in-progress' && facts.phase === 'drafting';
  const talked = facts.state === 'charter-pending' || facts.state === 'active' || drafting;
  const approved = facts.state === 'active';
  // A write can only have landed under an approved charter; before one, the figures say nothing.
  const landed = approved && facts.writeLanded;
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
        ? facts.charter
          ? `version ${facts.charter.version}`
          : 'approved'
        : drafting
          ? 'being drafted'
          : talked
            ? 'waiting for your review'
            : 'after the one-to-one',
      status: approved ? 'done' : talked ? 'now' : 'next',
    },
    {
      title: 'First supervised write',
      detail: landed
        ? 'landed'
        : !approved
          ? 'after approval'
          : facts.writeHeld
            ? 'held for you'
            : 'after the first plan',
      status: landed ? 'done' : approved ? 'now' : 'next',
    },
    {
      title: 'Working',
      detail: landed ? 'in the queue' : '',
      status: landed ? 'now' : 'next',
    },
  ];
}

/** Where the first week stands, as the index of its current step. */
export function currentStep(steps: readonly RailStep[]): number {
  return steps.findIndex((step) => step.status === 'now');
}
