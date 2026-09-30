'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Doc } from '@convex/_generated/dataModel';
import type { AgentMetrics } from '@/metrics/types';
import { decidedCount, formatMetricDuration } from '../../metric-format';
import { Card } from '../../components/Card';
import { RecordLine } from '../../components/RecordLine';
import { useEmployee } from './employee-context';
import { employeeTabHref } from './employee-tabs';
import { eventItemTitle, eventLabel, recordKindOf } from './event-labels';
import { connectedManagerChannel } from './manager-channel';
import { clockTime, useAgentZone, useNow } from '../../components/time';

/** How many of the newest events the rail's record lists. */
export const RAIL_RECORD_LINES = 5;

/** The events the page reads, shared by the rail and the Record tab so both read one query. */
export const RECENT_EVENTS = 30;

/** The figures the rail prints, from the employee's supervision figures. */
export function railFigures(
  metrics: AgentMetrics,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  const { approved, rejected, partiallyApproved, medianLatencyMs } = metrics.decisions;
  const decided = decidedCount(metrics.decisions);
  // A partial approval is one of the approvals, not a decision of its own.
  const inPart = partiallyApproved > 0 ? `, ${partiallyApproved} of them in part` : '';
  return [
    {
      label: 'Decisions',
      value:
        decided === 0
          ? 'none yet'
          : `${decided} by you (${approved} approved${inPart}, ${rejected} rejected)`,
    },
    { label: 'Median wait', value: formatMetricDuration(medianLatencyMs) },
    { label: 'Held', value: String(metrics.actions.held) },
    { label: 'Refused', value: String(metrics.actions.refused) },
  ];
}

/** What the newest lines of the record are drawn from. */
export interface RecordLinesProps {
  readonly events: readonly Doc<'events'>[];
  readonly titles: ReadonlyMap<string, string>;
  readonly lines: number;
}

/**
 * The newest events as record lines: a dot for what happened, the event in words with the work
 * item it is about, and its time in the employee's zone.
 *
 * @param events - The newest events, newest first.
 * @param titles - The employee's work item titles by id.
 * @param lines - How many to list.
 */
export function RecordLines({ events, titles, lines }: RecordLinesProps) {
  const zone = useAgentZone();
  return (
    <ul className="grid gap-1.5">
      {events.slice(0, lines).map((event) => {
        const label = eventLabel(event);
        const title = eventItemTitle(event, titles);
        return (
          <RecordLine
            key={event._id}
            kind={recordKindOf(event)}
            time={{ at: event.createdAt, label: clockTime(event.createdAt, zone) }}
          >
            {label}
            {/* A label that names the item already (new work) is not followed by it again. */}
            {title && !label.includes(title) ? ` · ${title}` : null}
          </RecordLine>
        );
      })}
    </ul>
  );
}

/**
 * The employee page's aside (round two section 3.6): the figures so far, the newest lines of the
 * record, and where decisions reach the manager. Each tab that draws the aside puts it beside its
 * own column; a tab with an aside of its own (the charter's versions) draws that instead.
 */
export function EmployeeRail() {
  const { agent, surfaceMode, surfaces } = useEmployee();
  const agentId = agent._id;
  const metrics = useQuery(api.metrics.forAgent, { agentId });
  const events = useQuery(api.events.recent, { agentId, limit: RECENT_EVENTS });
  const workItems = useQuery(api.work.listForAgent, { agentId });
  const now = useNow();
  const titles = useMemo(
    (): Map<string, string> => new Map((workItems ?? []).map((item) => [item._id, item.title])),
    [workItems],
  );
  const channel = surfaceMode === 'real' && connectedManagerChannel(surfaces, now) !== undefined;
  return (
    <>
      <Card title="So far" meta="counts, not rates">
        {metrics === undefined ? (
          <p className="text-sm text-[var(--color-muted)]">Loading the figures</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-y-1.5">
            {railFigures(metrics).map((figure) => (
              <div key={figure.label} className="contents">
                <dt className="mt-2 text-[var(--color-muted)] first:mt-0 sm:mt-0">
                  {figure.label}
                </dt>
                <dd className="m-0 text-[var(--color-fg)]">{figure.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
      <Card
        title="Record"
        meta={
          // The 44 px target (N14) reaches into the header's padding rather than growing the
          // header past its neighbours' (walk m19): 11 px each way leaves a 22 px line.
          <Link
            href={employeeTabHref(agentId, 'record')}
            className="-my-[11px] inline-flex min-h-11 min-w-11 items-center justify-end text-[var(--color-fg)]"
          >
            All<span className="sr-only"> of the record</span>
          </Link>
        }
      >
        {events === undefined ? (
          <p className="text-sm text-[var(--color-muted)]">Loading the record</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">Nothing recorded yet.</p>
        ) : (
          <RecordLines events={events} titles={titles} lines={RAIL_RECORD_LINES} />
        )}
      </Card>
      <Card title="Where decisions reach you">
        <p className="text-sm text-[var(--color-fg-2)]">
          {surfaceMode === undefined ? (
            'Loading'
          ) : surfaceMode === 'mock' ? (
            'Here only. The hosted office has no chat surface of yours to send them to.'
          ) : channel ? (
            'Here, and as a DM on the chat surface you connected.'
          ) : (
            <>
              Here only. Connect a chat surface on the{' '}
              <Link href={employeeTabHref(agentId, 'surfaces')}>Surfaces tab</Link> and each
              decision also arrives as a DM.
            </>
          )}
        </p>
      </Card>
    </>
  );
}
