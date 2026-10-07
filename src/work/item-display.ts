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

/** A Slack user id as intake records an asker: `U` or `W`, then capitals and digits. */
const SLACK_USER_ID = /^[UW](?=[A-Z0-9]*\d)[A-Z0-9]{8,}$/;

/** A raw Slack user mention in a message's text, `<@U0BTFK6FLNL>` or `<@W0ABCDEF12|rowan>`. */
const SLACK_MENTION = /\s*<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g;

/**
 * A work item as the Work tab lists it (`work.listForAgent`): the row, and the name of the
 * confirmed person its requester resolved to (13-P's `requesterPerson`), where there is one.
 */
export type ListedWorkItem = Doc<'workItems'> & {
  /** The confirmed requester's name, read from the owner's graph when the list is read (W13V-7). */
  readonly requesterName?: string;
};

/**
 * Who asked for the work and where, for the line under the item's title: `Sara, in #revops-asks`,
 * `Aman, on REVOPS-30`, or whichever half the row knows. A confirmed requester is named in place of
 * the label intake recorded (W13V-7).
 *
 * @param item - The row's requester, source and reply target, and the confirmed requester's name.
 * @returns The line, or undefined when the row names neither.
 */
export function sourceLine(
  item: Pick<
    ListedWorkItem,
    'requesterLabel' | 'replyTarget' | 'sourceCategory' | 'externalId' | 'title' | 'requesterName'
  >,
): string | undefined {
  const label = item.requesterLabel?.trim() || undefined;
  // Slack intake records the asker by user id (`U0BTFK6FLNL`), which says nothing to a manager.
  const who =
    item.requesterName ??
    (label !== undefined && SLACK_USER_ID.test(label) ? 'A Slack member' : label);
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
 * A message's text with its raw Slack user mentions taken out, for a card to show: `<@U0C78V6LAPP>`
 * says nothing to a manager (W13V-7). Naming the person mentioned instead is wave 14's.
 *
 * @param text - The text as intake stored it.
 */
export function withoutSlackMentions(text: string): string {
  return text
    .replace(SLACK_MENTION, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
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

/** Which gate a deployment's runs pass: the real one's ladder, or the mock one that holds every action. */
export type WorkGate = 'real' | 'mock';

/**
 * What happens to a run's writes when it finishes, as the gate applies them. The real gate,
 * supervised, applies reads and messages to the manager on their own and holds every other write
 * (the wording the Deploy form and Manage give the switch); autonomous, it applies the writes it
 * allows and holds the rest. The mock gate holds every action (`reviewHeldActions`).
 *
 * @param autonomous - Whether autonomous actions are on.
 * @param gate - The deployment's gate.
 * @returns A clause, lower case, with no full stop.
 */
export function writesWhenRunFinishes(autonomous: boolean, gate: WorkGate = 'real'): string {
  if (gate === 'mock') return 'every write waits for your approval';
  return autonomous
    ? 'the writes the gate allows apply on their own, and any it holds wait for you'
    : 'reads and messages to you apply on their own, and every other write waits for your approval';
}

/** Which part of a run is under way, as far as the row knows it: the card's progress. */
export interface RunProgress {
  /** The part under way, a short heading. */
  readonly title: string;
  /** Where that part stands, one sentence. */
  readonly detail: string;
  /** The parts in order, the one under way (or the one a pause holds) marked. */
  readonly parts: ReadonlyArray<{
    readonly name: string;
    readonly status: 'done' | 'now' | 'held' | 'next';
  }>;
}

/**
 * What holds the employee's next step, in real mode (wave 12, 12-P): the manager's pause of this
 * employee, or the deployment's own pause of its scheduled work (`DAY0_CRONS_PAUSED`). Either
 * holds a step at its claim; the employee's own is named first, as `stepHoldReason` names it.
 */
export type RunHold =
  | { readonly by: 'employee'; readonly employeeName: string }
  | { readonly by: 'deployment' };

/**
 * The hold the Work tab's cards say, or undefined while nothing holds a step. Real mode only: a
 * pause is refused in mock mode, where the page drives every step.
 *
 * @param input - Whether the deployment serves the real loop, the employee's name and pause, and
 *   whether the deployment's scheduled work is paused.
 */
export function runHoldOf(input: {
  readonly real: boolean;
  readonly employeeName: string;
  readonly employeePaused: boolean;
  readonly scheduledWorkPaused: boolean;
}): RunHold | undefined {
  if (!input.real) return undefined;
  if (input.employeePaused) return { by: 'employee', employeeName: input.employeeName };
  return input.scheduledWorkPaused ? { by: 'deployment' } : undefined;
}

/**
 * Whether the row's next step is one a pause holds: a step not yet claimed, which a pause
 * refuses at its claim (`stepMayRun`). A draft not yet claimed, a plan approved and not started,
 * and an apply (automatic, or approved by the manager) not yet claimed each wait there. A step
 * already past its claim runs to its next gate and is under way whatever the pause says: a draft
 * holding `draftClaimedAt`, a run reading and drafting, an apply holding `applyAttemptId`. A draft
 * that died holding its claim reads as under way too until the sweep, which the pause also holds,
 * finds its lease spent: the card reads no clock for it.
 *
 * @param item - The row's state and claim fields.
 */
export function waitsAtClaim(
  item: Pick<
    Doc<'workItems'>,
    'state' | 'draftClaimedAt' | 'applyPhase' | 'applyAttemptId' | 'approvedIndexes'
  >,
): boolean {
  switch (item.state) {
    case 'claimed':
      return item.draftClaimedAt === undefined;
    case 'plan-approved':
      return true;
    case 'executing':
      return item.applyPhase === 'auto' && item.applyAttemptId === undefined;
    case 'actions-pending':
      return item.approvedIndexes !== undefined && item.applyAttemptId === undefined;
    // No run is drawn for these: not yet judged, waiting on the manager, parked, or settled.
    case 'discovered':
    case 'plan-pending':
    case 'deferred':
    case 'needs-skill':
    case 'completed':
    case 'cancelled':
    case 'failed':
    case 'skipped':
      return false;
  }
}

/** The held steps a card names apart, as `waitsAtClaim` finds them. */
type HeldStep = 'draft' | 'run' | 'automatic-writes' | 'approved-writes';

/**
 * Which step a pause holds on this row, or undefined when the row waits at no claim.
 *
 * @param item - The row's state and claim fields.
 */
function heldStepOf(
  item: Pick<
    Doc<'workItems'>,
    'state' | 'draftClaimedAt' | 'applyPhase' | 'applyAttemptId' | 'approvedIndexes'
  >,
): HeldStep | undefined {
  if (!waitsAtClaim(item)) return undefined;
  if (item.state === 'claimed') return 'draft';
  if (item.state === 'plan-approved') return 'run';
  return item.state === 'executing' ? 'automatic-writes' : 'approved-writes';
}

/**
 * What a card says of a step a pause holds, in place of the step under way: a heading naming
 * the hold, and a sentence saying what is kept and when it goes on. An approval the manager gave
 * is said to stand, since "held" elsewhere on the card means held for the manager; automatic
 * writes had no approval to keep.
 *
 * @param hold - What holds the step.
 * @param item - The row whose step is held.
 * @returns The words, or undefined when the row waits at no claim (`waitsAtClaim`).
 */
export function heldStepWords(
  hold: RunHold,
  item: Pick<
    Doc<'workItems'>,
    'state' | 'draftClaimedAt' | 'applyPhase' | 'applyAttemptId' | 'approvedIndexes'
  >,
): { readonly title: string; readonly detail: string } | undefined {
  const step = heldStepOf(item);
  if (step === undefined) return undefined;
  const title =
    hold.by === 'employee'
      ? `Held while ${hold.employeeName} is paused`
      : "Held while this deployment's scheduled work is paused";
  const when =
    hold.by === 'employee'
      ? `when you resume ${hold.employeeName}`
      : "once the deployment's scheduled work runs again";
  return { title, detail: heldStepDetail(step, when) };
}

/** The sentence under a held step's heading: what is kept, and when it goes on. */
function heldStepDetail(step: HeldStep, when: string): string {
  switch (step) {
    case 'draft':
      return `The plan is drafted ${when}.`;
    case 'run':
      return `Your approval stands: the run starts ${when}.`;
    case 'automatic-writes':
      return `The automatic writes are kept: they are sent ${when}.`;
    case 'approved-writes':
      return `Your approval stands: the approved writes are sent ${when}.`;
  }
}

/** How a run's progress is read: the switch, the gate, and what holds its next step, if anything. */
export interface RunProgressContext {
  /** Whether autonomous actions are on, for how automatic writes are named. */
  readonly autonomous: boolean;
  /** The deployment's gate; the mock one applies nothing on its own. */
  readonly gate?: WorkGate;
  /** What holds the employee's next step (`runHoldOf`), undefined while nothing does. */
  readonly hold?: RunHold;
}

/**
 * How far a working item has got, from what the row records while it runs: the plan being
 * drafted, the run started, its reads and draft, its automatic writes, and for a run in two
 * phases its closing phase. A run records its steps' outcomes only when it finishes, so the
 * progress is by part, never a made-up step count. While a pause holds the row's next step
 * (`waitsAtClaim`), the heading and the sentence say the hold and the held part is marked so.
 *
 * @param item - A row in `claimed`, `plan-approved` or `executing`.
 * @param context - The switch, the gate and the hold.
 * @returns The progress, or undefined for a row in any other state.
 */
export function runProgress(
  item: Pick<
    Doc<'workItems'>,
    | 'state'
    | 'plan'
    | 'applyPhase'
    | 'approvedIndexes'
    | 'output'
    | 'draftClaimedAt'
    | 'applyAttemptId'
  >,
  { autonomous, gate = 'real', hold }: RunProgressContext,
): RunProgress | undefined {
  const progress = progressUnderWay(item, autonomous, gate);
  const words = hold === undefined ? undefined : heldStepWords(hold, item);
  if (progress === undefined || words === undefined) return progress;
  // The part the claim would start: the next one after the last done.
  const heldIndex = progress.parts.findIndex((part) => part.status !== 'done');
  return {
    title: words.title,
    detail: words.detail,
    parts: progress.parts.map((part, index) =>
      index === heldIndex ? { name: part.name, status: 'held' } : part,
    ),
  };
}

/** The progress of a run as if nothing held it: the part under way and the parts in order. */
function progressUnderWay(
  item: Pick<Doc<'workItems'>, 'state' | 'plan' | 'applyPhase' | 'approvedIndexes' | 'output'>,
  autonomous: boolean,
  gate: WorkGate,
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
  // The manager's approval is being sent: the step under way since Stop reached this card (W12-R8).
  if (item.state === 'executing' && item.applyPhase === 'approved') {
    const count = item.approvedIndexes?.length;
    return {
      title:
        count === undefined || count === 0
          ? 'Sending the writes you approved'
          : count === 1
            ? 'Sending the write you approved'
            : `Sending the ${count} writes you approved`,
      detail:
        'Stopping sends nothing more; a write already sent stays sent, and one on its way when you stop is listed for you to check.',
      parts: twoPhase
        ? [
            { name: 'Prerequisites', status: 'done' },
            { name: 'Closing actions', status: 'now' },
          ]
        : [
            { name: 'Read and draft', status: 'done' },
            { name: 'Your approval', status: 'done' },
            { name: 'Approved writes', status: 'now' },
          ],
    };
  }
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
    : gate === 'mock'
      ? ['Read and draft']
      : ['Read and draft', 'Automatic writes'];
  const current = item.state === 'plan-approved' ? -1 : twoPhase || applying ? 1 : 0;
  return {
    title: phase,
    detail: `Nothing reaches a surface while it reads and drafts; then ${writesWhenRunFinishes(autonomous, gate)}.`,
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

/** Whose identity holds a listed ticket, as the item's owner reads it (`work.latestListing`). */
export interface TicketHolderView {
  readonly employeeName: string;
  /** The ticket's assignee or delegate is the identity the employee acts as in the tracker. */
  readonly holderIsEmployee: boolean;
}

/**
 * Where a ticket stands as intake last listed it (K D3): its state, who holds it and whether it
 * is marked not to be automated, so a retry after the ticket moved is an informed one. The holder
 * is never named by its raw id (W12V-15): the identity the employee acts as is said to be its,
 * anyone else is someone in the tracker; the export keeps the id.
 *
 * @param tracker - The listing's snapshot, without the assignee's address.
 * @param refused - Why intake refused the ticket on that listing, when it did.
 * @param holder - Whether the holder is the employee's own identity, where the page knows.
 * @returns One sentence, without the listing's time.
 */
export function ticketNowSentence(
  tracker: Omit<TicketSnapshot, 'assigneeEmail'>,
  refused?: string,
  holder?: TicketHolderView,
): string {
  const state = tracker.state ? `in ${tracker.state}` : 'in a state the tracker did not name';
  const held = tracker.assigneeId
    ? holder === undefined
      ? 'assigned to someone in the tracker'
      : holder.holderIsEmployee
        ? `held by the account ${holder.employeeName} works as in the tracker`
        : `assigned to someone other than ${holder.employeeName} in the tracker`
    : tracker.assigned
      ? 'assigned to someone the tracker did not identify'
      : 'unassigned';
  const marked = tracker.doNotAutomate ? ', marked not to be automated' : '';
  const refusal = refused ? ` Intake refused it on that listing: ${sentence(refused)}` : '';
  return `The ticket is ${state}, ${held}${marked}.${refusal}`;
}
