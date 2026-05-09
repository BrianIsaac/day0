'use client';

import { useState, useMemo, useEffect } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id, Doc } from '@convex/_generated/dataModel';

export function SpreadsheetTab({ agentId }: { agentId: Id<'agents'> }) {
  const sheets = useQuery(api.mock.listSpreadsheets, { agentId });
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string | null>(null);

  useEffect(() => {
    if (sheets && sheets.length > 0 && !activeSlug) {
      setActiveSlug(sheets[0].slug);
      setActiveTab(sheets[0].tabs[0]?.name ?? null);
    }
  }, [sheets, activeSlug]);

  const detail = useQuery(
    api.mock.getSpreadsheet,
    activeSlug ? { agentId, slug: activeSlug } : 'skip',
  );

  const sheet = detail?.sheet;
  const rows: Doc<'mockSpreadsheetRows'>[] = useMemo(() => detail?.rows ?? [], [detail]);

  const activeRows = useMemo(
    () => rows.filter((r) => r.tabName === activeTab),
    [rows, activeTab],
  );
  const activeTabSpec = useMemo(
    () => sheet?.tabs.find((t) => t.name === activeTab),
    [sheet, activeTab],
  );

  if (!sheets) return <div className="text-xs text-[var(--color-muted)]">loading spreadsheets…</div>;
  if (sheets.length === 0)
    return <div className="text-xs text-[var(--color-muted)]">no spreadsheets seeded</div>;

  return (
    <div className="space-y-3 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{sheet?.title ?? '…'}</h3>
          <p className="text-[10px] text-[var(--color-muted)]">slug: {activeSlug}</p>
        </div>
        <div className="flex gap-1">
          {sheets.map((s) => (
            <button
              key={s._id}
              onClick={() => {
                setActiveSlug(s.slug);
                setActiveTab(s.tabs[0]?.name ?? null);
              }}
              className={`text-[10px] px-2 py-1 rounded ${
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
        <div className="flex border-b border-[var(--color-border)] gap-1">
          {sheet.tabs.map((t) => (
            <button
              key={t.name}
              onClick={() => setActiveTab(t.name)}
              className={`text-xs px-3 py-1.5 border-b-2 -mb-px ${
                t.name === activeTab
                  ? 'border-[var(--color-accent)] text-[var(--color-fg)]'
                  : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)]'
              }`}
            >
              {t.name}
              <span className="ml-2 text-[9px] text-[var(--color-muted)]">
                {rows.filter((r) => r.tabName === t.name).length}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="overflow-auto rounded-md border border-[var(--color-border)] flex-1">
        <table className="w-full text-xs">
          <thead className="bg-[var(--color-bg)] sticky top-0">
            <tr>
              <th className="text-left px-3 py-2 font-medium text-[var(--color-muted)] uppercase tracking-wider text-[10px] w-8">
                #
              </th>
              {(activeTabSpec?.headers ?? []).map((h) => (
                <th
                  key={h}
                  className="text-left px-3 py-2 font-medium text-[var(--color-muted)] uppercase tracking-wider text-[10px]"
                >
                  {h}
                </th>
              ))}
              <th className="text-left px-3 py-2 font-medium text-[var(--color-muted)] uppercase tracking-wider text-[10px]">
                added by
              </th>
            </tr>
          </thead>
          <tbody>
            {activeRows.length === 0 ? (
              <tr>
                <td
                  colSpan={(activeTabSpec?.headers ?? []).length + 2}
                  className="text-center text-[var(--color-muted)] py-6 text-xs"
                >
                  no rows yet
                </td>
              </tr>
            ) : (
              activeRows.map((r, i) => (
                <tr
                  key={r._id}
                  className={`border-t border-[var(--color-border)] hover:bg-[var(--color-bg)] ${
                    r.addedBy?.includes('Day0')
                      ? 'bg-[var(--color-accent)]/5'
                      : ''
                  }`}
                >
                  <td className="px-3 py-1.5 text-[var(--color-muted)] font-mono">{i + 1}</td>
                  {(activeTabSpec?.headers ?? []).map((h) => (
                    <td key={h} className="px-3 py-1.5 text-[var(--color-fg)]">
                      {(r.cells as Record<string, string>)[h] ?? ''}
                    </td>
                  ))}
                  <td className="px-3 py-1.5 text-[10px] text-[var(--color-muted)]">
                    {r.addedBy ?? '—'}
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
