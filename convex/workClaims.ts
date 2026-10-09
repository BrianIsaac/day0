import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { isAuditComment, parseSurfaceAction } from '../src/surfaces/policy';
import { CLAIMED_BY_COLLEAGUE_SKIP_PREFIX } from '../src/work/types';
import { providerItemKey, writeTargetIds, type ClaimHolder } from '../src/work/claim-key';
import { landedWritesOf } from '../src/work/landed-writes';
import { isRevocationTrialRow } from './revocationEvaluation';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { appendEvent } from './eventLog';
import { retiredClaimOn, retiredHolderName } from './retirements';
import { reevaluatePendingInTransaction } from './workReevaluation';

/*
 * The owner-wide claim on a provider item and on the page fields a plan writes (the wave 14
 * review's D-6, the standard's 9.2): taking it, naming who holds it, and releasing it with what it
 * refused, moved out of `convex/work.ts` unchanged. The registered claim functions
 * (`work:writeClaimHolder`, `work:takeWriteTargetClaims`, `work:itemsHeldElsewhere`,
 * `work:claimLandedTicketWrites`) stay in `convex/work.ts` and call these. This module sits below
 * `convex/work.ts`: `convex/work.ts` imports it and it never imports `./work`, so the move closes no
 * import cycle. It registers no function.
 */

/** A holder in one of these states no longer holds its item. */
export const RELEASED_HOLDER_STATES: ReadonlySet<Doc<'workItems'>['state']> = new Set([
  'cancelled',
  'skipped',
]);

/**
 * The owner and key a row's provider item is claimed under, if it is claimed at all.
 *
 * Real mode only; a revocation trial row and an agent with no owner claim
 * nothing. A key captured with the item at intake survives later card edits;
 * older rows without one use their current surface as a fallback.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item.
 *
 * Returns:
 *   The owner and key, or undefined when the row takes no claim.
 */
async function externalClaimScope(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
): Promise<{ userId: string; key: string } | undefined> {
  if (SURFACE_MODE !== 'real' || isRevocationTrialRow(row)) return undefined;
  const agent = await ctx.db.get(row.agentId);
  if (!agent?.userId) return undefined;
  const surface = row.externalClaimKey
    ? undefined
    : await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) =>
          q.eq('agentId', row.agentId).eq('slug', row.sourceSystem),
        )
        .first();
  const key = row.externalClaimKey ?? providerItemKey(surface ?? undefined, row, SURFACE_MODE);
  return key === undefined ? undefined : { userId: agent.userId, key };
}

/** Another work item holding a row's provider item, and the state it is in. */
interface HeldElsewhere {
  readonly holder: ClaimHolder;
  readonly state: string;
}

/**
 * Read the live claims on a row's provider item: the row's own, another work
 * item's, or none. A live claim whose holder is gone, cancelled or skipped
 * is released here, with what it refused, so a release some path missed
 * cannot keep the item from the company for good.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item asking.
 *   scope: The owner and key the row's item is claimed under.
 *   now: The time of the read.
 *
 * Returns:
 *   'own' when the row holds the claim, the holder when another work item
 *   does, undefined when nobody does.
 */
async function liveClaimOn(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  scope: { userId: string; key: string },
  now: number,
): Promise<'own' | HeldElsewhere | undefined> {
  const live = await ctx.db
    .query('externalClaims')
    .withIndex('by_user_key', (q) => q.eq('userId', scope.userId).eq('key', scope.key))
    .filter((q) => q.eq(q.field('releasedAt'), undefined))
    .collect();
  for (const claim of live) {
    if (claim.workItemId === row._id) return 'own';
    const holding = await ctx.db.get(claim.workItemId);
    if (!holding || RELEASED_HOLDER_STATES.has(holding.state)) {
      await releaseClaim(ctx, claim, now);
      continue;
    }
    // A write-target claim whose holder finished gives way to work created after (M9).
    if (!holdsAgainst(claim, row)) continue;
    const agent = await ctx.db.get(claim.agentId);
    return {
      holder: {
        claimId: claim._id,
        agentId: claim.agentId,
        workItemId: claim.workItemId,
        name: agent?.name ?? 'another employee',
        title: holding.title,
      },
      state: holding.state,
    };
  }
  // A retired employee's claim on an item it may already have written is
  // never released: the item stays its, whoever asks (review M14).
  const retired = await retiredClaimOn(ctx, scope.userId, scope.key);
  if (!retired) return undefined;
  return {
    holder: {
      claimId: retired.claim.claimId,
      agentId: retired.retirement.agentId,
      workItemId: retired.claim.workItemId,
      name: retiredHolderName(retired.retirement),
      title: retired.claim.title,
    },
    state: retired.claim.state,
  };
}

