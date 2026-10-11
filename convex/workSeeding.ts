import { v } from 'convex/values';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { scheduleNextStep } from './workLoop';
import type { TicketSnapshot } from '../src/work/ticket-ownership';
import { providerItemKey } from '../src/work/claim-key';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { appendEvent } from './eventLog';
import { providerTsToMs } from '../src/work/provider-ts';
import { releaseExternalClaim } from './workClaims';
import { recordListing } from './ticketListings';

/*
 * Seeding a work item from intake (the wave 14 review's D-6, the standard's 9.2): one row per
 * listed item, brought up to each later listing, withdrawn while its ticket is out of the queue
 * and returned when it is back; moved out of `convex/work.ts` unchanged. The registered seeds
 * (`work:seedItem`, `work:seedCharterDerived`, `work:withdrawListedItem`) stay in `convex/work.ts`
 * and call these. This module sits below `convex/work.ts`: `convex/work.ts` imports it and it
 * never imports `./work`, so the move closes no import cycle. It registers no function.
 */

/** The validator fields a seeded work item takes, shared by the seed mutations. */
export const workItemSeedFields = {
  sourceCategory: v.string(),
  sourceSystem: v.string(),
  externalId: v.string(),
  externalAlias: v.optional(v.string()),
  title: v.string(),
  contentSummary: v.string(),
  contentRefs: v.array(v.string()),
  priority: v.optional(v.string()),
  requesterLabel: v.optional(v.string()),
  owner: v.optional(v.string()),
  requester: v.optional(v.string()),
  replyTarget: v.optional(
    v.object({
      channel: v.string(),
      channelName: v.optional(v.string()),
      threadTs: v.optional(v.string()),
    }),
  ),
  /** When the ask was made, by the provider's clock (a Linear `createdAt`), when intake read it. */
  askedAt: v.optional(v.number()),
  /** When intake read the item: the poll's start, the ask time when the provider gives none. */
  observedAt: v.optional(v.number()),
} as const;

/** What seeds one work item: the employee and the candidate as intake found it. */
export interface WorkItemSeedInput {
  agentId: Id<'agents'>;
  sourceCategory: string;
  sourceSystem: string;
  externalId: string;
  /** The item's other name, when the provider prints two. */
  externalAlias?: string;
  title: string;
  contentSummary: string;
  contentRefs: string[];
  priority?: string;
  requesterLabel?: string;
  owner?: string;
  requester?: string;
  replyTarget?: { channel: string; channelName?: string; threadTs?: string };
  /** When the ask was made, by the provider's clock, when intake read it. */
  askedAt?: number;
  /** When intake read the item: the poll's start. */
  observedAt?: number;
}

/**
 * When an item was asked for: the provider's time intake passed, else the
 * `ts` a Slack message's id carries (`<channel id>:<ts>`), else when intake
 * read it, else now. Cycle time (A9) starts here, so a chat ask seen on a
 * later poll still counts from the message.
 */
function askedAtOf(
  args: Pick<WorkItemSeedInput, 'askedAt' | 'externalId' | 'observedAt'>,
  now: number,
): number {
  if (args.askedAt !== undefined) return args.askedAt;
  const ts = /^[CDG][A-Z0-9]{6,}:(\d{9,10}\.\d{1,6})$/.exec(args.externalId)?.[1];
  const fromTs = ts === undefined ? null : providerTsToMs(ts);
  return fromTs === null ? (args.observedAt ?? now) : Math.round(fromTs);
}

/**
 * Give a row seeded before its item's other name was stored that name, on the
 * poll that next reads the item, and its live claim with it.
 *
 * Args:
 *   ctx: Mutation context of the seed.
 *   existing: The row the item already has.
 *   externalAlias: The other name this poll read, if the provider printed one.
 *   externalClaimAlias: The claim key of that name.
 */
