import type { FunctionReturnType } from 'convex/server';
import type { api } from '@convex/_generated/api';
import {
  TRANSFER_DEPARTURES_WINDOW_MS,
  TRANSFER_EXPIRY_MS,
  TRANSFER_SETTLE_MS,
} from '@/agent/manager-transfer';
import { formatStamp } from '@/lib/zone';
import { listed } from './agent/[agentId]/manage/retire-words';

/*
 * The manager transfer's words, as the screens say them (the transfer plan, section 7, and
 * section 11.2's flag). Every string here is a wording draft and a product call, flagged in the
 * unit's handover; the screens take them as written. "Employee", never "agent" (N29). A stamp is
 * in the viewer's zone with the zone named (N12): two managers in two zones read one request.
 */

/** What `transferAcceptance.transferPreview` answers for a request still waiting. */
export type HandoverPreview = NonNullable<
  FunctionReturnType<typeof api.transferAcceptance.transferPreview>
>;

/** A finished request as `managerTransfers.departures` lists it. */
export type HandoverDeparture = FunctionReturnType<typeof api.managerTransfers.departures>[number];

/** An open request as `managerTransfers.openForAgent` answers it. */
export type OpenHandover = NonNullable<
  FunctionReturnType<typeof api.managerTransfers.openForAgent>
>;

/**
 * An instant with its date and time in a zone, the zone named: `1 Oct 2026, 09:00, UTC time`.
 *
 * @param zone - The viewer's zone.
 */
export function zonedStamp(ms: number, zone: string): string {
  return `${formatStamp(ms, zone)}, ${zone} time`;
}

/**
 * A count with its noun: "1 run", "2 runs".
 *
 * @param one - The noun for one.
 * @param many - The noun for any other count.
 */
function counted(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-GB')} ${count === 1 ? one : many}`;
}

/** A count that may be a floor: "at least 200 events". */
function countedAtLeast(count: number, atLeast: boolean, one: string, many: string): string {
  return `${atLeast ? 'at least ' : ''}${counted(count, one, many)}`;
}

/** How many days an unanswered request stands, from the clock the backend keeps. */
const EXPIRY_DAYS = Math.round(TRANSFER_EXPIRY_MS / 86_400_000);

/** What the Manager card says the manager is for. */
export const MANAGER_DUTY =
  'Every held write and every plan comes to you. One manager per employee.';

/** The label of the control that opens the hand-over dialog. */
export const HAND_OVER = 'Hand over';

/**
 * The hand-over dialog's title.
 *
 * @param name - The employee.
 */
export function handOverTitle(name: string): string {
  return `Hand ${name} over to another manager?`;
}

/** The hand-over dialog's address field. */
export const HANDOVER_ADDRESS_LABEL = "The new manager's email address";

/** What the address field is for. */
export const HANDOVER_ADDRESS_HINT = 'They accept or decline in Day0, signed in with this address.';

/** The hand-over dialog's note field. */
export const HANDOVER_NOTE_LABEL = 'A note for them (optional)';

/** What the note is for. */
export const HANDOVER_NOTE_HINT = 'What they should know first. They read it before they decide.';

/** A card a handover keeps for re-approval (A25): its system, and whom it keeps acting as. */
export interface ReapprovedSystem {
  readonly system: string;
  /** Whom the card keeps acting as, in words: "Leo's own app". */
  readonly identity: string;
}

/** What the hand-over dialog's account of the consequences is headed. */
export const WHAT_HAPPENS = 'What happens';

/** What the hand-over dialog's consequences are drawn from. */
export interface HandOverLinesInput {
  readonly name: string;
  readonly mode: 'mock' | 'real';
  /** The systems whose connection the handover cuts, by the name the Surfaces tab gives each. */
  readonly cutSystems: readonly string[];
  /** The systems whose card keeps the employee's own identity and goes back for re-approval. */
  readonly reapproved: readonly ReapprovedSystem[];
  /** When the request would expire if it were asked now. */
  readonly expiresAt: number;
  /** The viewer's zone. */
  readonly zone: string;
}

