'use client';

import { useState, useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id, Doc } from '@convex/_generated/dataModel';

/** What an empty sheet list means. The tab is mock-only: real mode does not
 * render it, so it has no real-mode copy to show. */
export const EMPTY_SPREADSHEETS = 'No spreadsheets are seeded in this office.';

/** The heading classes of the sheet's columns. */
const COLUMN_HEADING =
  'px-3 py-2 text-left text-xs font-semibold tracking-[0.06em] text-[var(--color-muted)] uppercase';

/**
 * The office's spreadsheets: one sheet at a time, its tabs, and the rows of the open tab, those the
 * employee added marked as its own.
 */
export function SpreadsheetTab({ agentId }: { agentId: Id<'agents'> }) {
  const sheets = useQuery(api.mock.listSpreadsheets, { agentId });
  // Nothing picked yet falls through to the first sheet and its first tab, so
  // the selection is derived rather than back-filled once the query lands.
  const [pickedSlug, setPickedSlug] = useState<string | null>(null);
  const [pickedTab, setPickedTab] = useState<string | null>(null);
  const activeSlug = pickedSlug ?? sheets?.[0]?.slug ?? null;

  const detail = useQuery(
    api.mock.getSpreadsheet,
    activeSlug ? { agentId, slug: activeSlug } : 'skip',
  );

  const sheet = detail?.sheet;
  const activeTab = pickedTab ?? sheet?.tabs[0]?.name ?? null;
  const rows: Doc<'mockSpreadsheetRows'>[] = useMemo(() => detail?.rows ?? [], [detail]);

  const activeRows = useMemo(() => rows.filter((r) => r.tabName === activeTab), [rows, activeTab]);
  const activeTabSpec = useMemo(
    () => sheet?.tabs.find((t) => t.name === activeTab),
    [sheet, activeTab],
  );

  if (!sheets)
    return <p className="text-sm text-[var(--color-muted)]">Loading the spreadsheets…</p>;
  if (sheets.length === 0)
    return <p className="text-sm text-[var(--color-muted)]">{EMPTY_SPREADSHEETS}</p>;

  return (
    <div className="space-y-3 h-full flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">{sheet?.title ?? '…'}</h3>
          <p className="font-mono text-xs text-[var(--color-muted)]">{activeSlug}</p>
        </div>
        <div className="flex flex-wrap gap-1">
          {sheets.map((s) => (
            <button
              key={s._id}
              type="button"
              aria-pressed={s.slug === activeSlug}
              onClick={() => {
                setPickedSlug(s.slug);
                setPickedTab(null);
              }}
              className={`min-h-11 rounded-lg px-3 py-1 text-sm ${
                s.slug === activeSlug
                  ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]'
                  : 'text-[var(--color-muted)] hover:text-[var(--color-fg)]'
              }`}
            >
              {s.title}
            </button>
          ))}
        </div>
      </div>

      {sheet ? (
        <div className="flex flex-wrap border-b border-[var(--color-border)] gap-1">
          {sheet.tabs.map((t) => (
            <button
              key={t.name}
              type="button"
              aria-pressed={t.name === activeTab}
              onClick={() => setPickedTab(t.name)}
              className={`-mb-px min-h-11 border-b-2 px-3 py-1.5 text-sm ${
                t.name === activeTab
                  ? 'border-[var(--color-accent)] text-[var(--color-fg)]'
                  : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)]'
              }`}
            >
              {t.name}
              <span className="ml-2 text-xs text-[var(--color-muted)] tabular-nums">
                {rows.filter((r) => r.tabName === t.name).length}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div
        tabIndex={0}
        role="region"
        aria-label={`${sheet?.title ?? 'Sheet'}${activeTab ? `, ${activeTab}` : ''}`}
        className="overflow-auto rounded-md border border-[var(--color-border)] flex-1"
      >
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] sticky top-0">
            <tr>
              <th scope="col" className={`${COLUMN_HEADING} w-8`}>
                #
              </th>
              {(activeTabSpec?.headers ?? []).map((h) => (
                <th key={h} scope="col" className={COLUMN_HEADING}>
                  {h}
                </th>
              ))}
              <th scope="col" className={COLUMN_HEADING}>
                added by
              </th>
            </tr>
          </thead>
          <tbody>
            {activeRows.length === 0 ? (
              <tr>
                <td
                  colSpan={(activeTabSpec?.headers ?? []).length + 2}
                  className="py-6 text-center text-sm text-[var(--color-muted)]"
                >
                  No rows in this tab yet.
                </td>
              </tr>
            ) : (
              activeRows.map((r, i) => (
                <tr
                  key={r._id}
                  className={`border-t border-[var(--color-border)] hover:bg-[var(--color-bg)] ${
                    r.addedBy?.includes('Day0') ? 'bg-[var(--color-accent)]/5' : ''
                  }`}
                >
                  <td className="px-3 py-1.5 text-[var(--color-muted)] font-mono">{i + 1}</td>
                  {(activeTabSpec?.headers ?? []).map((h) => (
                    <td key={h} className="px-3 py-1.5 text-[var(--color-fg)]">
                      {(r.cells as Record<string, string>)[h] ?? ''}
                    </td>
                  ))}
                  <td className="px-3 py-1.5 text-xs text-[var(--color-muted)]">
                    {r.addedBy ?? ''}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
