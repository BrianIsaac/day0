'use client';

import { usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Chip } from '../../../components/Chip';
import type { LinkedSource } from '../../../documentation/SourceTable';
import { clockTime } from '../../../components/time';

/** How many pages the table lists first, and adds on each "Show more". */
export const PAGES_AT_A_TIME = 25;

/** What `docPages.readState` answers for a source. */
type ReadState = FunctionReturnType<typeof api.docPages.readState>;

/**
 * The line over a source's page table: when its newest sync finished, and what it could not read.
 *
 * @param state - The source's read state; `null` before a sync has completed.
 * @param zone - The employee's zone.
 */
export function readStateLine(state: ReadState, zone: string | undefined): string {
  if (state === null) return 'No sync of this source has finished yet.';
  const finished = `Last sync finished ${clockTime(state.completedAt, zone)}.`;
  if (state.unreadCount === 0) return `${finished} It read every page it listed.`;
  const one = state.unreadCount === 1;
  const unread = `${one ? '1 page' : `${state.unreadCount} pages`} it listed could not be read; where an earlier version was stored, it is kept.`;
  const marked =
    state.unreadNamed < state.unreadCount
      ? `The first ${state.unreadNamed} are marked in the table.`
      : one
        ? 'It is marked in the table.'
        : 'Each is marked in the table.';
  return `${finished} ${unread} ${marked}`;
}

/**
 * One source's stored pages (round two section 3.9): each page's title, linked to where it lives
 * when the source gives an address, when the source last had it, and whether the newest sync
 * read it. Status by authority and who decided it wait on the documentation authority records
 * (A5), so the table draws neither.
 *
 * @param source - The source whose pages are listed.
 * @param zone - The employee's zone.
 */
export function PageTable({ source, zone }: { source: LinkedSource; zone?: string }) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.docPages.listForSource,
    { sourceId: source._id },
    { initialNumItems: PAGES_AT_A_TIME },
  );
  const state = useQuery(api.docPages.readState, { sourceId: source._id });
  // Every unread page is marked only when the run named all of them; otherwise an unmarked page
  // may be one it could not read, so the table does not call it read.
  // Before any sync has finished, no page has been read by one.
  const allNamed = state !== undefined && state !== null && state.unreadNamed >= state.unreadCount;
  return (
    <Card title={`Pages · ${source.label}`} meta={`${source.pageCount} stored`}>
      <div className="grid gap-3">
        <p className="text-sm text-[var(--color-fg-2)]">
          {state === undefined ? 'Loading' : readStateLine(state, zone)}
        </p>
        {status === 'LoadingFirstPage' ? (
          <p className="text-sm text-[var(--color-muted)]">Loading the pages</p>
        ) : results.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">No page of this source is stored yet.</p>
        ) : (
          <table role="table" className="w-full text-left text-sm max-sm:block">
            <thead role="rowgroup" className="max-sm:sr-only">
              <tr
                role="row"
                className="border-b border-[var(--color-border)] text-xs text-[var(--color-muted)]"
              >
                <th scope="col" role="columnheader" className="py-2.5 pr-3 font-medium">
                  Page
                </th>
                <th scope="col" role="columnheader" className="px-3 py-2.5 font-medium">
                  As of
                </th>
                <th scope="col" role="columnheader" className="py-2.5 pl-3 font-medium">
                  Last sync
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup" className="max-sm:grid max-sm:gap-3">
              {results.map((page) => (
                <tr
                  key={page._id}
                  role="row"
                  className="border-b border-[var(--color-border)] last:border-b-0 max-sm:grid max-sm:gap-1 max-sm:pb-3"
                >
                  <th
                    scope="row"
                    role="rowheader"
                    className="py-2.5 pr-3 text-left align-top font-normal max-sm:p-0"
                  >
                    {page.url ? (
                      <a href={page.url} target="_blank" rel="noreferrer" className="font-medium">
                        {page.title}
                      </a>
                    ) : (
                      <span className="font-medium text-[var(--color-fg)]">{page.title}</span>
                    )}
                    <span className="block font-mono text-xs break-all text-[var(--color-muted)]">
                      {page.ref}
                    </span>
                  </th>
                  <td
                    role="cell"
                    className="px-3 py-2.5 align-top whitespace-nowrap text-[var(--color-fg-2)] max-sm:p-0"
                  >
                    <span
                      aria-hidden="true"
                      className="text-xs text-[var(--color-muted)] sm:hidden"
                    >
                      As of{' '}
                    </span>
                    {clockTime(page.updatedAt, zone)}
                  </td>
                  <td role="cell" className="py-2.5 pl-3 align-top max-sm:p-0">
                    {page.unreadReason !== undefined ? (
                      <span className="grid justify-items-start gap-1">
                        <Chip tone="warn">Earlier version</Chip>
                        <span className="text-[13px] text-[var(--color-fg-2)]">
                          Not read: {page.unreadReason}
                        </span>
                      </span>
                    ) : allNamed ? (
                      <Chip tone="ok">Read</Chip>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {status === 'CanLoadMore' || status === 'LoadingMore' ? (
          <Button
            size="small"
            className="justify-self-start"
            disabled={status === 'LoadingMore'}
            onClick={() => loadMore(PAGES_AT_A_TIME)}
          >
            {status === 'LoadingMore' ? 'Loading…' : 'Show more pages'}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