/**
 * What handing the employee over does, line by line, in the order it happens (plan 7.1). The
 * hosted office cuts nothing and has no credential to revoke, so it says the office moves.
 */
export function handOverLines(input: HandOverLinesInput): string[] {
  const { name, mode } = input;
  const systems =
    mode === 'mock'
      ? [`In the hosted office, the office's systems go with ${name}.`]
      : [
          ...input.cutSystems.map(
            (system) =>
              `Its connection to ${system} is cut. They approve it and connect it again with their own credentials.`,
          ),
          ...input.reapproved.map(
            ({ system, identity }) =>
              `Its connection to ${system} stays. Re-approve: keeps acting as ${identity}; they approve it with one click and nothing to paste.`,
          ),
          `Credentials only ${name} uses are revoked. Ones another employee or your documentation uses stay yours.`,
        ];
  return [
    'Nothing changes until they accept. You keep every decision in the meantime, and you can cancel.',
    `When they accept, ${name} becomes theirs. It leaves your home and your team, and this page closes to you.`,
    ...systems,
    'Its record, charter, skills and lessons go with it. Your documentation stays yours.',
    `Unanswered, the request expires on ${zonedStamp(input.expiresAt, input.zone)}.`,
  ];
}

/**
 * The hand-over dialog's submit label, naming the address as it is typed.
 *
 * @param typed - The address field's value.
 */
export function askLabel(typed: string): string {
  const to = typed.trim();
  return `Ask ${to === '' ? 'them' : to}`;
}

/**
 * Said beside the card once a request is asked.
 *
 * @param name - The employee.
 * @param to - The address asked.
 */
export function askedWords(name: string, to: string): string {
  return `Asked ${to} to take ${name} on. Nothing changes until they accept.`;
}

/** What an asked request's line on the card is drawn from. */
export interface AskedCardInput {
  readonly name: string;
  readonly to: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
  readonly zone: string;
}

/**
 * The card's line while a request is asked. Whether the address has an account is never said:
 * the server cannot know it, and the old manager is not told (plan 7.1).
 */
export function askedCardLine(input: AskedCardInput): string {
  return `Handing over to ${input.to}. Asked ${zonedStamp(input.requestedAt, input.zone)}; expires ${zonedStamp(input.expiresAt, input.zone)}. ${input.name} works for you until they accept.`;
}

/** The control that names another address for an asked request. */
export const CHANGE_THE_ADDRESS = 'Change the address';

/**
 * What the hand-over dialog says when it names another address for an asked request: the request
 * is asked again, so its expiry starts again.
 *
 * @param to - The address the request names now.
 */
export function changeAddressDescription(to: string): string {
  return `The request to ${to} is cancelled and a new one is asked, so its ${EXPIRY_DAYS} days start again.`;
}

/** The hand-over dialog's dismiss control when it changes an address, beside Cancel the handover. */
export const KEEP_THE_ADDRESS = 'Keep the address';

/** The control that cancels an asked request. */
export const CANCEL_THE_HANDOVER = 'Cancel the handover';

/** The control that keeps an asked request from the cancel's confirmation. */
export const KEEP_THE_HANDOVER = 'Keep the handover';

/**
 * The cancel's confirmation, as its title.
 *
 * @param to - The address asked.
 */
export function cancelHandoverTitle(to: string): string {
  return `Cancel the handover to ${to}?`;
}

/** What the cancel's confirmation says the cancel does. */
export const CANCEL_HANDOVER_DESCRIPTION = 'Their request disappears from their inbox.';

/**
 * Said beside the card once a request is cancelled.
 *
 * @param to - The address asked.
 */
export function cancelledWords(to: string): string {
  return `The handover to ${to} is cancelled.`;
}

/**
 * Said in the retire dialog before the retire, of the asked request the retire cancels: what the
 * retire will do, not what is done (the wave 9 review's U4-m7).
 *
 * @param to - The address asked.
 */
export function retireCancelsWords(to: string): string {
  return `Retiring cancels the handover to ${to}.`;
}

