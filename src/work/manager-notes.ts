/**
 * What the gate tells the manager about a run's outcome, and how often.
 *
 * A decision request is sent the moment work waits on the manager, whatever
 * the mode: it is the one message that blocks work. Everything else is for
 * their information: the note that work landed, and the record that a run
 * stopped. Per run, the landed note is sent as it happens and a stop is
 * never sent, because nothing needs deciding; in digest mode both are kept
 * and sent together on the hour.
 */

export type ManagerNotificationMode = 'per-run' | 'digest';

export type ManagerNoteKind = 'landed' | 'stopped';

/** How often the digest cron runs. */
export const DIGEST_INTERVAL_MINUTES = 60;

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

function quoted(title: string): string {
  return `“${title.replace(/\s+/g, ' ').trim() || 'Untitled work'}”`;
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
  const rows = args.outcome === 'completed' ? args.rows : args.rows.filter((row) => row.kind === 'write');
  const lines = rows.map((row) => `- ${row.line}${row.outcomeUnknown ? ' (outcome unknown)' : ''}`);
  const head =
    args.outcome === 'completed'
      ? `${args.agentName} finished ${quoted(args.title)}: ${landedCount(rows)}.`
      : `${args.agentName} stopped on ${quoted(args.title)} after ${changes(rows.length)} landed: ${args.reason ?? 'the run did not finish'}. Reconcile the provider in day0 before a retry.`;
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
export function stoppedNoteText(args: { agentName: string; title: string; reason: string }): string {
  return `${args.agentName} stopped on ${quoted(args.title)}: ${args.reason}. Nothing landed; Retry stands in day0.`;
}

/**
 * One digest message from the notes kept since the last one.
 *
 * Args:
 *   args: The agent and the notes in the order they were recorded.
 *
 * Returns:
 *   The digest text.
 */
export function digestText(args: {
  agentName: string;
  notes: ReadonlyArray<{ text: string }>;
}): string {
  const count = args.notes.length;
  return [
    `${args.agentName}: ${count} ${count === 1 ? 'update' : 'updates'} since the last digest.`,
    '',
    ...args.notes.map((note) => note.text),
  ].join('\n\n');
}
