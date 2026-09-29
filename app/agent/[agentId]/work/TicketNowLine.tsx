'use client';

import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { ticketNowSentence } from '@/work/item-display';
import { clockTime, clockTimeWithSeconds } from '../../../components/time';
import { ItemSection } from './ItemParts';

/**
 * Where the item's ticket stands now, as intake last listed it (K D3, over `work.latestListing`,
 * the owner-guarded read F landed in wave 3.5): drawn above a retry or a send-back so the
 * manager decides knowing whether the ticket moved. Nothing while it loads, and nothing for an
 * item intake kept no listing for.
 *
 * @param workItemId - The ticket's work item.
 * @param zone - The employee's zone, for the listing's time.
 */
export function TicketNowLine({
  workItemId,
  zone,
}: {
  workItemId: Id<'workItems'>;
  zone: string | undefined;
}) {
  const listing = useQuery(api.work.latestListing, { workItemId });
  if (!listing) return null;
  return (
    <ItemSection title="The ticket now">
      <p className="text-sm text-[var(--color-fg-2)]">
        {ticketNowSentence(listing.tracker, listing.refused)}{' '}
        <span className="text-[13px] text-[var(--color-muted)]">
          As intake last listed it at{' '}
          <time
            dateTime={new Date(listing.listedAt).toISOString()}
            title={clockTimeWithSeconds(listing.listedAt, zone)}
          >
            {clockTime(listing.listedAt, zone)}
          </time>
          .
        </span>
      </p>
    </ItemSection>
  );
}