/**
 * The handover requests a retire keeps, in the retire dialog: none is deleted, since each is the
 * other manager's record of the handover (`RETIRE_RECORD_TABLES`, the v0.12.0 walk: the dialog
 * said the hosted office keeps nothing while it kept them).
 *
 * @param requests - How many requests name the employee; at least one.
 */
export function keptRequestsWords(requests: number): string {
  const what =
    requests === 1
      ? "the two managers' addresses, the employee's name and any note or reason, kept as the record of the managers it names"
      : "the managers' addresses, the employee's name and any note or reason, kept as the record of the managers they name";
  return `${counted(requests, 'handover request', 'handover requests')}: ${what}.`;
}

/** What an accepting request's line on the card is drawn from. */
export interface AcceptingCardInput {
  readonly name: string;
  readonly to: string;
  /** The runs in flight, or undefined while they are read. */
  readonly runs: number | undefined;
  /** When the runs are stopped at the latest; an accepting request carries it from acceptance. */
  readonly settleBy: number | undefined;
  readonly zone: string;
}

/** The runs an accepting request waits on, and the verb that agrees with them. */
function finishingRuns(runs: number | undefined): { readonly runs: string; readonly end: string } {
  if (runs === undefined || runs === 0) return { runs: 'its runs', end: 'they end' };
  return { runs: counted(runs, 'run', 'runs'), end: runs === 1 ? 'it ends' : 'they end' };
}

/** The card's line while the named manager has accepted and the employee's runs finish. */
export function acceptingCardLine(input: AcceptingCardInput): string {
  const { runs, end } = finishingRuns(input.runs);
  const deadline =
    input.settleBy === undefined
      ? ''
      : `, by ${zonedStamp(input.settleBy, input.zone)} at the latest`;
  return `Accepted by ${input.to}. ${input.name} is finishing ${runs}; it becomes theirs when ${end}${deadline}.`;
}

/**
 * The card's line for the newest request that ended unaccepted (plan 7.1): a decline, with its
 * reason quoted when there is one, or an expiry.
 *
 * @param ended - The request, declined or expired.
 * @param zone - The viewer's zone.
 */
export function endedCardLine(
  ended: Pick<HandoverDeparture, 'state' | 'toAddress' | 'decidedAt' | 'declineReason'> & {
    readonly state: 'declined' | 'expired';
  },
  zone: string,
): string {
  const when = zonedStamp(ended.decidedAt, zone);
  if (ended.state === 'expired') return `The request to ${ended.toAddress} expired on ${when}.`;
  return ended.declineReason === undefined
    ? `Declined by ${ended.toAddress} on ${when}.`
    : `Declined by ${ended.toAddress} on ${when}: "${ended.declineReason}"`;
}

/**
 * The flag on an employee whose address is not its owner's (section 11.2, D17).
 *
 * @param name - The employee.
 * @param bossEmail - The address it reports to.
 */
export function otherStandingLine(name: string, bossEmail: string): string {
  return `${name} reports to ${bossEmail}, who is not you. From this release the manager is the account that owns the employee. Hand ${name} over to ${bossEmail}, or make yourself its manager.`;
}

/**
 * The flag's hand-over control, which opens the dialog with the address filled in.
 *
 * @param bossEmail - The address the employee reports to.
 */
export function handOverToLabel(bossEmail: string): string {
  return `Hand over to ${bossEmail}`;
}

/** The flag's control that makes the owner's own address the employee's. */
export const MAKE_IT_YOU = 'Make it you';

/**
 * Said once **Make it you** lands.
 *
 * @param name - The employee.
 */
export function madeYouWords(name: string): string {
  return `${name} now reports to you.`;
}

/** The header's line for an employee that reports to its owner (plan 7.2). */
export const REPORTS_TO_YOU = 'Reports to you';

/** The header's link to People while a request is asked, before the address (plan 7.2). */
export const HANDING_OVER_TO = 'handing over to';

/** The header's word before the address an accepting request goes to (plan 7.2). */
export const THEN = 'then';

/**
 * Where the header's line ends while a request is accepting: the employee is the owner's until
 * its runs finish (plan 7.2).
 *
 * @param name - The employee.
 */
