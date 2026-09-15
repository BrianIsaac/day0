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

import type { ReconciliationEntry } from './reconciliation';

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

/**
 * The one-line note, with its ledger lines, for a run in which work landed.
 *
 * Args:
 *   args: The agent, the item, the landed entries, and for a failed run why it ended.
 *
 * Returns:
 *   The note text.
 */
export function landedNoteText(args: {
  agentName: string;
  title: string;
  landed: readonly ReconciliationEntry[];
  outcome: 'completed' | 'failed';
  reason?: string;
}): string {
  const lines = args.landed.map(
    (entry) =>
      `- ${entry.effect ?? entry.tool}${entry.outcome === 'outcome-unknown' ? ' (outcome unknown)' : ''}`,
  );
  const head =
    args.outcome === 'completed'
      ? `${args.agentName} finished ${quoted(args.title)}: ${changes(args.landed.length)} landed.`
      : `${args.agentName} stopped on ${quoted(args.title)} after ${changes(args.landed.length)} landed: ${args.reason ?? 'the run did not finish'}. Reconcile the provider in day0 before a retry.`;
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
