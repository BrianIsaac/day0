'use client';

import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { Chip } from '../../../components/Chip';
import type { Tone } from '../../../components/tone';

/** Each ticket status's tone; a status the office does not know is muted. */
const STATUS_TONE: Readonly<Record<string, Tone>> = {
  open: 'muted',
  'in-progress': 'accent',
  blocked: 'warn',
  done: 'ok',
};

/** What an empty ticket list means. The tab is mock-only: real mode does not
 * render it, so it has no real-mode copy to show. */
export const EMPTY_TICKETS = 'No tickets are seeded in this office.';

/** The office's ticket queue, each ticket with its status, priority and comments. */
export function TicketsTab({ agentId }: { agentId: Id<'agents'> }) {
  const tickets = useQuery(api.mock.listTickets, { agentId });

  if (!tickets) return <p className="text-sm text-[var(--color-muted)]">Loading the tickets…</p>;
  if (tickets.length === 0)
    return <p className="text-sm text-[var(--color-muted)]">{EMPTY_TICKETS}</p>;

  return (
    <div className="space-y-3">
      {tickets.map((t) => (
        <div key={t._id} className="rounded-lg border border-[var(--color-border)] p-3">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-[var(--color-muted)]">{t.slug}</span>
            <Chip tone={STATUS_TONE[t.status] ?? 'muted'}>{t.status}</Chip>
            {t.priority ? (
              <span className="text-xs text-[var(--color-warn)]">{t.priority}</span>
            ) : null}
          </div>
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">{t.title}</h3>
          <p className="mt-1 text-sm text-[var(--color-fg-2)]">{t.body}</p>
          {t.comments.length > 0 ? (
            <div className="mt-3 space-y-2 border-l-2 border-[var(--color-border-2)] pl-3">
              {t.comments.map((c, i) => (
                <p key={i} className="text-sm">
                  <span className="font-medium text-[var(--color-fg)]">{c.author}:</span>{' '}
                  <span className="text-[var(--color-fg-2)]">{c.body}</span>
                </p>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