export function untilRunsFinish(name: string): string {
  return ` until ${name}'s runs finish`;
}

/** What the header adds to an address that is not the owner's (section 11.2). */
export const WHO_IS_NOT_YOU = ', who is not you';

/** The header's link to People while the address is not the owner's. */
export const CHOOSE_ON_PEOPLE = 'choose on People';

/**
 * The header's line when a chat surface could not find the manager: the manager, not the
 * credential, is what failed, and with the free edit gone the address is the owner's own.
 *
 * @param reason - The surface's stored reason.
 */
export function managerLookupFailureLine(reason: string): string {
  return `The chat surface could not find this manager: ${reason.replace(/\.$/, '')}. The credential still works; the manager's address must be one the workspace knows.`;
}

/**
 * The acceptance dialog's title.
 *
 * @param name - The employee.
 */
export function takeOnTitle(name: string): string {
  return `Take on ${name}?`;
}

/** The acceptance dialog's lead: who asks, and what the employee is for. */
export function takeOnLead(preview: Pick<HandoverPreview, 'fromAddress' | 'employee'>): string {
  const { name, roleLine } = preview.employee;
  const lead = `${name}'s manager today, ${preview.fromAddress}, asks you to take ${name} on.`;
  if (roleLine === null) return lead;
  // A role line clipped with an ellipsis, or written as a sentence, keeps its own close.
  return `${lead} ${name}: ${roleLine}${/[.…!?]$/.test(roleLine) ? '' : '.'}`;
}

/** The acceptance dialog's section of what comes with the employee. */
export const YOU_TAKE_ON = 'You take on';

/** The acceptance dialog's section of what stays behind. */
export const DOES_NOT_COME = 'Does not come with it';

/** The acceptance dialog's section of the charter's reporting lines. */
export const CHECK = 'Check';

/** The acceptance dialog's section of the acceptor's documentation. */
export const READS_FOR_IT = 'Reads for it';

/** The preview's waiting counts, by the inbox's kinds as the validator names them. */
type WaitingCounts = HandoverPreview['takesOn']['waiting'];

/**
 * How each kind of decision waiting is counted in the acceptance dialog, singular and plural, in
 * the inbox's order. A held entry is counted as an item, not by its writes: the preview counts
 * entries.
 */
const WAITING_DECISION_NOUNS: Readonly<
  Record<keyof WaitingCounts, readonly [one: string, many: string]>
> = {
  oneToOne: ['one-to-one', 'one-to-ones'],
  charter: ['charter to review', 'charters to review'],
  plan: ['plan', 'plans'],
  held: ['item with writes held', 'items with writes held'],
  skill: ['skill to approve', 'skills to approve'],
  parked: ['parked item', 'parked items'],
  stopped: ['stopped run', 'stopped runs'],
  surface: ['connection to approve', 'connections to approve'],
};

/**
 * The dialog's line of the decisions that wait on the manager now and move to the acceptor, by
 * kind (plan 7.3: "{n} decisions waiting: {waiting words}"), or nothing when none waits.
 *
 * @param waiting - The preview's counts.
 */
function waitingDecisionsLine(waiting: WaitingCounts): string[] {
  const kinds = Object.keys(WAITING_DECISION_NOUNS) as (keyof WaitingCounts)[];
  const parts = kinds.flatMap((kind) =>
    waiting[kind] > 0 ? [counted(waiting[kind], ...WAITING_DECISION_NOUNS[kind])] : [],
  );
  const total = kinds.reduce((sum, kind) => sum + waiting[kind], 0);
  if (total === 0) return [];
  return [`${counted(total, 'decision', 'decisions')} waiting: ${listed(parts)}`];
}

/**
 * What the new manager takes on, line by line (plan 7.3): the decisions waiting first, when any
 * do.
 *
 * @param preview - The request's preview.
 */
