'use client';

import { useRef, useState } from 'react';
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Chip } from '../../../components/Chip';
import { INPUT_CLASS } from '../../../components/Field';
import { StatusRegion } from '../../../components/StatusRegion';
import type { Tone } from '../../../components/tone';
import type { LinkedSource } from '../../../documentation/SourceTable';
import { clockTime } from '../../../components/time';
import { useChange, type Change } from '../../../components/use-change';

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

/** One stored page as `docPages.listForSource` lists it. */
type PageRow = FunctionReturnType<typeof api.docPages.listForSource>['page'][number];

/** A page's status as its chip says it, and the chip's tone. */
const STATUS_CHIP: Readonly<Record<PageRow['status'], { text: string; tone: Tone }>> = {
  active: { text: 'Active', tone: 'ok' },
  draft: { text: 'Draft', tone: 'muted' },
  superseded: { text: 'Superseded', tone: 'warn' },
  archived: { text: 'Archived', tone: 'muted' },
};

/**
 * A page's status chip: "Possibly superseded" for a current page a relation still to answer
 * proposes another in place of, else its status.
 *
 * @param page - The page's row.
 */
export function statusChip(page: Pick<PageRow, 'status' | 'possiblySuperseded'>): {
  text: string;
  tone: Tone;
} {
  return page.possiblySuperseded === true
    ? { text: 'Possibly superseded', tone: 'warn' }
    : STATUS_CHIP[page.status];
}

/**
 * Who or what decided a page's status, in the column's words (the wave file's section 8): "you,
 * 26 Sep 2026, 09:10", "the source", "a marker in the page", "relation, above", "default". A
 * status an earlier manager gave by hand names that manager's address.
 *
 * @param page - The page's row.
 * @param zone - The employee's zone.
 */
export function decidedByWords(page: PageRow, zone: string | undefined): string {
  if (page.possiblySuperseded === true) return 'relation, above';
  switch (page.statusSource) {
    case 'manager': {
      const who = page.decidedByYou === false ? (page.decidedBy ?? 'an earlier manager') : 'you';
      return page.decidedAt === undefined ? who : `${who}, ${clockTime(page.decidedAt, zone)}`;
    }
    case 'source-native':
      return 'the source';
    case 'marker':
      return 'a marker in the page';
    case 'relation':
      return 'a relation you confirmed';
    case 'default':
      return 'default';
  }
}

/**
 * One page's own controls (the wave file's section 8): "Mark superseded by ..." with the page
 * that takes its place, "Mark archived", "This is a draft", and "Clear", back to what the page
 * and its source say, for a status the manager gave by hand.
 *
 * @param page - The page.
 * @param others - The other pages listed, any of which may be named as its successor.
 * @param change - The table's change reporter, shared so one live region says every outcome.
 */
