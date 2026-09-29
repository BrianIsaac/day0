'use client';

import { usePaginatedQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import type { RecordEntry, RecordFilter } from '@/events/record-filters';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Disclosure } from '../../../components/Disclosure';
import { RecordLine } from '../../../components/RecordLine';
import { recordKindOf } from '../event-labels';
import { clockTime, useAgentZone } from '../time';
import { recordWords } from './record-words';

/** How many lines the record shows at first, and how many more each Show older adds. */
export const RECORD_PAGE = 50;

/** What the manager can narrow the record to: all of it, or one filter. */
export type RecordView = 'all' | RecordFilter;

/** The filter chips, in the order they are drawn, each with its label. */
export const RECORD_CHIPS: ReadonlyArray<{ readonly view: RecordView; readonly label: string }> = [
  { view: 'all', label: 'All' },
  { view: 'writes', label: 'Writes' },
  { view: 'decisions', label: 'Your decisions' },
  { view: 'reads', label: 'Reads' },
  { view: 'refused', label: 'Refused and withheld' },
  { view: 'charter', label: 'Charter' },
];

/**
 * The stored event as its payload disclosure shows it: the id, the type, the instant and the
 * payload, which is what the export carries for the row before its redaction.
 */
function payloadText(entry: RecordEntry): string {
  const { event } = entry;
  return JSON.stringify(
    {
      id: event._id,
      type: event.type,
      at: new Date(event.createdAt).toISOString(),
      payload: event.payload ?? null,
    },
    null,
    2,
  );
}

/**
 * The filter chips: one pressed at a time, the record redrawn under it.
 *
 * @param selected - The filter shown now.
 * @param onSelect - Shows another.
 */
export function RecordFilters({
  selected,
  onSelect,
}: {
  selected: RecordView;
  onSelect: (view: RecordView) => void;
}) {
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

/**
 * Every event of the employee's record in plain words, newest first, each with a dot for what it
 * did, its time in the employee's zone, and the stored event one disclosure away. The record is
 * paged: it shows the newest lines and Show older adds more until the first event is reached.
 *
 * @param agentId - The employee whose record this is.
 * @param name - The employee's name, as each sentence says it.
 * @param view - The filter the record is shown under.
 */
export function RecordList({
  agentId,
  name,
  view,
}: {
  agentId: Id<'agents'>;
  name: string;
  view: RecordView;
}) {
  const zone = useAgentZone();
  const { results, status, loadMore } = usePaginatedQuery(
    api.events.record,
    view === 'all' ? { agentId } : { agentId, filter: view },
    { initialNumItems: RECORD_PAGE },
  );
  const label = RECORD_CHIPS.find((chip) => chip.view === view)?.label ?? 'All';
  return (
    <Card title="Every event" meta={view === 'all' ? 'newest first' : `${label}, newest first`}>
      {status === 'LoadingFirstPage' ? (
        <p className="text-sm text-[var(--color-muted)]">Loading the record</p>
      ) : results.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          {view === 'all'
            ? 'Nothing recorded yet.'
            : `Nothing recorded under ${label.toLowerCase()} yet.`}
        </p>
      ) : (
        <ol aria-label="The record, newest first" className="grid gap-3">
          {results.map((entry) => (
            <RecordLine
              key={entry.event._id}
              kind={recordKindOf(entry.event)}
              time={{ at: entry.event.createdAt, label: clockTime(entry.event.createdAt, zone) }}
            >
              {recordWords(entry.event, {
                name,
                ...(entry.itemTitle !== undefined ? { item: entry.itemTitle } : {}),
              })}
              <Disclosure summary="Payload">
                <pre
                  tabIndex={0}
                  aria-label={`Payload of ${entry.event.type}`}
                  className="max-h-64 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-inset)] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-[var(--color-fg-2)]"
                >
                  {payloadText(entry)}
                </pre>
              </Disclosure>
            </RecordLine>
          ))}
        </ol>
      )}
      {status === 'CanLoadMore' || status === 'LoadingMore' ? (
        <div className="mt-4">
          <Button
            size="small"
            disabled={status === 'LoadingMore'}
            onClick={() => loadMore(RECORD_PAGE)}
          >
            {status === 'LoadingMore' ? 'Loading older lines' : 'Show older'}
          </Button>
        </div>
      ) : status === 'Exhausted' && results.length > 0 ? (
        <p className="mt-4 text-[13px] text-[var(--color-muted)]">
          {view === 'all' ? 'That is the whole record.' : `That is all of ${label.toLowerCase()}.`}
        </p>
      ) : null}
    </Card>
  );
}
