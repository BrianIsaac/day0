import type { Doc } from '../../convex/_generated/dataModel';
import type { OneToOnePhase } from '../agent/one-to-one-phase';
import { autonomyLabel } from './autonomy';
import { MANAGER_REJECTION_PREFIX } from './needs-manager';

/** Where an employee is in its first week, as the agent row stores it. */
export type EmployeeState = Doc<'agents'>['state'];

/** Where a work item is, as its row stores it. */
export type WorkItemState = Doc<'workItems'>['state'];

/**
 * The hue a state is drawn in: warn for what waits on the manager, accent for what is under way,
 * ok for what is done, muted for what waits on nobody. No state is drawn in danger: a refusal is
 * the manager's own decision, never a failure shouted in red (round two section 5).
 */
export type StateTone = 'accent' | 'warn' | 'ok' | 'muted';

/** A state in the manager's words, and the hue it is drawn in. */
export interface StateLabel {
  readonly text: string;
  readonly tone: StateTone;
}

/** The newest charter's standing as the shown state reads it, or null before one is drafted. */
export type CharterApproval = Readonly<Pick<Doc<'charters'>, 'approved'>> | null;

/**
 * The state the page shows for an employee: its charter, when the page has one, outranks the
 * row. A drafted charter ends the one-to-one whatever the row still says, and an approved one
 * makes the employee active, so a pill reading "In your one-to-one" never sits above a charter.
 * An active employee stays active while a newer draft waits for review: the approved charter
 * it works under stays in force until the draft is approved.
 *
 * @param state - The agent row's state.
 * @param charter - The newest charter, or null before one is drafted.
 */
export function shownEmployeeState(state: EmployeeState, charter: CharterApproval): EmployeeState {
  if (charter === null || state === 'active') return state;
  return charter.approved ? 'active' : 'charter-pending';
}

/**
 * An employee's state in the manager's words, the one set every surface prints: the roster's
 * chip, the face's hover title and the pill beside the name. An employee in its one-to-one whose
 * transcript is being drafted into a charter (after the last answer, or a draft sent back with a
 * note) says so where the surface knows it: the conversation is over and nothing waits on the
 * manager.
 *
 * @param state - The state the page shows (`shownEmployeeState`).
 * @param phase - Where the one-to-one stands (`oneToOnePhase`), when the surface has read it.
 */
export function employeeStateWords(
  state: EmployeeState,
  phase?: OneToOnePhase['kind'],
): StateLabel {
  switch (state) {
    case 'deployed':
      return { text: 'Waiting for your one-to-one', tone: 'warn' };
    case 'day-one-in-progress':
      return phase === 'drafting'
        ? { text: 'Drafting the charter', tone: 'accent' }
        : { text: 'In your one-to-one', tone: 'accent' };
    case 'charter-pending':
      return { text: 'Charter to review', tone: 'warn' };
    case 'active':
      return { text: 'Active', tone: 'ok' };
  }
}

/** How many employees stand at one state, in the words the roster's chip prints for it. */
export interface StateCount {
  readonly text: string;
  readonly count: number;
}

/** The states a tally lists, in the order the company line reads them: the working ones first. */
const TALLY_ORDER: readonly string[] = [
  employeeStateWords('active'),
  employeeStateWords('day-one-in-progress'),
  employeeStateWords('day-one-in-progress', 'drafting'),
  employeeStateWords('deployed'),
  employeeStateWords('charter-pending'),
].map((words) => words.text);

/**
 * How many employees stand at each state, by the words their roster chips print
 * (`employeeStateWords`), so a line that counts the company and the roster it heads never
 * disagree (the production walk's 6d: "0 active" over an employee drawn in its one-to-one). A
 * state nobody is at is left out.
 *
 * @param employees - The roster's rows: the state each shows, and where its one-to-one stands.
 */
export function employeeStateTally(
  employees: ReadonlyArray<{
    readonly state: EmployeeState;
    readonly phase?: OneToOnePhase['kind'];
  }>,
): StateCount[] {
  const counts = new Map<string, number>();
  for (const { state, phase } of employees) {
    const { text } = employeeStateWords(state, phase);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return TALLY_ORDER.flatMap((text) => {
    const count = counts.get(text);
    return count === undefined ? [] : [{ text, count }];
  });
}

/**
 * An employee's state for the pill beside its name: its words (`employeeStateWords`), and for an
 * active employee whether it is supervised or autonomous, which the roster gives a column of its
 * own.
 *
 * @param state - The state the page shows (`shownEmployeeState`).
 * @param autonomous - Whether autonomous actions are on; an active employee says which it is.
 * @param phase - Where the one-to-one stands (`oneToOnePhase`), when the page has read it.
 */
export function employeeStateLabel(
  state: EmployeeState,
  autonomous: boolean,
  phase?: OneToOnePhase['kind'],
): StateLabel {
  const words = employeeStateWords(state, phase);
  return state === 'active'
    ? { ...words, text: `${words.text} · ${autonomyLabel(autonomous)}` }
    : words;
}

/**
 * A work item's state in the manager's words (round two section 3.7), the enum itself kept for
 * the Work tab's glossary and the export. A failed item the manager's own rejection stopped reads
 * "Rejected by you", not as a failure.
 *
 * @param item - The item's state, and the reason it was stopped when it was.
 */
export function workItemStateLabel(
  item: Pick<Doc<'workItems'>, 'state' | 'skipReason'>,
): StateLabel {
  switch (item.state) {
    case 'discovered':
      return { text: 'Discovered', tone: 'accent' };
    case 'claimed':
    case 'executing':
      return { text: 'Working', tone: 'accent' };
    case 'plan-pending':
      return { text: 'Plan to approve', tone: 'warn' };
    case 'plan-approved':
      return { text: 'Plan approved', tone: 'accent' };
    case 'actions-pending':
      return { text: 'Write held for you', tone: 'warn' };
    case 'needs-skill':
      return { text: 'Waiting on a skill', tone: 'warn' };
    case 'deferred':
      return { text: 'Parked', tone: 'warn' };
    case 'completed':
      return { text: 'Landed', tone: 'ok' };
    case 'failed':
      return item.skipReason?.startsWith(MANAGER_REJECTION_PREFIX) === true
        ? { text: 'Rejected by you', tone: 'muted' }
        : { text: 'Stopped', tone: 'warn' };
    case 'skipped':
      return { text: 'Skipped', tone: 'muted' };
    case 'cancelled':
      return { text: 'Cancelled', tone: 'muted' };
  }
}