function PageControls({
  page,
  others,
  change,
}: {
  page: PageRow;
  others: readonly PageRow[];
  change: Change;
}) {
  const setStatus = useMutation(api.docStatus.setPageStatus);
  const clear = useMutation(api.docStatus.clearPageStatus);
  const [successor, setSuccessor] = useState<Id<'docPages'> | ''>('');
  const picker = `successor-${page._id}`;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="grid gap-1">
        <label htmlFor={picker} className="text-xs text-[var(--color-muted)]">
          Mark “{page.title}” superseded by
        </label>
        <span className="flex flex-wrap gap-2">
          <select
            id={picker}
            value={successor}
            onChange={(event) => setSuccessor(event.target.value as Id<'docPages'> | '')}
            className={`${INPUT_CLASS} max-w-full`}
          >
            <option value="">Choose a page</option>
            {others.map((other) => (
              <option key={other._id} value={other._id}>
                {other.title}
              </option>
            ))}
          </select>
          <Button
            size="small"
            disabled={change.busy || successor === ''}
            aria-label={`Mark ${page.title} superseded by the chosen page`}
            onClick={() => {
              if (successor === '') return;
              change.run(
                () =>
                  setStatus({ pageId: page._id, status: 'superseded', supersededBy: successor }),
                {
                  done: `“${page.title}” is superseded.`,
                  refused: 'The page was not marked superseded.',
                  after: () => setSuccessor(''),
                },
              );
            }}
          >
            Mark superseded
          </Button>
        </span>
      </div>
      <Button
        size="small"
        disabled={change.busy}
        aria-label={`Mark ${page.title} archived`}
        onClick={() =>
          change.run(() => setStatus({ pageId: page._id, status: 'archived' }), {
            done: `“${page.title}” is archived.`,
            refused: 'The page was not archived.',
          })
        }
      >
        Mark archived
      </Button>
      <Button
        size="small"
        disabled={change.busy}
        aria-label={`${page.title} is a draft`}
        onClick={() =>
          change.run(() => setStatus({ pageId: page._id, status: 'draft' }), {
            done: `“${page.title}” is a draft.`,
            refused: 'The page was not marked a draft.',
          })
        }
      >
        This is a draft
      </Button>
      {page.statusSource === 'manager' ? (
        <Button
          size="small"
          variant="quiet"
          disabled={change.busy}
          aria-label={`Clear your status for ${page.title}`}
          onClick={() =>
            change.run(() => clear({ pageId: page._id }), {
              done: `“${page.title}” is back to what the page and its source say.`,
              refused: 'The status was not cleared.',
            })
          }
        >
          Clear
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One source's stored pages (round two section 3.9): each page's title, linked to where it lives
 * when the source gives an address; its status and who or what decided it (A5); when the source
 * last had it; whether the newest sync read it; and, on a line of its own, the manager's controls
 * for its status.
 *
 * @param source - The source whose pages are listed.
 * @param zone - The employee's zone.
 */
export function PageTable({ source, zone }: { source: LinkedSource; zone?: string }) {
  const table = useRef<HTMLDivElement>(null);
  const change = useChange(table);
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
      <div ref={table} tabIndex={-1} aria-label={`Pages of ${source.label}`} className="grid gap-3">
        <p className="text-sm text-[var(--color-fg-2)]">
          {state === undefined ? 'Loading' : readStateLine(state, zone)}
        </p>
        <StatusRegion outcome={change.outcome} />
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
                  Status
                </th>
                <th scope="col" role="columnheader" className="px-3 py-2.5 font-medium">
                  Decided by
                </th>
                <th scope="col" role="columnheader" className="px-3 py-2.5 font-medium">
                  As of
                </th>
                <th scope="col" role="columnheader" className="py-2.5 pl-3 font-medium">
                  Last sync
                </th>
              </tr>
            </thead>
            {results.map((page) => (
              // One group a page: its facts, then its controls on a line of their own.
              <tbody
                key={page._id}
                role="rowgroup"
                className="border-b border-[var(--color-border)] last:border-b-0 max-sm:grid max-sm:gap-2 max-sm:py-3"
              >
                <tr role="row" className="max-sm:grid max-sm:gap-1">
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
                    {page.supersededBy !== undefined ? (
                      <span className="block text-[13px] text-[var(--color-fg-2)]">
                        Superseded by “{page.supersededBy}”
                      </span>
                    ) : null}
                  </th>
                  <td role="cell" className="px-3 py-2.5 align-top max-sm:p-0">
                    <Chip tone={statusChip(page).tone}>{statusChip(page).text}</Chip>
                  </td>
                  <td
                    role="cell"
                    className="px-3 py-2.5 align-top text-[var(--color-muted)] max-sm:p-0"
                  >
                    <span
                      aria-hidden="true"
                      className="text-xs text-[var(--color-muted)] sm:hidden"
                    >
                      Decided by{' '}
                    </span>
                    {decidedByWords(page, zone)}
                  </td>
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
                <tr role="row" className="max-sm:block">
                  <td role="cell" colSpan={5} className="pb-3 max-sm:block max-sm:p-0">
                    <PageControls
                      page={page}
                      others={results.filter((other) => other._id !== page._id)}
                      change={change}
                    />
                  </td>
                </tr>
              </tbody>
            ))}
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