export function takesOnLines(preview: Pick<HandoverPreview, 'takesOn'>): string[] {
  const taken = preview.takesOn;
  const scopes = taken.scopes.map((grant) => grant.scope);
  return [
    ...waitingDecisionsLine(taken.waiting),
    `${countedAtLeast(taken.openWork, taken.openWorkAtLeast, 'item', 'items')} in progress`,
    counted(taken.registeredSkills, 'skill', 'skills'),
    taken.charter?.approved
      ? `charter version ${taken.charter.version}, approved`
      : 'no approved charter: you hold its Day-1 one-to-one',
    `permissions: ${scopes.length === 0 ? 'none' : listed(scopes)}`,
    `its record: ${countedAtLeast(taken.recordLength, taken.recordAtLeast, 'event', 'events')}, decisions included, as they were made`,
  ];
}

/**
 * Whom a card kept for re-approval keeps acting as, by its kind (11-AC's cockpit item 6): the
 * employee's own app by the name the system shows, or the app the employees share.
 *
 * @param surface - The kept card's system, identity and kind.
 * @param employee - The employee's name.
 */
function keptIdentityWords(
  surface: HandoverPreview['leavesBehind']['reapprove'][number],
  employee: string,
): string {
  switch (surface.kind) {
    case 'own-app':
      return `${employee}'s own app, named “${surface.identity}” in ${surface.displayName}`;
    case 'shared-app':
      return 'the Day0 app your employees share';
    case 'delegated':
    case 'shared-key':
    case 'browser-seat':
      return surface.identity;
    default: {
      const unknown: never = surface.kind;
      throw new Error(`unhandled identity kind ${String(unknown)}`);
    }
  }
}

/**
 * What does not come with the employee, line by line (plan 7.3).
 *
 * @param preview - The request's preview.
 */
export function leavesBehindLines(
  preview: Pick<HandoverPreview, 'leavesBehind' | 'fromAddress' | 'employee'>,
): string[] {
  const left = preview.leavesBehind;
  const pages = countedAtLeast(left.mirroredPages, left.mirroredPagesAtLeast, 'page', 'pages');
  return [
    ...left.surfaces.map((surface) =>
      surface.throughConnection
        ? `${surface.displayName}: you approve it, then connect it through IT's connection, with nothing to paste`
        : `${surface.displayName}: you approve and connect it with your own credentials`,
    ),
    ...left.reapprove.map(
      (surface) =>
        `${surface.displayName}: re-approve with one click; it keeps acting as ${keptIdentityWords(surface, preview.employee.name)}, with nothing to paste`,
    ),
    ...(left.mirroredPages > 0
      ? [`${pages} of ${preview.fromAddress}'s documentation it stops reading`]
      : []),
    'autonomous actions: off until you turn them on',
  ];
}

/**
 * What the acceptor is asked to check under the charter's reporting lines.
 *
 * @param name - The employee.
 */
export function reportingLineCheck(name: string): string {
  return `Amend the charter after you take ${name} on if this no longer holds.`;
}

/** Said under the acceptor's documentation, as the deploy form says it. */
export const READS_FOR_IT_HINT = 'Untick a source it should not read.';

/** Said in place of the ticks when the acceptor has linked no documentation. */
export const NO_DOCUMENTATION = 'You have linked no documentation, so it reads none of yours yet.';

/** How many minutes the move waits for the runs at most, from the clock the backend keeps. */
const SETTLE_MINUTES = Math.round(TRANSFER_SETTLE_MS / 60_000);

/** What the line about runs in flight is drawn from. */
export interface RunsInFlightInput {
  readonly name: string;
  readonly from: string;
  readonly runs: number;
}

/** The acceptance dialog's line while the employee has runs in flight (D18). */
export function runsInFlightLine(input: RunsInFlightInput): string {
  const { runs, end } = finishingRuns(input.runs);
  return `${input.name} is finishing ${runs} for ${input.from}. It becomes yours when ${end}, within ${SETTLE_MINUTES} minutes.`;
}

/**
 * The acceptance dialog's take-on control.
 *
 * @param name - The employee.
 */
export function takeOnLabel(name: string): string {
  return `Take on ${name}`;
}

/** The acceptance dialog's decline control, which opens the reason and then sends it. */
export const DECLINE = 'Decline';

/** The way back from the decline's reason to the two answers, sending nothing. */
export const BACK_FROM_DECLINE = 'Back';

