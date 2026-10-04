import { pausedNeedsYouLine } from '@/work/pause';
import { useArrival } from '../arrival';
import { InboxEntry } from '../components/InboxEntry';
import type { NeedsYouInbox } from './types';

/** A paused employee, as the home names it on the list (12-P). */
export interface PausedEmployee {
  readonly agentId: string;
  readonly name: string;
}

/** Said in place of the inbox when the backend could not read it. */
export const NEEDS_YOU_UNREADABLE =
  'The inbox could not be read just now. Each employee’s page still shows what waits on you there.';

/**
 * The needs-you inbox (N7): every decision waiting on the manager across
 * their employees, longest wait first, each with the one control that opens
 * the tab of the employee's page where it is decided. Above the entries, a line
 * for each paused employee whose decisions still wait (12-P): the decisions
 * stay answerable while it is paused, and the line says so once rather than
 * adding an entry of its own.
 *
 * @param inbox - The inbox as `work.needsYou` returns it, undefined while it loads, and the
 *   `Error` the backend answered with when the read failed.
 * @param now - The page's clock, so the waits age.
 * @param paused - The manager's paused employees; none by default.
 */
export function NeedsYouList({
  inbox: read,
  now,
  paused = [],
}: {
  inbox: NeedsYouInbox | undefined | Error;
  now: number;
  paused?: readonly PausedEmployee[];
}) {
  const failed = read instanceof Error;
  const inbox = failed ? undefined : read;
  const more = inbox ? inbox.total - inbox.entries.length : 0;
  const waitingOf = new Map(
    (inbox?.waitingByEmployee ?? []).map(({ agentId, waiting }) => [String(agentId), waiting]),
  );
  const pausedLines = paused.flatMap(({ agentId, name }) => {
    const waiting = waitingOf.get(agentId) ?? 0;
    return waiting > 0 ? [{ agentId, line: pausedNeedsYouLine(name, waiting) }] : [];
  });
  // The entries are a second tier inside the card, as the Work tab's rows are (v4 section 1.3).
  const arriving = useArrival(inbox !== undefined && inbox.entries.length > 0);
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
        <h2 className="text-sm font-semibold">Needs you</h2>
        <span className="text-xs text-[var(--color-muted)]">ordered by wait</span>
      </div>
      {failed ? (
        <p role="status" className="px-5 py-4 text-sm text-[var(--color-muted)]">
          {NEEDS_YOU_UNREADABLE}
        </p>
      ) : inbox === undefined ? (
        <p className="px-5 py-4 text-sm text-[var(--color-muted)]">Loading</p>
      ) : inbox.entries.length === 0 ? (
        <p className="px-5 py-4 text-sm text-[var(--color-muted)]">Nothing is waiting on you.</p>
      ) : (
        <>
          {pausedLines.length > 0 ? (
            <ul className="flex flex-col gap-1 border-b border-[var(--color-border)] px-5 py-3">
              {pausedLines.map(({ agentId, line }) => (
                <li key={agentId} className="text-sm text-[var(--color-warn)]">
                  {line}
                </li>
              ))}
            </ul>
          ) : null}
          <ol data-cards={arriving ? 'rows' : undefined} className="flex flex-col gap-3 p-5">
            {inbox.entries.map((entry) => (
              <InboxEntry key={entry.key} entry={entry} now={now} named />
            ))}
          </ol>
        </>
      )}
      {more > 0 ? (
        <p className="border-t border-[var(--color-border)] px-5 py-3 text-xs text-[var(--color-muted)]">
          {more} more on your employees’ pages.
        </p>
      ) : null}
    </section>
  );
}