async function rememberExternalAlias(
  ctx: MutationCtx,
  existing: Doc<'workItems'>,
  externalAlias: string | undefined,
  externalClaimAlias: string | undefined,
): Promise<void> {
  if (
    externalAlias === undefined ||
    !externalClaimAlias ||
    existing.externalClaimAlias !== undefined
  )
    return;
  if (existing.externalClaimKey === externalClaimAlias) return;
  await ctx.db.patch(existing._id, { externalAlias, externalClaimAlias });
  const held = await ctx.db
    .query('externalClaims')
    .withIndex('by_work_item', (q) => q.eq('workItemId', existing._id))
    .filter((q) => q.eq(q.field('releasedAt'), undefined))
    .collect();
  for (const claim of held) {
    if (claim.writeTarget === undefined && !claim.aliases?.includes(externalClaimAlias)) {
      await ctx.db.patch(claim._id, { aliases: [...(claim.aliases ?? []), externalClaimAlias] });
    }
  }
}

/** How a row intake withdrew says so on the card; its return is found by the same words. */
export const WITHDRAWN_FROM_QUEUE_PREFIX = 'withdrawn from the queue on the tracker: ';

/**
 * The states a withdrawal moves to `cancelled`: work that is only waiting,
 * and a `claimed` row whose plan is still being drafted, so the window
 * closes at intake (review B1): `setPlan` stores a plan only on a `claimed`
 * row, so none is stored for a ticket that left the queue. A row with a
 * plan, a decision or a run in flight is left to the re-read before apply,
 * which withholds its first write; a finished row stays as it finished.
 */
const WITHDRAWABLE_STATES: ReadonlySet<Doc<'workItems'>['state']> = new Set([
  'discovered',
  'deferred',
  'needs-skill',
  'claimed',
]);

/** The states whose row no longer follows the tracker: the work is done or given up. */
const SETTLED_STATES: ReadonlySet<Doc<'workItems'>['state']> = new Set(['completed', 'cancelled']);

/** The fields a re-listing brings up to date, as the tracker now shows them. */
const LISTED_FIELDS = [
  'title',
  'contentSummary',
  'contentRefs',
  'priority',
  'requesterLabel',
  'owner',
  'requester',
] as const;

/**
 * Bring an existing row up to what the tracker lists now (Q11): the fields
 * that changed are patched on a row still being worked or waiting, and a
 * row intake withdrew is cancelled with the reason, or returned to
 * `discovered` when its ticket is back in the queue.
 *
 * @param existing - The row the ticket already has.
 * @param args - The ticket as this poll listed it.
 * @param leftQueue - Why the ticket left the queue, when this poll refused it.
 */
export async function refreshListedItem(
  ctx: MutationCtx,
  existing: Doc<'workItems'>,
  args: WorkItemSeedInput,
  leftQueue: string | undefined,
): Promise<void> {
  const withdrawn =
    existing.state === 'cancelled' && existing.skipReason?.startsWith(WITHDRAWN_FROM_QUEUE_PREFIX);
  if (SETTLED_STATES.has(existing.state) && !withdrawn) return;
  const changed = Object.fromEntries(
    LISTED_FIELDS.flatMap((field) =>
      JSON.stringify(existing[field]) === JSON.stringify(args[field]) ? [] : [[field, args[field]]],
    ),
  ) as Partial<Pick<Doc<'workItems'>, (typeof LISTED_FIELDS)[number]>>;
  const now = Date.now();
  if (leftQueue !== undefined && WITHDRAWABLE_STATES.has(existing.state)) {
    const skipReason = `${WITHDRAWN_FROM_QUEUE_PREFIX}${leftQueue}`;
    await ctx.db.patch(existing._id, { ...changed, state: 'cancelled', skipReason });
    await releaseExternalClaim(ctx, existing._id, now);
    await appendEvent(ctx, {
      agentId: existing.agentId,
      type: 'work.withdrawn',
      payload: { workItemId: existing._id, reason: skipReason, fromState: existing.state },
      createdAt: now,
    });
    await scheduleNextStep(ctx, { ...existing, state: 'cancelled' });
    return;
  }
  if (leftQueue !== undefined && withdrawn) {
    const skipReason = `${WITHDRAWN_FROM_QUEUE_PREFIX}${leftQueue}`;
    await ctx.db.patch(existing._id, { ...changed, skipReason });
    return;
  }
  if (leftQueue === undefined && withdrawn) {
    await ctx.db.patch(existing._id, {
      ...changed,
      state: 'discovered',
      skipReason: undefined,
      evaluationClaimedAt: undefined,
    });
    await appendEvent(ctx, {
      agentId: existing.agentId,
      type: 'work.returned',
      payload: { workItemId: existing._id, title: args.title },
      createdAt: now,
    });
    await scheduleNextStep(ctx, { ...existing, state: 'discovered' });
    return;
  }
  if (Object.keys(changed).length > 0) await ctx.db.patch(existing._id, changed);
}