/**
 * The decline's reason field.
 *
 * @param from - The manager who asked.
 */
export function declineReasonLabel(from: string): string {
  return `Tell ${from} why (optional)`;
}

/**
 * Said on the home once the acceptance lands, from what the acceptance answered: the employee is
 * the acceptor's, or becomes theirs when its runs end. It names no count, which would go stale on
 * the page once the runs ended; the line {@link arrivingLine} draws is the live one.
 *
 * @param name - The employee.
 * @param state - The request's state as `transferAcceptance.accept` answered it.
 */
export function acceptedWords(name: string, state: 'accepted' | 'accepting'): string {
  return state === 'accepted'
    ? `${name} is yours.`
    : `You accepted ${name}. It becomes yours when its runs end.`;
}

/** What the acceptor's line for an employee on its way is drawn from. */
export interface ArrivingInput {
  readonly name: string;
  readonly from: string;
  /** The runs the move waits for, as the backend counts them now. */
  readonly runs: number;
  /** When the runs are stopped at the latest. */
  readonly settleBy: number | undefined;
  readonly zone: string;
}

/** The heading of the acceptor's employees on their way (the transfer plan, section 4.2). */
export const ON_ITS_WAY = 'On its way to you';

/** The acceptor's line for an accepted employee still finishing its runs for the old manager. */
export function arrivingLine(input: ArrivingInput): string {
  const { runs, end } = finishingRuns(input.runs);
  const deadline =
    input.settleBy === undefined
      ? ''
      : `, by ${zonedStamp(input.settleBy, input.zone)} at the latest`;
  return `${input.name} is finishing ${runs} for ${input.from} and becomes yours when ${end}${deadline}.`;
}

/**
 * The heading of the acceptor's handovers that ended without the move (decision 4), by how many
 * there are.
 *
 * @param count - How many lines the card draws.
 */
export function notFinishedHeading(count: number): string {
  return count === 1 ? 'A handover that did not finish' : 'Handovers that did not finish';
}

/** What the acceptor's line for a handover that ended without the move is made from. */
export interface EndedHandoverInput {
  readonly name: string;
  /** The manager the employee stays with. */
  readonly from: string;
  /** When the caller accepted it. */
  readonly acceptedAt: number;
  readonly zone: string;
}

/**
 * The acceptor's line for a handover it accepted that could not finish and was ended (decision 4:
 * the automatic end after the settles failed, or the operator's): the employee stays with the
 * manager who asked, said once, and when the acceptance was made last.
 */
export function endedHandoverLine(input: EndedHandoverInput): string {
  return `${input.name} stays with ${input.from}: the handover you accepted could not finish and was ended (accepted ${zonedStamp(
    input.acceptedAt,
    input.zone,
  )}).`;
}

/**
 * Said on the home once a decline lands.
 *
 * @param name - The employee.
 * @param from - The manager who asked, who is told.
 */
export function declinedWords(name: string, from: string): string {
  return `You declined to take ${name} on. It shows on ${name}'s People tab for ${from}.`;
}

/** Said in the acceptance dialog while its preview is read. */
export const READING_HANDOVER = 'Reading what comes with this handover';

/** Said in the acceptance dialog when the request is no longer waiting for an answer. */
export const HANDOVER_NOT_WAITING =
  'This handover is no longer waiting for an answer: it was answered or cancelled, or it expired.';

/** Said in the acceptance dialog when the request could not be read at all. */
export const HANDOVER_UNREADABLE = 'This handover could not be read.';

/** The acceptance dialog's title when it has no request to show. */
export const HANDOVER_TITLE = 'Handover';

/** The old manager's home card of employees handed over (plan 7.4). */
export const HANDED_OVER = 'Handed over';

/** A handover the old manager reads about: where the employee went, when, and what became of it since. */
export interface HandoverOutcome {
  /** The employee. */
  readonly name: string;
  /** The manager it went to. */
  readonly to: string;
  /** When they accepted. */
  readonly since: number;
  /** The viewer's zone. */
  readonly zone: string;
  /** What became of the employee since, when it is not with that manager still. */
  readonly afterwards?: HandoverDeparture['afterwards'];
}

