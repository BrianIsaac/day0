'use client';

import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

const STATUS_TONE: Record<string, string> = {
  open: 'bg-[var(--color-muted)]/20 text-[var(--color-muted)]',
  'in-progress': 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]',
  blocked: 'bg-[var(--color-warn)]/20 text-[var(--color-warn)]',
  done: 'bg-[var(--color-ok)]/20 text-[var(--color-ok)]',
};

export function TicketsTab({ agentId }: { agentId: Id<'agents'> }) {
  const tickets = useQuery(api.mock.listTickets, { agentId });

  if (!tickets) return <div className="text-xs text-[var(--color-muted)]">loading…</div>;
  if (tickets.length === 0)
    return <div className="text-xs text-[var(--color-muted)]">no tickets seeded</div>;

  return (
    <div className="space-y-3">
      {tickets.map((t) => (
        <div key={t._id} className="border border-[var(--color-border)] rounded-md p-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-[10px] text-[var(--color-muted)]">{t.slug}</span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_TONE[t.status] ?? ''}`}
            >
              {t.status}
            </span>
            {t.priority ? (
              <span className="text-[10px] text-[var(--color-warn)]">{t.priority}</span>
            ) : null}
          </div>
          <h4 className="text-sm font-medium text-[var(--color-fg)]">{t.title}</h4>
          <p className="text-xs text-[var(--color-muted)] mt-1">{t.body}</p>
          {t.comments.length > 0 ? (
            <div className="mt-3 space-y-2 pl-3 border-l border-[var(--color-border)]">
              {t.comments.map((c, i) => (
                <div key={i} className="text-xs">
                  <span className="font-medium text-[var(--color-fg)]">{c.author}:</span>{' '}
                  <span className="text-[var(--color-muted)]">{c.body}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