/** The row an agent already holds for a listed item, if any. */
export async function listedRow(
  ctx: MutationCtx,
  args: Pick<WorkItemSeedInput, 'agentId' | 'sourceSystem' | 'externalId'>,
): Promise<Doc<'workItems'> | null> {
  return await ctx.db
    .query('workItems')
    .withIndex('by_agent_extId', (q) =>
      q
        .eq('agentId', args.agentId)
        .eq('sourceSystem', args.sourceSystem)
        .eq('externalId', args.externalId),
    )
    .first();
}

/**
 * Seed one listed item, or bring its existing row up to the listing.
 * Shares intake's idempotency boundary with fixed evaluation task batches.
 */
export async function seedItemInTransaction(
  ctx: MutationCtx,
  { tracker, ...args }: WorkItemSeedInput & { tracker?: TicketSnapshot },
): Promise<Id<'workItems'>> {
  const existing = await listedRow(ctx, args);
  if (existing) {
    await refreshListedItem(ctx, existing, args, undefined);
    await recordListing(ctx, existing, tracker);
  }
  // An existing row is read again for its other name only while it still lacks it.
  if (existing && (args.externalAlias === undefined || existing.externalClaimAlias !== undefined)) {
    return existing._id;
  }
  let externalClaimKey: string | undefined;
  let externalClaimAlias: string | undefined;
  if (SURFACE_MODE === 'real') {
    const surface = await ctx.db
      .query('surfaces')
      .withIndex('by_agent_slug', (q) =>
        q.eq('agentId', args.agentId).eq('slug', args.sourceSystem),
      )
      .first();
    if (surface) {
      externalClaimKey = providerItemKey(surface, args, SURFACE_MODE);
      if (args.externalAlias !== undefined) {
        externalClaimAlias = providerItemKey(
          surface,
          { sourceSystem: args.sourceSystem, externalId: args.externalAlias },
          SURFACE_MODE,
        );
      }
    }
  }
  if (existing) {
    await rememberExternalAlias(ctx, existing, args.externalAlias, externalClaimAlias);
    return existing._id;
  }
  const { externalAlias, askedAt, observedAt, ...seed } = args;
  const id = await ctx.db.insert('workItems', {
    ...seed,
    ...(externalClaimKey ? { externalClaimKey } : {}),
    ...(externalAlias !== undefined && externalClaimAlias
      ? { externalAlias, externalClaimAlias }
      : {}),
    state: 'discovered',
    observedAt: askedAtOf({ askedAt, externalId: args.externalId, observedAt }, Date.now()),
    createdAt: Date.now(),
  });
  await appendEvent(ctx, {
    agentId: args.agentId,
    type: 'work.discovered',
    payload: { workItemId: id, title: args.title, ...(tracker ? { tracker } : {}) },
    createdAt: Date.now(),
  });
  await scheduleNextStep(ctx, {
    _id: id,
    agentId: args.agentId,
    state: 'discovered',
    sourceSystem: args.sourceSystem,
    externalId: args.externalId,
  });
  return id;
}

/** Why a listing is not written: the employee is gone or changed owner while the poll read its queue. */
export const LISTING_AFTER_HANDOVER =
  'the employee was handed over to a new manager, or retired, while this poll read its queue';
