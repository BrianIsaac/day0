/**
 * What the gate tells the manager about a run's outcome, and how often.
 *
 * A decision request is sent the moment work waits on the manager, whatever
 * the mode: it is the one message that blocks work. Everything else is for
 * their information: the note that work landed, and the record that a run
 * stopped. Per run, the landed note is sent as it happens and a stop is
 * never sent, because nothing needs deciding; in digest mode both are kept
 * and sent together on the hour in the agent's zone, each with its date and
 * time.
 */

import { agentZone, formatStamp, isHourStart } from '../lib/zone';
import { slackEscaped } from '../surfaces/slack-markup';

export type ManagerNotificationMode = 'per-run' | 'digest';

export type ManagerNoteKind = 'landed' | 'stopped';

/**
 * When the digest cron runs: every quarter hour on the UTC clock, so it meets
 * the top of every zone's hour, half and three-quarter hour offsets included.
 * `digestDue` sends an agent's digest only at its own hour.
 */
export const DIGEST_SCHEDULE = '0,15,30,45 * * * *';

/** The reason recorded on `agent.notifications-changed`. */
export const NOTIFICATIONS_CHANGE_REASON = 'set by the manager';

/** The header's name for each mode. */
export const NOTIFICATION_MODE_LABELS: Record<ManagerNotificationMode, string> = {
  'per-run': 'per run',
  digest: 'hourly digest',
};

/**
 * The manager's chosen notification mode; an absent field is per run.
 *
 * Args:
 *   agent: The agent row's notification field.
 *
 * Returns:
 *   The mode.
 */
export function managerNotificationMode(agent: {
  managerNotifications?: ManagerNotificationMode;
}): ManagerNotificationMode {
  return agent.managerNotifications ?? 'per-run';
}

/**
 * Whether an agent's kept notes go out now.
 *
 * In digest mode, on the hour in the agent's zone. A per-run agent keeps no
 * note, so a note it still holds was kept in digest mode before the switch,
 * and it goes at once rather than waiting for an hour that never comes.
 *
 *
 * @param agent - The agent row's notification mode and zone.
 * @param now - The cron's time.
 * @returns True when the notes are due.
 */
export function digestDue(
  agent: { managerNotifications?: ManagerNotificationMode; zone?: string },
  now: number,
): boolean {
  return managerNotificationMode(agent) === 'per-run' || isHourStart(now, agentZone(agent));
}

/** A title in quotation marks, on one line, escaped for the Slack message it goes into. */
function quoted(title: string): string {
  return `“${slackEscaped(title.replace(/\s+/g, ' ').trim()) || 'Untitled work'}”`;
}

function changes(count: number): string {
  return `${count} ${count === 1 ? 'change' : 'changes'}`;
}

/** One landed ledger row as the note tells it. */
export interface LandedNoteRow {
  /** A write is work to reconcile; a read is counted so the note agrees with the card. */
  kind: 'write' | 'read';
  /** The row in a manager's words (`summariseAction`), never the provider's or the driver's echo. */
  line: string;
  outcomeUnknown?: boolean;
}

/** What a finished run's count is a count of: the plain word when it is all writes, the split when it is not. */
function landedCount(rows: readonly LandedNoteRow[]): string {
  const writes = rows.filter((row) => row.kind === 'write').length;
  const reads = rows.length - writes;
  if (reads === 0) return `${changes(writes)} landed`;
  const split = [
    ...(writes > 0 ? [`${writes} ${writes === 1 ? 'write' : 'writes'}`] : []),
    `${reads} ${reads === 1 ? 'read' : 'reads'}`,
  ].join(', ');
  return `${rows.length} ${rows.length === 1 ? 'action' : 'actions'} landed (${split})`;
}

/**
 * The one-line note, with its ledger lines, for a run in which work landed.
 *
 * A finished run lists every landed row, reads included, so its count is the
 * card's count and says what it counts. A run that stopped lists and counts
 * its writes only: those are what the manager reconciles before a retry.
 *
 * Args:
 *   args: The agent, the item, the landed rows (`landedNoteRows`), and for a failed run why it ended.
 *
 * Returns:
 *   The note text.
 */
export function landedNoteText(args: {
  agentName: string;
  title: string;
  rows: readonly LandedNoteRow[];
  outcome: 'completed' | 'failed';
  reason?: string;
}): string {
  const rows =
    args.outcome === 'completed' ? args.rows : args.rows.filter((row) => row.kind === 'write');
  const lines = rows.map(
    (row) => `- ${slackEscaped(row.line)}${row.outcomeUnknown ? ' (outcome unknown)' : ''}`,
  );
  const name = slackEscaped(args.agentName);
  const head =
    args.outcome === 'completed'
      ? `${name} finished ${quoted(args.title)}: ${landedCount(rows)}.`
      : `${name} stopped on ${quoted(args.title)} after ${changes(rows.length)} landed: ${slackEscaped(args.reason ?? 'the run did not finish')}. Reconcile the provider in day0 before a retry.`;
  return [head, ...lines].join('\n');
}

/**
 * The record of a run that stopped with nothing landed, for the digest.
 *
 * Args:
 *   args: The agent, the item and the stop reason.
 *
 * Returns:
 *   The note text.
 */
export function stoppedNoteText(args: {
  agentName: string;
  title: string;
  reason: string;
}): string {
  return `${slackEscaped(args.agentName)} stopped on ${quoted(args.title)}: ${slackEscaped(args.reason)}. Nothing landed; Retry stands in day0.`;
}

/** A decision the manager still owes, as the digest names it. */
export interface OwedDecision {
  readonly title: string;
  /** The code of the request delivered for it; absent when it was never asked on chat. */
  readonly decisionId?: string;
}

/** The most owed decisions a digest names; the rest are counted. */
export const DIGEST_OWED_SHOWN = 10;

/**
 * One digest message from the notes kept since the last one, each stamped
 * with the date and time it was kept, in the agent's zone, closed by the
 * decisions still waiting on the manager, so a manager who reads only the
 * digest learns what is owed (E-2, N-3).
 *
 * @param args - The agent, its zone, the notes in the order they were recorded, and what is owed.
 * @returns The digest text.
 */
export function digestText(args: {
  agentName: string;
  zone: string;
  notes: ReadonlyArray<{ text: string; createdAt: number }>;
  owed?: readonly OwedDecision[];
  /**
   * Whether the manager's typed code reaches the employee's app (W12V-7): an app that takes no
   * messages is never named a code to reply with. True unless the caller says otherwise.
   */
  typedCode?: boolean;
}): string {
  const count = args.notes.length;
  const owed = args.owed ?? [];
  const shown = owed
    .slice(0, DIGEST_OWED_SHOWN)
    .map((decision) =>
      decision.decisionId === undefined || args.typedCode === false
        ? `- ${quoted(decision.title)}: decide in day0`
        : `- ${quoted(decision.title)}: reply “approve ${decision.decisionId}” or “reject ${decision.decisionId} <reason>”`,
    );
  const more = owed.length - shown.length;
  return [
    `${slackEscaped(args.agentName)}: ${count} ${count === 1 ? 'update' : 'updates'} since the last digest (times in ${args.zone}).`,
    ...args.notes.map((note) => `${formatStamp(note.createdAt, args.zone)}: ${note.text}`),
    ...(owed.length > 0
      ? [
          [
            `Still waiting for your decision (${owed.length}):`,
            ...shown,
            ...(more > 0 ? [`…and ${more} more in day0.`] : []),
          ].join('\n'),
        ]
      : []),
  ].join('\n\n');
}
