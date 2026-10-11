import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { TicketSnapshot } from '../src/work/ticket-ownership';
import { appendEvent, eventsOfType } from './eventLog';

/*
 * The tracker listing record (the wave 14 review's D-6, the standard's 9.2): each change in how
 * intake saw a ticket is kept in `ticketListings` and on the live feed as `work.listed`, and the
 * re-read before apply reads the latest one back; moved out of `convex/work.ts` unchanged. The
 * registered reads (`work:latestListing`, `work:listedSnapshot`) stay in `convex/work.ts`. This
 * module sits below `convex/work.ts`: `convex/work.ts` imports it and it never imports `./work`, so
 * the move closes no import cycle. It registers no function.
 */

/** The event that keeps each listing's snapshot of a ticket in the live feed. */
export const WORK_LISTED_EVENT = 'work.listed';

/** A listing as it was kept: the ticket, and why intake refused it on that poll, if it did. */
interface KeptListing {
  readonly tracker: TicketSnapshot;
  readonly refused?: string;
  readonly listedAt: number;
}

/** A work item as the listing reads need it. */
type ListedItem = Pick<Doc<'workItems'>, '_id' | 'agentId' | '_creationTime'>;

/**
 * How many of an agent's discoveries at or after an item's creation the
 * first-listing read looks through. The discovery is written in the same
 * transaction as the row, so it is among the first few.
 */
const DISCOVERY_SCAN = 16;

/**
 * Keep one listing of a ticket in `ticketListings`, unless the same moment
 * is already kept for the item, so a copy made twice keeps one row.
 *
 * @returns Whether a row was written.
 */
export async function keepTicketListing(
  ctx: MutationCtx,
  row: Pick<Doc<'workItems'>, '_id' | 'agentId'>,
  listing: { tracker: TicketSnapshot; refused?: string; listedAt: number },
): Promise<boolean> {
  const kept = await ctx.db
    .query('ticketListings')
    .withIndex('by_work_item_listed_at', (q) =>
      q.eq('workItemId', row._id).eq('listedAt', listing.listedAt),
    )
    .first();
  if (kept !== null) return false;
  await ctx.db.insert('ticketListings', {
    agentId: row.agentId,
    workItemId: row._id,
    tracker: listing.tracker,
    listedAt: listing.listedAt,
    ...(listing.refused !== undefined ? { refused: listing.refused } : {}),
  });
  return true;
}

/**
 * The listing an item's discovery kept. Every ticket's first listing rides on
 * its `work.discovered` event, which is written with the row, so it is read
 * from the agent's discoveries at or after the row's creation.
 */
async function discoveryListing(ctx: QueryCtx, row: ListedItem): Promise<KeptListing | undefined> {
  const discoveries = await eventsOfType(ctx, row.agentId, 'work.discovered', {
    from: row._creationTime,
  }).take(DISCOVERY_SCAN);
  const discovery = discoveries.find(
    (event) => (event.payload as { workItemId?: unknown } | undefined)?.workItemId === row._id,
  );
  const tracker = (discovery?.payload as { tracker?: TicketSnapshot } | undefined)?.tracker;
  return discovery && tracker ? { tracker, listedAt: discovery.createdAt } : undefined;
}

/**
 * The latest listing kept for an item, at or before a time.
 *
 * A later listing is a `ticketListings` row, read by the item's own index;
 * the first rides on the discovery, and a refused ticket is never discovered.
 * A listing kept only as a `work.listed` event before the table existed is
 * found once the `ticket-listings` migration has copied it.
 *
 * @param row - The item and its agent.
 * @param before - The latest listing time that counts.
 * @param acceptedOnly - Whether to pass over a listing intake refused.
 * @returns The listing, or undefined when the item was never listed by then.
 */
export async function keptListingAt(
  ctx: QueryCtx,
  row: ListedItem,
  before: number,
  acceptedOnly: boolean,
): Promise<KeptListing | undefined> {
  const later = acceptedOnly
    ? await ctx.db
        .query('ticketListings')
        .withIndex('by_work_item_refused_listed_at', (q) =>
          q.eq('workItemId', row._id).eq('refused', undefined).lte('listedAt', before),
        )
        .order('desc')
        .first()
    : await ctx.db
        .query('ticketListings')
        .withIndex('by_work_item_listed_at', (q) =>
          q.eq('workItemId', row._id).lte('listedAt', before),
        )
        .order('desc')
        .first();
  if (later !== null) {
    return {
      tracker: later.tracker,
      listedAt: later.listedAt,
      ...(later.refused !== undefined ? { refused: later.refused } : {}),
    };
  }
  const first = await discoveryListing(ctx, row);
  return first !== undefined && first.listedAt <= before ? first : undefined;
}

/**
 * The latest snapshot a listing intake took the ticket on kept for an item,
 * at or before a time. A listing intake refused is never a baseline (review
 * B1): the refusal is a change the re-read must find, not the ticket the plan
 * was made for.
 *
 * @param row - The item and its agent.
 * @param before - The latest listing time that counts.
 * @returns The snapshot, or undefined when no accepted listing was kept by then.
 */
export async function listedSnapshotAt(
  ctx: QueryCtx,
  row: ListedItem,
  before: number,
): Promise<TicketSnapshot | undefined> {
  return (await keptListingAt(ctx, row, before, true))?.tracker;
}

/** The snapshot fields, in one order, so two snapshots compare by value. */
const SNAPSHOT_FIELDS = [
  'assigned',
  'assigneeId',
  'assigneeEmail',
  'state',
  'stateType',
  'doNotAutomate',
] as const;

/** Whether two snapshots say the same about a ticket, whatever order their fields were stored in. */
function sameSnapshot(left: TicketSnapshot, right: TicketSnapshot): boolean {
  return SNAPSHOT_FIELDS.every((field) => left[field] === right[field]);
}

/**
 * Keep the ticket as this listing showed it, when it differs from the last
 * listing kept or intake's refusal of it changed, so the re-read before
 * apply can tell what changed since the plan was made. The listing goes to
 * `ticketListings` and, as before, to the live feed as `work.listed`. The
 * first listing is kept on the discovery event, so the feed gains a row only
 * when a ticket changes.
 *
 * @param refused - Why intake refused the ticket on this poll, when it did.
 */
export async function recordListing(
  ctx: MutationCtx,
  row: ListedItem,
  tracker: TicketSnapshot | undefined,
  refused?: string,
): Promise<void> {
  if (tracker === undefined) return;
  const now = Date.now();
  const last = await keptListingAt(ctx, row, now, false);
  if (
    last !== undefined &&
    sameSnapshot(last.tracker, tracker) &&
    (last.refused === undefined) === (refused === undefined)
  ) {
    return;
  }
  await keepTicketListing(ctx, row, {
    tracker,
    listedAt: now,
    ...(refused !== undefined ? { refused } : {}),
  });
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: WORK_LISTED_EVENT,
    payload: { workItemId: row._id, tracker, ...(refused !== undefined ? { refused } : {}) },
    createdAt: now,
  });
}
