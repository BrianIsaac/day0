'use client';

import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { clockTime, clockTimeWithSeconds } from '../time';

/**
 * The plan an item's current one replaced, as its draft event keeps it (`work.earlierPlan`):
 * when it was drafted, its summary and its steps, so the manager compares the redraft with what
 * they cancelled (round two section 3.7, "the first attempt behind a disclosure").
 *
 * @param workItemId - The redrafted item.
 * @param employeeName - Whose drafts the read walks, for the line when the plan is past its bound.
 * @param zone - The employee's zone.
 */
export function EarlierPlan({
  workItemId,
  employeeName,
  zone,
}: {
  workItemId: Id<'workItems'>;
  employeeName: string;
  zone: string | undefined;
}) {
  const earlier = useQuery(api.work.earlierPlan, { workItemId });
  if (earlier === undefined) {
    return <p className="text-sm text-[var(--color-muted)]">Reading the earlier plan…</p>;
  }
  if (earlier === null) {
    return (
      <p className="text-sm text-[var(--color-muted)]">
        The earlier plan is not among {employeeName}&apos;s newest drafts.
      </p>
    );
  }
  return (
    <div className="grid gap-2">
      <p className="text-[13px] text-[var(--color-muted)]">
        Drafted at{' '}
        <time
          dateTime={new Date(earlier.draftedAt).toISOString()}
          title={clockTimeWithSeconds(earlier.draftedAt, zone)}
        >
          {clockTime(earlier.draftedAt, zone)}
        </time>{' '}
        and cancelled by you.
      </p>
      {earlier.summary ? (
        <p className="text-sm text-[var(--color-fg-2)]">{earlier.summary}</p>
      ) : null}
      <ol className="grid list-decimal gap-1 pl-5 text-sm text-[var(--color-fg-2)]">
        {earlier.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
