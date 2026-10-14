'use client';

import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { ticketAsLastSeen } from '@/work/item-display';
import { clockTime, clockTimeWithSeconds } from '../../../components/time';
import { ItemSection } from './ItemParts';

/**
 * Where the item's ticket stood when intake last listed it, and when that was (K D3, over
 * `work.latestListing`, the owner-guarded read F landed in wave 3.5): drawn above a retry or a
 * send-back so the manager decides knowing whether the ticket moved. The line is intake's last
 * reading and says so, with when it reads again: under a move the run had just landed, "The
 * ticket is in Backlog" read as the ticket's state (the joins' W12a; wording draft of the wave 17
 * file's section 7, RM24). Nothing while it loads, and nothing for an item intake kept no listing
 * for.
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
  const { seen, refusal } = ticketAsLastSeen(listing.tracker, listing.refused, listing.holder);
  return (
    <ItemSection title="The ticket now">
      <p className="text-sm text-[var(--color-fg-2)]">
        Intake last saw this ticket {seen}, at{' '}
        <time
          dateTime={new Date(listing.listedAt).toISOString()}
          title={clockTimeWithSeconds(listing.listedAt, zone)}
        >
          {clockTime(listing.listedAt, zone)}
        </time>
        . {refusal ? `${refusal} ` : null}It reads the tracker again at its next check.
      </p>
    </ItemSection>
  );
}