/**
 * Take the owner-wide claim on a row's provider item, or name who holds it.
 *
 * The read of the live claims and the insert share the claiming
 * transaction, and Convex serialises transactions that touch the same index
 * range, so of two verdicts on one item exactly one inserts.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item about to be claimed.
 *   now: The claim time.
 *
 * Returns:
 *   Undefined when the row takes no claim; otherwise the key, and the holder
 *   and its state when another work item holds it.
 */
export async function takeExternalClaim(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  now: number,
): Promise<{ key: string; heldBy?: HeldElsewhere } | undefined> {
  const scope = await externalClaimScope(ctx, row);
  if (!scope) return undefined;
  const live = await liveClaimOn(ctx, row, scope, now);
  if (live === 'own') return { key: scope.key };
  if (live) return { key: scope.key, heldBy: live };
  await ctx.db.insert('externalClaims', {
    userId: scope.userId,
    key: scope.key,
    agentId: row.agentId,
    workItemId: row._id,
    ...(row.externalClaimAlias ? { aliases: [row.externalClaimAlias] } : {}),
    claimedAt: now,
  });
  return { key: scope.key };
}

/**
 * The other work item holding a row's provider item, without taking a claim.
 *
 * What a row that is not about to work the item asks: one whose evaluation
 * has not begun, so a colleague's hold costs no model call (P8-2), and one
 * parked for a skill or a connection, so its manager is never asked to
 * approve a skill for an item a colleague already works. A parked row takes
 * no claim of its own, so a colleague who can do the work still can.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The work item asking.
 *   now: The time of the read.
 *
 * Returns:
 *   The key and the holder, or undefined when the row takes no claim or
 *   nobody else holds the item.
 */
export async function externalClaimHeldElsewhere(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  now: number,
): Promise<{ key: string; heldBy: HeldElsewhere } | undefined> {
  const scope = await externalClaimScope(ctx, row);
  if (!scope) return undefined;
  const live = await liveClaimOn(ctx, row, scope, now);
  return live === undefined || live === 'own' ? undefined : { key: scope.key, heldBy: live };
}

/**
 * Record that a row was refused the item another work item holds.
 *
 * Args:
 *   ctx: Mutation context.
 *   row: The refused work item.
 *   refused: The claim key and who holds it.
 */
export async function logClaimRefused(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  refused: { key: string; holder: ClaimHolder },
): Promise<void> {
  await appendEvent(ctx, {
    agentId: row.agentId,
    type: 'work.claim-refused',
    payload: { workItemId: row._id, key: refused.key, holder: refused.holder },
    createdAt: Date.now(),
  });
}

/**
 * Hold the item again for a row resuming past evaluation, or refuse.
 *
 * A retry resumes a cancelled row that has a plan past evaluation, so no
 * verdict takes the claim on the way; a colleague may have taken the item
 * since the cancel released it. A failed or completed row still holds its
 * claim and takes nothing new, except a row whose held actions were rejected,
 * which released it.
 *
 * Args:
 *   ctx: Mutation context of the retry.
 *   row: The row being retried.
 *
 * Raises:
 *   Error: When another work item holds the item.
 */
export async function retakeExternalClaim(ctx: MutationCtx, row: Doc<'workItems'>): Promise<void> {
  const taken = await takeExternalClaim(ctx, row, Date.now());
  if (!taken?.heldBy) return;
  const { holder } = taken.heldBy;
  throw new Error(
    holder.agentId === row.agentId
      ? `this employee already holds this item on another work item (${holder.title})`
      : `another employee holds this: ${holder.name} (${holder.title})`,
  );
}

/**
 * The skip a claim verdict becomes when another work item holds the item.
 *
 * Args:
 *   row: The refused work item.
 *   holder: Who holds the item.
 *   holderState: The holding work item's state.
 *
 * Returns:
 *   The skip verdict, naming the holder for the card.
 */
export function claimRefusedVerdict(
  row: Doc<'workItems'>,
  holder: ClaimHolder,
  holderState: string,
): { decision: string; reason: string; claimedBy: ClaimHolder } {
  const reason =
    holder.agentId === row.agentId
      ? `already-claimed: state=${holderState}`
      : `${CLAIMED_BY_COLLEAGUE_SKIP_PREFIX}${holder.name} holds it (${holder.title})`;
  return { decision: 'skip', reason, claimedBy: holder };
}

/**
 * The last comment a holder landed on the item it holds, by provider id.
 *
 * Args:
 *   holding: The holding work item.
 *
 * Returns:
 *   The comment's provider id, or undefined when the holder landed none.
 */
