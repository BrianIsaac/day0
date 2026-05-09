'use client';

import { useState, useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

export function DocsTab({ agentId }: { agentId: Id<'agents'> }) {
  const docs = useQuery(api.mock.listDocs, { agentId });
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

  const sortedDocs = useMemo(() => {
    if (!docs) return [];
    return [...docs].sort((a, b) => {
      // team-doc before how-to-guide
      if (a.category !== b.category) return a.category === 'team-doc' ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
  }, [docs]);

  const active = activeSlug
    ? sortedDocs.find((d) => d.slug === activeSlug)
    : sortedDocs[0];

  if (!docs) return <div className="text-xs text-[var(--color-muted)]">loading docs…</div>;
  if (sortedDocs.length === 0)
    return <div className="text-xs text-[var(--color-muted)]">no docs yet — seed first</div>;

  return (
    <div className="grid grid-cols-[12rem_1fr] gap-4 h-full">
      <aside className="border-r border-[var(--color-border)] pr-3 -mr-1 overflow-y-auto">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-muted)] mb-2 mt-1">
          Team docs
        </div>
        <ul className="space-y-1 text-xs">
          {sortedDocs
            .filter((d) => d.category === 'team-doc')
            .map((d) => (
              <li key={d._id}>
                <button
                  onClick={() => setActiveSlug(d.slug)}
                  className={`w-full text-left px-2 py-1 rounded ${
                    active?.slug === d.slug
                      ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                      : 'text-[var(--color-fg)] hover:bg-[var(--color-bg)]'
                  }`}
                >
                  {d.title}
                </button>
              </li>
            ))}
        </ul>
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-muted)] mb-2 mt-4">
          How-to guides
        </div>
        <ul className="space-y-1 text-xs">
          {sortedDocs
            .filter((d) => d.category === 'how-to-guide')
            .map((d) => (
              <li key={d._id}>
                <button
                  onClick={() => setActiveSlug(d.slug)}
                  className={`w-full text-left px-2 py-1 rounded ${
                    active?.slug === d.slug
                      ? 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]'
                      : 'text-[var(--color-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg)]'
                  }`}
                >
                  {d.title}
                </button>
              </li>
            ))}
        </ul>
      </aside>

      <article className="overflow-y-auto pr-2">
        {active ? (
          <>
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-base font-semibold">{active.title}</h3>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded ${
                  active.category === 'how-to-guide'
                    ? 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]'
                    : 'bg-[var(--color-muted)]/15 text-[var(--color-muted)]'
                }`}
              >
                {active.category === 'how-to-guide' ? 'agent-readable' : 'team doc'}
              </span>
            </div>
            <pre className="text-xs whitespace-pre-wrap font-sans leading-relaxed text-[var(--color-fg)]">
              {active.body}
            </pre>
          </>
        ) : (
          <div className="text-xs text-[var(--color-muted)]">pick a doc</div>
        )}
      </article>
    </div>
  );
}