/**
 * What became of a handed-over employee since, after the handover itself: retired, or moved on
 * to another manager. The handover request outlives a retire by design, so the line it is read
 * from must not say the employee reports to anyone once it does not (the v0.12.0 walk).
 */
function sinceWords(
  outcome: HandoverOutcome & { readonly afterwards: NonNullable<HandoverOutcome['afterwards']> },
): string {
  const handed = `${outcome.name} was handed over to ${outcome.to} on ${zonedStamp(outcome.since, outcome.zone)}`;
  switch (outcome.afterwards) {
    case 'came-back':
      return `${handed}, and has since come back to you.`;
    case 'retired':
      return `${handed}, and has since been retired.`;
    case 'moved-on':
      return `${handed}, and has since moved to another manager.`;
    default: {
      const unknown: never = outcome.afterwards;
      throw new Error(`unhandled handover outcome ${String(unknown)}`);
    }
  }
}

/**
 * Where the old manager's own record of a handover is, for as long as the home lists it: the
 * departed page answers for the same thirty days (`isDepartureListed`, decision 8), so the line
 * stays true for as long as the page draws it.
 */
const HOME_LISTS_IT = `Your home lists the handover for ${Math.round(TRANSFER_DEPARTURES_WINDOW_MS / 86_400_000)} days.`;

/**
 * One line of the home's handed-over card: whom the employee reports to now, or, once it was
 * retired or moved on since, what happened and that it did.
 */
export function handedOverLine(outcome: HandoverOutcome): string {
  const { afterwards } = outcome;
  if (afterwards !== undefined) return sinceWords({ ...outcome, afterwards });
  return `${outcome.name} now reports to ${outcome.to}, since ${zonedStamp(outcome.since, outcome.zone)}.`;
}

/**
 * The heading of the old manager's link to an employee handed over.
 *
 * @param name - The employee.
 */
export function departedTitle(name: string): string {
  return `${name} was handed over`;
}

/**
 * The browser tab's title on the old manager's link to an employee handed over, on every tab of
 * it: the title the employee's own page has names a tab of an employee that is not theirs.
 *
 * @param name - The employee.
 */
export function departedTabTitle(name: string): string {
  return `${departedTitle(name)} · Day0`;
}

/**
 * What the old manager's link to an employee handed over says, in place of "not yours"
 * (plan 7.4): whom it reports to now, or, once it was retired or moved on since, what happened.
 */
export function departedLine(outcome: HandoverOutcome): string {
  const { afterwards } = outcome;
  if (afterwards !== undefined) {
    return `${sinceWords({ ...outcome, afterwards })} ${HOME_LISTS_IT}`;
  }
  return `${outcome.name} reports to ${outcome.to} since ${zonedStamp(outcome.since, outcome.zone)}. Its record went with it; ${HOME_LISTS_IT.charAt(0).toLocaleLowerCase('en-GB')}${HOME_LISTS_IT.slice(1)}`;
}

/**
 * The start of the home's one line while any employee reports to someone else (section 11.2),
 * before the employees are named, each a link to its People tab.
 *
 * @param count - How many do.
 */
export function reportingElsewhereLead(count: number): string {
  return count === 1
    ? '1 employee reports to someone who is not you:'
    : `${counted(count, 'employee', 'employees')} report to someone who is not you:`;
}

/**
 * The end of the home's line: where the manager chooses.
 *
 * @param count - How many employees the line names.
 */
export function reportingElsewhereChoice(count: number): string {
  return count === 1 ? 'Choose on its People tab.' : "Choose on each one's People tab.";
}

/**
 * Why the retire dialog's Retire is off while a request is accepting (plan 7.5): the acceptance
 * cannot be undone, and a retire would destroy what the new manager accepted.
 *
 * @param name - The employee.
 * @param to - The manager who accepted.
 */
export function retireBlockedByAcceptance(name: string, to: string): string {
  return `${name} was accepted by ${to}; it is theirs once its runs finish.`;
}