export function landedCommentOn(holding: Doc<'workItems'>): string | undefined {
  const held = new Set(
    [holding.externalId, holding.externalAlias]
      .filter((name): name is string => name !== undefined)
      .map((name) => name.toUpperCase()),
  );
  return landedWritesOf(holding.output)
    .filter((write) => {
      const parsed = parseSurfaceAction(write.action);
      return (
        parsed.ok &&
        isAuditComment(parsed.action) &&
        writeTargetIds(parsed.action, { class: 'kanban' }).some((target) =>
          held.has(target.toUpperCase()),
        )
      );
    })
    .map((write) => write.applied.providerId)
    .filter((id): id is string => typeof id === 'string')
    .at(-1);
}

/**
 * Whether a live claim holds against a work item.
 *
 * A claim on the item a row was discovered from holds against everything. A
 * write-target claim whose holder has finished holds only against work that
 * already existed then: the four items of 19 September all wanted the one
 * refresh, and the three that did not make it must not repeat it, while a
 * ticket raised next week for a new figure is new work on the same field.
 *
 * Args:
 *   claim: The live claim.
 *   row: The work item asking.
 *
 * Returns:
 *   False only for a settled write-target claim and a row created after it settled.
 */
export function holdsAgainst(
  claim: Pick<Doc<'externalClaims'>, 'writeTarget' | 'settledAt'>,
  row: Doc<'workItems'>,
): boolean {
  return (
    claim.writeTarget === undefined ||
    claim.settledAt === undefined ||
    row._creationTime < claim.settledAt
  );
}

/**
 * Stamp a finished work item's write-target claims settled.
 *
 * Called where a row completes or fails. The claims stay live, so the work
 * that ran beside the holder still reads the page instead of writing it.
 *
 * Args:
 *   ctx: Mutation context of the transition.
 *   workItemId: The work item that finished.
 *   now: The time it finished.
 */
export async function settleWriteTargetClaims(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  now: number,
): Promise<void> {
  if (SURFACE_MODE !== 'real') return;
  const held = await ctx.db
    .query('externalClaims')
    .withIndex('by_work_item', (q) => q.eq('workItemId', workItemId))
    .filter((q) => q.eq(q.field('releasedAt'), undefined))
    .collect();
  for (const claim of held) {
    if (claim.writeTarget !== undefined) await ctx.db.patch(claim._id, { settledAt: now });
  }
}

/**
 * Stamp one claim released and send back what it refused.
 *
 * Every employee of the owner is re-evaluated for the rows this claim
 * refused, keyed by the claim's id, so each returns to `discovered` once and
 * the next verdict takes the item or names its new holder.
 *
 * Args:
 *   ctx: Mutation context of the transition.
 *   claim: The live claim.
 *   now: The release time.
 */
export async function releaseClaim(
  ctx: MutationCtx,
  claim: Doc<'externalClaims'>,
  now: number,
): Promise<void> {
  await ctx.db.patch(claim._id, { releasedAt: now });
  const employees = await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', claim.userId))
    .collect();
  for (const employee of employees) {
    await reevaluatePendingInTransaction(ctx, {
      agentId: employee._id,
      trigger: 'claim-released',
      key: claim._id,
      now,
    });
  }
}

/**
 * Release the claim a work item holds, with what it refused.
 *
 * A row that holds no live claim releases nothing. Called where a holder is
 * cancelled; completed and failed rows keep their claim, except a row whose
 * held actions the manager rejected (`releaseItemClaim`).
 *
 * Args:
 *   ctx: Mutation context of the transition.
 *   workItemId: The work item letting go of its item.
 *   now: The release time.
 */
export async function releaseExternalClaim(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  now: number,
): Promise<void> {
  const held = await ctx.db
    .query('externalClaims')
    .withIndex('by_work_item', (q) => q.eq('workItemId', workItemId))
    .filter((q) => q.eq(q.field('releasedAt'), undefined))
    .collect();
  for (const claim of held) await releaseClaim(ctx, claim, now);
}

/**
 * Release the claim a work item holds on the provider item it was discovered
 * from, with what it refused, leaving any claim on a page field it wrote.
 *
 * Args:
 *   ctx: Mutation context of the rejection.
 *   workItemId: The rejected work item.
 *   now: The release time.
 */
export async function releaseItemClaim(
  ctx: MutationCtx,
  workItemId: Id<'workItems'>,
  now: number,
): Promise<void> {
  const held = await ctx.db
    .query('externalClaims')
    .withIndex('by_work_item', (q) => q.eq('workItemId', workItemId))
    .filter((q) => q.eq(q.field('releasedAt'), undefined))
    .collect();
  for (const claim of held) {
    if (claim.writeTarget === undefined) await releaseClaim(ctx, claim, now);
  }
}
