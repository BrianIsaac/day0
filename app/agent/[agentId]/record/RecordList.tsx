'use client';

import { useEffect, useRef } from 'react';
import { usePaginatedQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import type { RecordEntry, RecordFilter } from '@/events/record-filters';
import { redactTokenShapes } from '@/surfaces/redact';
import { CREDENTIAL_VALUE_REDACTION, isCredentialKey } from '@/lib/credential-keys';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { RecordLine } from '../../../components/RecordLine';
import { recordKindOf } from '../event-labels';
import { clockTime, useAgentZone } from '../../../components/time';
import { recordWords } from './record-words';
import { managerAt, type EarlierManager, type ManagerAt } from '../earlier-manager';

/** How many lines the record shows at first, and how many more each Show older adds. */
export const RECORD_PAGE = 50;

/** What the manager can narrow the record to: all of it, or one filter. */
export type RecordView = 'all' | RecordFilter;

/** A filter chip: what it shows, its label, and what the record says when it has nothing more. */
interface RecordChip {
  readonly view: RecordView;
  readonly label: string;
  /** Said when nothing at all is recorded under the chip. */
  readonly empty: string;
  /** Said under the last line, once the record has no more. */
  readonly end: string;
}

/** The filter chips, in the order they are drawn. */
export const RECORD_CHIPS: readonly RecordChip[] = [
  { view: 'all', label: 'All', empty: 'Nothing recorded yet.', end: 'That is the whole record.' },
  {
    view: 'writes',
    label: 'Writes',
    empty: 'No writes recorded yet.',
    end: 'That is every write.',
  },
  {
    // Every manager's decisions: after a handover the filter lists the earlier manager's too,
    // each line naming who decided (decision 5), so the label is not the reader's alone.
    view: 'decisions',
    label: 'Manager decisions',
    empty: 'No manager decisions recorded yet.',
    end: 'That is every manager decision.',
  },
  { view: 'reads', label: 'Reads', empty: 'No reads recorded yet.', end: 'That is every read.' },
  {
    view: 'refused',
    label: 'Refused and withheld',
    empty: 'Nothing refused or withheld yet.',
    end: 'That is everything refused or withheld.',
  },
  {
    view: 'charter',
    label: 'Charter',
    empty: 'Nothing recorded about the charter yet.',
    end: "That is the charter's whole history.",
  },
];

/**
 * A payload as a line read on a screen shows it: every value under a credential-class key name
 * blanked (m30), and every other string with its structural secrets replaced.
 */
function shownPayload(value: unknown): unknown {
  if (typeof value === 'string') return redactTokenShapes(value);
  if (Array.isArray(value)) return value.map(shownPayload);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        isCredentialKey(key) ? CREDENTIAL_VALUE_REDACTION : shownPayload(entry),
      ]),
    );
  }
  return value;
}

/**
 * A payload as an event from before a handover shows it to the new manager: an adoption's author
 * was the earlier manager's colleague, named on the line as one (decision 4), so the name is not
 * shown beneath it either.
 */
function withoutEarlierColleague(payload: unknown, manager: ManagerAt): unknown {
  if (manager.kind === 'reader' || payload === null || typeof payload !== 'object') return payload;
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).filter(([key]) => key !== 'authorName'),
  );
}

/**
 * The stored event as its payload disclosure shows it: the id, the type, the instant and the
 * payload with its credential shapes taken out, as a screen may be shared.
 */
function payloadText(entry: RecordEntry, manager: ManagerAt): string {
  const { event } = entry;
  return JSON.stringify(
    {
      id: event._id,
      type: event.type,
      at: new Date(event.createdAt).toISOString(),
      payload: shownPayload(withoutEarlierColleague(event.payload ?? null, manager)),
    },
    null,
    2,
  );
}

/** The record's filter chips: the one selected, and what a press on one does. */
export interface RecordFiltersProps {
  readonly selected: RecordView;
  readonly onSelect: (view: RecordView) => void;
}

/**
 * The filter chips: one pressed at a time, the record redrawn under it.
 *
 * @param selected - The filter shown now.
 * @param onSelect - Shows another.
 */
