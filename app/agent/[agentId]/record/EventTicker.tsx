'use client';

import type { Doc } from '@convex/_generated/dataModel';
import { useNow, useAgentZone, clockTimeWithSeconds, relativeTime } from '../time';
import { Card } from '../../../components/Card';
import { eventItemTitle, eventLabel } from '../event-labels';

/** The employee's newest events, newest first, each with the work item it is about. */
export function EventTicker({
  events,
  titles,
}: {
  /** The newest events, or undefined while the query loads. */
  events: Doc<'events'>[] | undefined;
  titles: ReadonlyMap<string, string>;
}) {
  const now = useNow();
  const zone = useAgentZone();
  return (
    <Card title="Live event feed">
      {events === undefined ? (
        <p className="text-xs text-[var(--color-muted)]">loading the feed…</p>
      ) : events.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">no events yet</p>
      ) : (
        // Focusable, so a keyboard reaches the events below the fold.
        <ul
          tabIndex={0}
          aria-label="Live event feed, newest first"
          className="space-y-1 text-[10px] font-mono max-h-72 overflow-y-auto"
        >
          {events.map((e) => {
            const title = eventItemTitle(e, titles);
            return (
              <li key={e._id} className="flex gap-2 text-[var(--color-muted)]">
                {/* Was a UTC clock beside the Slack panel's local one: the same
                  event stamped eight hours apart on one page. */}
                <time
                  dateTime={new Date(e.createdAt).toISOString()}
                  className="shrink-0 tabular-nums"
                  title={clockTimeWithSeconds(e.createdAt, zone)}
                >
                  {relativeTime(e.createdAt, now)}
                </time>
                <span className="min-w-0 break-words">
                  <span className="text-[var(--color-accent)]">{eventLabel(e)}</span>
                  {title ? <span className="text-[var(--color-fg)]"> · {title}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
