'use client';

import { useState, useMemo } from 'react';
import { usePaginatedQuery, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { Button } from '../../../components/Button';
import { Chip } from '../../../components/Chip';

/** How many documents the list reads first, and adds on each "Show more" (M17). */
export const DOCS_AT_A_TIME = 50;

/** A group heading of the documents' rail. */
const GROUP_HEADING =
  'mb-2 mt-1 text-xs font-semibold tracking-[0.06em] text-[var(--color-muted)] uppercase';

/** What an empty docs list means in each surface mode. */
export const EMPTY_DOCS: Record<'mock' | 'real', string> = {
  mock: 'No documents are seeded in this office yet.',
  real: 'No linked documentation is available yet. Link a source or check its sync status on /documentation; synced pages will appear here.',
};

/** What the Docs pane says while its documents load, in each surface mode. */
export const LOADING_DOCS: Record<'mock' | 'real', string> = {
  mock: 'Loading the office documents…',
  real: 'Loading linked documentation…',
};

/** What the page beside the list says while its body loads, and once it is gone. */
export const PAGE_STATES = {
  loading: 'Loading the page…',
  gone: 'This page is no longer available.',
} as const;

/**
 * The documents the employee reads, team documents then how-to guides, one open beside the list:
 * the office's wiki in mock mode, the linked documentation in real mode. The list is read a page
 * at a time without bodies, and only the open document is read whole (M17, R6).
 */
export function DocsTab({
  agentId,
  mode = 'mock',
}: {
  agentId: Id<'agents'>;
  mode?: 'mock' | 'real';
}) {
  const {
    results: docs,
    status,
    loadMore,
  } = usePaginatedQuery(api.mock.listDocs, { agentId }, { initialNumItems: DOCS_AT_A_TIME });
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

  const sortedDocs = useMemo(() => {
    return [...docs].sort((a, b) => {
      // team-doc before how-to-guide
      if (a.category !== b.category) return a.category === 'team-doc' ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
  }, [docs]);
  const sourceIds = useMemo(
    () => [...new Set(docs.flatMap((doc) => (doc.sourceId ? [doc.sourceId] : [])))],
    [docs],
  );
  const sources = useQuery(api.docSources.byIds, { sourceIds });
  const sourceLabels = useMemo(
    () => new Map((sources ?? []).map((source) => [source._id, source.label])),
    [sources],
  );

  const active = activeSlug ? sortedDocs.find((d) => d.slug === activeSlug) : sortedDocs[0];
  const page = useQuery(api.mock.getDoc, active ? { agentId, slug: active.slug } : 'skip');

  if (status === 'LoadingFirstPage')
    return <p className="text-sm text-[var(--color-muted)]">{LOADING_DOCS[mode]}</p>;
  if (sortedDocs.length === 0)
    return <p className="text-sm text-[var(--color-muted)]">{EMPTY_DOCS[mode]}</p>;

  return (
    // One column on a phone and in a narrow panel, the rail beside the page once the panel is
    // wide enough for both (as the Slack tab does). In the office's fixed panel the columns fill
    // it; in the real-mode card they bound themselves, so a short list ends the card and a long
    // page scrolls beside the list.
    <div
      className={`grid grid-cols-1 @lg:grid-cols-[12rem_1fr] @lg:grid-rows-[minmax(0,1fr)] gap-4 ${
        mode === 'real' ? '@lg:max-h-[32rem]' : 'h-full'
      }`}
    >
      <nav
        aria-label="Documents"
        className="min-w-0 border-[var(--color-border)] @lg:-mr-1 @lg:min-h-0 @lg:overflow-y-auto @lg:border-r @lg:pr-3"
      >
        <h3 className={GROUP_HEADING}>Team docs</h3>
        <ul className="space-y-1 text-sm">
          {sortedDocs
            .filter((d) => d.category === 'team-doc')
            .map((d) => (
              <li key={d._id}>
                <button
                  type="button"
                  onClick={() => setActiveSlug(d.slug)}
                  aria-current={active?.slug === d.slug ? 'true' : undefined}
                  className={`min-h-11 w-full rounded-lg px-2.5 py-1.5 text-left ${
                    active?.slug === d.slug
                      ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                      : 'text-[var(--color-fg-2)] hover:bg-[var(--color-inset)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  <span className="block text-xs text-[var(--color-muted)]">
                    {d.sourceId
                      ? sourceLabels.get(d.sourceId) || 'linked source'
                      : 'Demo docs (seeded)'}
                  </span>
                  {d.title}
                </button>
              </li>
            ))}
        </ul>
        <h3 className={`${GROUP_HEADING} mt-4`}>How-to guides</h3>
        <ul className="space-y-1 text-sm">
          {sortedDocs
            .filter((d) => d.category === 'how-to-guide')
            .map((d) => (
              <li key={d._id}>
                <button
                  type="button"
                  onClick={() => setActiveSlug(d.slug)}
                  aria-current={active?.slug === d.slug ? 'true' : undefined}
                  className={`min-h-11 w-full rounded-lg px-2.5 py-1.5 text-left ${
                    active?.slug === d.slug
                      ? 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]'
                      : 'text-[var(--color-fg-2)] hover:bg-[var(--color-inset)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  <span className="block text-xs text-[var(--color-muted)]">
                    {d.sourceId
                      ? sourceLabels.get(d.sourceId) || 'linked source'
                      : 'Demo docs (seeded)'}
                  </span>
                  {d.title}
                </button>
              </li>
            ))}
        </ul>
        {status === 'CanLoadMore' || status === 'LoadingMore' ? (
          <Button
            size="small"
            className="mt-4"
            disabled={status === 'LoadingMore'}
            onClick={() => loadMore(DOCS_AT_A_TIME)}
          >
            {status === 'LoadingMore' ? 'Loading…' : 'Show more documents'}
          </Button>
        ) : null}
      </nav>

      <article
        className="min-h-0 overflow-y-auto pr-2"
        tabIndex={0}
        aria-label={active ? `Page: ${active.title}` : 'Page'}
      >
        {active ? (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <h3 className="text-base font-semibold">{active.title}</h3>
              <Chip tone={active.category === 'how-to-guide' ? 'warn' : 'muted'}>
                {active.category === 'how-to-guide' ? 'How-to guide' : 'Team doc'}
              </Chip>
              {page?.sourceUrl ? (
                <a
                  href={page.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center text-sm"
                >
                  Open the source page
                </a>
              ) : null}
            </div>
            {page ? (
              <pre className="font-sans text-sm leading-relaxed whitespace-pre-wrap text-[var(--color-fg)]">
                {page.body}
              </pre>
            ) : (
              <p className="text-sm text-[var(--color-muted)]">
                {page === null ? PAGE_STATES.gone : PAGE_STATES.loading}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">Pick a document from the list.</p>
        )}
      </article>
    </div>
  );
}