export function RecordFilters({ selected, onSelect }: RecordFiltersProps) {
  return (
    <div role="group" aria-label="Show in the record" className="flex flex-wrap gap-1.5">
      {RECORD_CHIPS.map((chip) => {
        const pressed = chip.view === selected;
        return (
          <button
            key={chip.view}
            type="button"
            aria-pressed={pressed}
            onClick={() => onSelect(chip.view)}
            className={`inline-flex min-h-11 items-center rounded-full border px-3.5 text-[13px] transition-colors motion-reduce:transition-none ${
              pressed
                ? 'border-[var(--color-accent-line)] bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-fg-2)] hover:border-[var(--color-border-2)] hover:text-[var(--color-fg)]'
            }`}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}

/** Who reads the record, and the handovers that brought the employee to them. */
export interface RecordManagers {
  /** The reader's address: the employee's manager now. */
  readonly reader: string;
  /** The employee's accepted handovers, oldest first (`managerTransfers.earlierManagers`). */
  readonly earlier: readonly EarlierManager[];
}

/** What the record's list of events is read for. */
export interface RecordListProps {
  readonly agentId: Id<'agents'>;
  readonly name: string;
  readonly view: RecordView;
  /**
   * Who reads it and the handovers before them, so a line from an earlier manager's time names
   * that manager (decision 5); undefined while they load, when no line is drawn, since a line
   * drawn first would say "You" for a decision the reader never made.
   */
  readonly managers: RecordManagers | undefined;
}

/**
 * Every event of the employee's record in plain words, newest first, each with a dot for what it
 * did, its time in the employee's zone, and the stored event one disclosure away. The record is
 * paged: it shows the newest lines and Show older adds more until the first event is reached.
 *
 * @param agentId - The employee whose record this is.
 * @param name - The employee's name, as each sentence says it.
 * @param view - The filter the record is shown under.
 * @param managers - The reader and the handovers before them; undefined while they load.
 */
export function RecordList({ agentId, name, view, managers }: RecordListProps) {
  const zone = useAgentZone();
  const { results, status, loadMore } = usePaginatedQuery(
    api.events.record,
    view === 'all' ? { agentId } : { agentId, filter: view },
    { initialNumItems: RECORD_PAGE },
  );
  const chip = RECORD_CHIPS.find((candidate) => candidate.view === view) ?? RECORD_CHIPS[0]!;
  const card = useRef<HTMLElement>(null);
  const askedForMore = useRef(false);
  // Show older leaves the page with the last of the record; the card, not the
  // body, takes the focus it held.
  useEffect(() => {
    // The ask is answered by the first status after the load, whichever it is: a page with more
    // behind it keeps the button, and a later chip's first page is not the answer to it.
    if (!askedForMore.current || status === 'LoadingMore') return;
    askedForMore.current = false;
    if (status !== 'Exhausted') return;
    const active = document.activeElement;
    if (active === null || active === document.body) card.current?.focus();
  }, [status]);
  const loadingMore = status === 'LoadingMore';
  return (
    <Card
      title="Every event"
      meta={view === 'all' ? 'newest first' : `${chip.label}, newest first`}
      focusRef={card}
    >
      {status === 'LoadingFirstPage' || managers === undefined ? (
        <p className="text-sm text-[var(--color-muted)]">Loading the record</p>
      ) : results.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          {status === 'Exhausted'
            ? chip.empty
            : 'Nothing under this filter among the newest events; Show older looks further back.'}
        </p>
      ) : (
        <ol aria-label="The record, newest first" className="grid gap-3">
          {results.map((entry) => {
            const manager = managerAt(entry.event.createdAt, managers.earlier, managers.reader);
            return (
              <RecordLine
                key={entry.event._id}
                kind={recordKindOf(entry.event)}
                time={{ at: entry.event.createdAt, label: clockTime(entry.event.createdAt, zone) }}
              >
                {recordWords(entry.event, {
                  name,
                  ...(entry.itemTitle !== undefined ? { item: entry.itemTitle } : {}),
                  ...(entry.connection !== undefined ? { connection: entry.connection } : {}),
                  manager,
                  reader: managers.reader,
                })}{' '}
                <details className="group/payload inline">
                  <summary className="relative -my-3 inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 align-middle text-[13px] text-[var(--color-muted)] hover:text-[var(--color-fg)] [&::-webkit-details-marker]:hidden">
                    <span
                      aria-hidden="true"
                      className="inline-block size-[6px] -rotate-45 border-r-[1.5px] border-b-[1.5px] border-current transition-transform duration-[180ms] ease-out group-open/payload:rotate-45 motion-reduce:transition-none"
                    />
                    Payload
                  </summary>
                  <pre
                    tabIndex={0}
                    aria-label={`Payload of ${entry.event.type}`}
                    className="mb-1 max-h-64 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-inset)] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-[var(--color-fg-2)]"
                  >
                    {payloadText(entry, manager)}
                  </pre>
                </details>
              </RecordLine>
            );
          })}
        </ol>
      )}
      {managers === undefined ? null : status === 'CanLoadMore' || loadingMore ? (
        <div className="mt-4">
          {/* Not disabled while loading: a disabled button drops the focus it holds. */}
          <Button
            size="small"
            aria-disabled={loadingMore}
            onClick={() => {
              if (loadingMore) return;
              askedForMore.current = true;
              loadMore(RECORD_PAGE);
            }}
          >
            {loadingMore ? 'Loading older lines' : 'Show older'}
          </Button>
        </div>
      ) : status === 'Exhausted' && results.length > 0 ? (
        <p className="mt-4 text-[13px] text-[var(--color-muted)]">{chip.end}</p>
      ) : null}
    </Card>
  );
}
