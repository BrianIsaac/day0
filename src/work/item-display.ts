import type { Doc } from '../../convex/_generated/dataModel';
import type { ManagerFeedback } from './manager-feedback';
import { MANAGER_REJECTION_PREFIX } from './needs-manager';
import { replyTargetFor } from './reply-target';
import type { TicketSnapshot } from './ticket-ownership';
import { OUT_OF_SCOPE_SKIP_PREFIX, QUALITY_FIT_SKIP_PREFIX } from './types';

/**
 * The work item card's sentences read off the row, in the manager's words (round two section
 * 3.7): where the item came from, why it was skipped, which part of a run is under way, and
 * what the manager's own last word on it was. Pure, so the card and its tests read one source.
 */

/**
 * Who asked for the work and where, for the line under the item's title: `Sara, in #revops-asks`,
 * `Aman, on REVOPS-30`, or whichever half the row knows.
 *
 * @param item - The row's requester, source and reply target.
 * @returns The line, or undefined when the row names neither.
 */
export function sourceLine(
  item: Pick<
    Doc<'workItems'>,
    'requesterLabel' | 'replyTarget' | 'sourceCategory' | 'externalId' | 'title'
  >,
): string | undefined {
  const who = item.requesterLabel?.trim() || undefined;
  const channel = replyTargetFor(item)?.channelName;
  const where = channel
    ? `in #${channel}`
    : item.sourceCategory === 'ticket-queue'
      ? `on ${item.externalId}`
      : undefined;
  if (who && where) return `${who}, ${where}`;
  if (who) return who;
  return where ? `${where.charAt(0).toUpperCase()}${where.slice(1)}` : undefined;
}

/**
 * Why the employee set an item aside, as a sentence: the scope judgement's reading (which cites
 * the charter clause it read) without its machine prefix, the quality-fit judgement said as
 * such, and any other reason as the row keeps it.
 *
 * @param reason - The skip verdict's reason.
 */
export function skipSentence(reason: string): string {
  if (reason.startsWith(OUT_OF_SCOPE_SKIP_PREFIX)) {
    return sentence(reason.slice(OUT_OF_SCOPE_SKIP_PREFIX.length));
  }
  if (reason.startsWith(QUALITY_FIT_SKIP_PREFIX)) {
    return `Judged not worth doing as it stands: ${sentence(reason.slice(QUALITY_FIT_SKIP_PREFIX.length))}`;
  }
  return sentence(reason);
}

/** A reason as a sentence: its first letter up, a full stop at the end when it has none. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return trimmed;
  const capital = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  return /[.!?”"]$/.test(capital) ? capital : `${capital}.`;
}

/** Which part of a run is under way, as far as the row knows it: the card's progress. */
export interface RunProgress {
  /** The part under way, a short heading. */
  readonly title: string;
  /** Where that part stands, one sentence. */
  readonly detail: string;
  /** The parts in order, the one under way marked. */
  readonly parts: ReadonlyArray<{
    readonly name: string;
    readonly status: 'done' | 'now' | 'next';
  }>;
}

/**
 * How far a working item has got, from what the row records while it runs: the plan being
 * drafted, the run started, its reads and draft, its automatic writes, and for a run in two
 * phases its closing phase. A run records its steps' outcomes only when it finishes, so the
 * progress is by part, never a made-up step count.
 *
 * @param item - A row in `claimed`, `plan-approved` or `executing`.
 * @param autonomous - Whether autonomous actions are on, for how automatic writes are named.
 * @returns The progress, or undefined for a row in any other state.
 */
