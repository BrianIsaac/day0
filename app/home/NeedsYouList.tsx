import { pausedNeedsYouLine } from '@/work/pause';
import { useArrival } from '../arrival';
import { employeeTabHref } from '../agent/[agentId]/employee-tabs';
import { ButtonLink } from '../components/Button';
import { InboxEntry } from '../components/InboxEntry';
import type { NeedsYouInbox } from './types';

/** A paused employee, as the home names it on the list (12-P). */
export interface PausedEmployee {
  readonly agentId: string;
  readonly name: string;
}

/** No employee beyond the inbox: the list's default, one map for every render. */
const NONE_BEYOND: ReadonlyMap<string, number> = new Map();

/** Said in place of the inbox when the backend could not read it. */
export const NEEDS_YOU_UNREADABLE =
  'The inbox could not be read just now. Each employee’s page still shows what waits on you there.';

/**
 * The needs-you inbox (N7): every decision waiting on the manager across
 * their employees, longest wait first, each with the one control that opens
 * the tab of the employee's page where it is decided. Above the entries, a line
 * for each paused employee whose decisions still wait (12-P), with a link to its
 * Manage tab where Resume is: the decisions stay answerable while it is paused,
 * and the line says so once rather than adding an entry of its own.
 *
 * @param inbox - The inbox, every page of `work.needsYou` put together, undefined while it
 *   loads, and the `Error` the backend answered with when a read failed.
 * @param now - The page's clock, so the waits age.
 * @param paused - The manager's paused employees; none by default.
 * @param beyond - What waits for each employee the inbox's last whole read does not reach (one
 *   deployed since, which the roster lists): counted in the last line, since their entries are on
 *   their own pages, and named in a paused employee's line as the inbox's own count is.
 */
export function NeedsYouList({
  inbox: read,
  now,
  paused = [],
  beyond = NONE_BEYOND,
}: {
  inbox: NeedsYouInbox | undefined | Error;
  now: number;
  paused?: readonly PausedEmployee[];
  beyond?: ReadonlyMap<string, number>;
}) {
  const failed = read instanceof Error;
  const inbox = failed ? undefined : read;
  const beyondTotal = [...beyond.values()].reduce((sum, waiting) => sum + waiting, 0);
  const more = inbox ? inbox.total - inbox.entries.length + beyondTotal : 0;
  // Nothing is said of a paused employee before the inbox is read, as before its own count was.
  const waitingOf = new Map<string, number>(
    inbox
      ? [
          ...beyond,
          ...inbox.waitingByEmployee.map(({ agentId, waiting }): [string, number] => [
            String(agentId),
            waiting,
          ]),
        ]
      : [],
  );
  const pausedLines = paused.flatMap(({ agentId, name }) => {
    const waiting = waitingOf.get(agentId) ?? 0;
    return waiting > 0 ? [{ agentId, name, line: pausedNeedsYouLine(name, waiting) }] : [];
  });
  // The entries are a second tier inside the card, as the Work tab's rows are (v4 section 1.3).
  const listed = inbox !== undefined && inbox.entries.length > 0;
  const arriving = useArrival(listed);
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
      ) : (
        <>
          {pausedLines.length > 0 ? (
            <ul className="flex flex-col gap-1 border-b border-[var(--color-border)] px-5 py-3">
              {pausedLines.map(({ agentId, name, line }) => (
                <li
                  key={agentId}
                  className="flex flex-wrap items-center justify-between gap-x-3 text-sm text-[var(--color-warn)]"
                >
                  <span className="min-w-0 [overflow-wrap:anywhere]">{line}</span>
                  {/* Resume is on the employee's Manage tab; the line says where. */}
                  <ButtonLink
                    href={employeeTabHref(agentId, 'manage')}
                    variant="text"
                    size="small"
                    className="!whitespace-normal [overflow-wrap:anywhere]"
                  >
                    Manage {name}
                  </ButtonLink>
                </li>
              ))}
            </ul>
          ) : null}
          {inbox.entries.length > 0 ? (
            <ol data-cards={arriving ? 'rows' : undefined} className="flex flex-col gap-3 p-5">
              {inbox.entries.map((entry) => (
                <InboxEntry key={entry.key} entry={entry} now={now} named />
              ))}
            </ol>
          ) : more === 0 ? (
            // With something waiting on a page this list does not reach, the last line says so alone.
            <p className="px-5 py-4 text-sm text-[var(--color-muted)]">
              Nothing is waiting on you.
            </p>
          ) : null}
        </>
      )}
      {more > 0 ? (
        <p
          className={[
            'px-5 py-3 text-xs text-[var(--color-muted)]',
            ...(listed ? ['border-t border-[var(--color-border)]'] : []),
          ].join(' ')}
        >
          {more} more on your employees’ pages.
        </p>
      ) : null}
    </section>
  );
}
