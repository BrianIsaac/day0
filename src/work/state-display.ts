import { MANAGER_REJECTION_PREFIX } from './needs-manager';
import { type StateLabel, type WorkItemState, workItemStateLabel } from './state-labels';

/**
 * The Work tab's reading of a work item's state: which of its filters the item falls under, and
 * the glossary that pairs each chip's words with the stored state (round two section 5: "the
 * manager's words with the enum in the Work tab's glossary and in the export").
 */

/** The filters the Work tab offers, in order (`agent-work.html`). */
export const QUEUE_FILTERS = ['all', 'needs-you', 'in-progress', 'done', 'skipped'] as const;

/** One of the Work tab's filters. */
export type QueueFilter = (typeof QUEUE_FILTERS)[number];

/** Each filter's name on its control. */
export const QUEUE_FILTER_NAMES: Readonly<Record<QueueFilter, string>> = {
  all: 'All',
  'needs-you': 'Needs you',
  'in-progress': 'In progress',
  done: 'Done',
  skipped: 'Skipped',
};

/**
 * Which filter an item falls under besides All. Needs you is the inbox's own rule: an item the
 * needs-you read lists, or a plan or a held set, which always wait on the manager (so the filter
 * holds while that read loads); a parked or
 * skill-bound item the inbox does not list is waiting on something else and is in progress; a
 * stopped item the inbox does not list waits on nobody and is done.
 *
 * @param item - The item's id and state.
 * @param needsYou - The ids of the items the employee's needs-you inbox lists.
 */
export function queueFilterOf(
  item: { readonly _id: string; readonly state: WorkItemState },
  needsYou: ReadonlySet<string>,
): Exclude<QueueFilter, 'all'> {
  if (needsYou.has(item._id)) return 'needs-you';
  switch (item.state) {
    case 'plan-pending':
    case 'actions-pending':
      return 'needs-you';
    case 'discovered':
    case 'claimed':
    case 'plan-approved':
    case 'executing':
    case 'deferred':
    case 'needs-skill':
      return 'in-progress';
    case 'completed':
    case 'failed':
    case 'cancelled':
      return 'done';
    case 'skipped':
      return 'skipped';
  }
}

/** One line of the glossary: the chip's words and tone, what they mean, and the stored state. */
export interface GlossaryLine {
  readonly label: StateLabel;
  readonly means: string;
  readonly state: WorkItemState;
}

/** What each stored state means, in the manager's words; `failed` is read in two ways below. */
const MEANS: Readonly<Record<Exclude<WorkItemState, 'failed'>, string>> = {
  discovered: 'found in a connected system, not yet judged against the charter',
  claimed: 'judged part of the job; a plan is being drafted',
  'plan-pending': 'a plan drafted, waiting on you',
  'plan-approved': 'you approved the plan; the run is starting',
  executing: 'running the approved plan',
  'actions-pending': 'the exact writes, held until you decide',
  'needs-skill': 'waiting on a skill you approve',
  deferred: 'parked until a system is connected, a grant is given or the charter is approved',
  completed: 'the approved writes reached the work environment',
  skipped: 'set aside with the reason; you can give it back',
  cancelled: 'you cancelled its plan or its skill; nothing runs',
};

/** The glossary's order: the way an item moves, then the ways it stops. */
const ORDER: readonly Exclude<WorkItemState, 'failed'>[] = [
  'discovered',
  'claimed',
  'plan-pending',
  'plan-approved',
  'executing',
  'actions-pending',
  'completed',
  'needs-skill',
  'deferred',
  'skipped',
  'cancelled',
];

/**
 * Every state an item can be shown in, in the manager's words beside the stored state, for the
 * Work tab's glossary. The words are `workItemStateLabel`'s, so the glossary and the chips never
 * disagree; a failed item is listed twice, as the chip reads it.
 */
export function workItemGlossary(): GlossaryLine[] {
  const lines = ORDER.map(
    (state): GlossaryLine => ({ label: workItemStateLabel({ state }), means: MEANS[state], state }),
  );
  const rejected: GlossaryLine = {
    label: workItemStateLabel({ state: 'failed', skipReason: MANAGER_REJECTION_PREFIX }),
    means: 'you rejected the run; nothing held was sent',
    state: 'failed',
  };
  const stopped: GlossaryLine = {
    label: workItemStateLabel({ state: 'failed' }),
    means: 'ended short of done; the card says why and what Retry does',
    state: 'failed',
  };
  const landed = lines.findIndex((line) => line.state === 'completed');
  return [...lines.slice(0, landed + 1), rejected, stopped, ...lines.slice(landed + 1)];
}