export function runProgress(
  item: Pick<Doc<'workItems'>, 'state' | 'plan' | 'applyPhase' | 'approvedIndexes' | 'output'>,
  autonomous: boolean,
): RunProgress | undefined {
  if (item.state === 'claimed') {
    return {
      title: 'Drafting a plan',
      detail: 'The plan comes to you before anything runs.',
      parts: [
        { name: 'Plan', status: 'now' },
        { name: 'Your approval', status: 'next' },
        { name: 'Run', status: 'next' },
      ],
    };
  }
  if (item.state !== 'plan-approved' && item.state !== 'executing') return undefined;
  const twoPhase = (item.output as { initial?: unknown } | undefined)?.initial !== undefined;
  const applying = item.state === 'executing' && item.applyPhase === 'auto';
  const count = item.approvedIndexes?.length ?? 0;
  const writes = `${count} ${count === 1 ? 'action' : 'actions'}`;
  const phase: RunProgress['title'] =
    item.state === 'plan-approved'
      ? 'Starting the approved plan'
      : applying
        ? `Applying ${writes} ${autonomous ? 'autonomously' : 'automatically'}`
        : twoPhase
          ? 'Writing the closing actions from what landed'
          : 'Reading and drafting';
  // The parts a run passes through that the row can tell apart; what it
  // holds for the manager at the end is the detail's to say.
  const order = twoPhase
    ? ['Prerequisites', 'Closing actions']
    : ['Read and draft', 'Automatic writes'];
  const current = item.state === 'plan-approved' ? -1 : twoPhase || applying ? 1 : 0;
  return {
    title: phase,
    detail: autonomous
      ? 'Nothing reaches a surface until the run finishes; then the writes the gate allows apply, and any it holds wait for you.'
      : 'Nothing reaches a surface until the run finishes; then every write it produces is held for you.',
    parts: order.map((name, index) => ({
      name,
      status: index < current ? 'done' : index === current ? 'now' : 'next',
    })),
  };
}

/**
 * The manager's rejection of a run, when the item stands failed on it: the reason and when it
 * was given.
 *
 * @param item - The row's state, stop reason and feedback.
 * @returns The reason (empty when none was written) and the instant, or undefined.
 */
export function rejectionOf(
  item: Pick<Doc<'workItems'>, 'state' | 'skipReason' | 'managerFeedback'>,
): { readonly reason: string; readonly at?: number } | undefined {
  if (item.state !== 'failed' || item.skipReason?.startsWith(MANAGER_REJECTION_PREFIX) !== true) {
    return undefined;
  }
  const feedback = item.managerFeedback;
  if (feedback && (feedback.kind === undefined || feedback.kind === 'rejection')) {
    return { reason: feedback.reason, at: feedback.at };
  }
  return { reason: '' };
}

/**
 * What a plan waiting again, or a run under way again, is working from: a plan redrafted after
 * the manager cancelled one (with the reason or the Retry note it was drafted from, when one is
 * still live), or a run going again after a Retry or a rejection with the manager's note.
 *
 * @param item - The row's state, feedback and plan-rejection stamp.
 * @returns What the card says the item is working from, or undefined.
 */
export function workingFrom(
  item: Pick<Doc<'workItems'>, 'state' | 'managerFeedback' | 'planRejectedAt'>,
):
  | { readonly kind: 'redraft'; readonly feedback?: ManagerFeedback }
  | { readonly kind: 'rerun'; readonly feedback: ManagerFeedback }
  | undefined {
  const raw = item.managerFeedback;
  const feedback =
    raw && raw.addressedAt === undefined && raw.reason.trim() !== '' ? raw : undefined;
  if (item.state === 'plan-pending') {
    if (item.planRejectedAt === undefined) return undefined;
    // A cancelled plan's reason, or the note given with its Retry, is what
    // the redraft was written from; a rejection of held writes is not.
    return feedback && feedback.kind !== 'rejection'
      ? { kind: 'redraft', feedback }
      : { kind: 'redraft' };
  }
  const running = ['claimed', 'plan-approved', 'executing', 'actions-pending'];
  return feedback && running.includes(item.state) ? { kind: 'rerun', feedback } : undefined;
}

/**
 * Where a ticket stands as intake last listed it (K D3): its state, who holds it and whether it
 * is marked not to be automated, so a retry after the ticket moved is an informed one. The
 * assignee is named by id, as the export names it.
 *
 * @param tracker - The listing's snapshot, without the assignee's address.
 * @param refused - Why intake refused the ticket on that listing, when it did.
 * @returns One sentence, without the listing's time.
 */
export function ticketNowSentence(
  tracker: Omit<TicketSnapshot, 'assigneeEmail'>,
  refused?: string,
): string {
  const state = tracker.state ? `in ${tracker.state}` : 'in a state the tracker did not name';
  const holder = tracker.assigneeId
    ? `assigned to ${tracker.assigneeId}`
    : tracker.assigned
      ? 'assigned to someone the tracker did not identify'
      : 'unassigned';
  const marked = tracker.doNotAutomate ? ', marked not to be automated' : '';
  const refusal = refused ? ` Intake refused it on that listing: ${sentence(refused)}` : '';
  return `The ticket is ${state}, ${holder}${marked}.${refusal}`;
}
