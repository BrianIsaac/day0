import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, mutation, query, type QueryCtx } from './_generated/server';
import { appendEvent, eventsOfType } from './eventLog';
import { assertOwnsAgent } from './ownership';
import {
  CHARTER_SEEDING_ATTEMPTS,
  CHARTER_SEEDING_RETRY_MS,
  SEEDING_DID_NOT_FINISH,
  seedingLine,
  seedingStanding,
  nothingToFindAgain,
  stillFindingWork,
  type SeedingEvent,
  type SeedingStanding,
} from '../src/agent/charter-seeding';

/*
 * The seeding of an approved charter that did not finish (wave 13, 12-J item 6, options B and C):
 * the check each attempt schedules past the platform's limit, which records an attempt the
 * platform ended and tries again; how the seeding stands, for the empty Work tab; and the
 * manager's "Find work again" once the attempts are spent.
 */

/** The most events of each kind the standing reads, newest first: every attempt of a seeding and a little more. */
const SEEDING_EVENTS_READ = CHARTER_SEEDING_ATTEMPTS * 2;

/** The employee's latest charter when it is approved; undefined otherwise. */
async function approvedCharter(
  ctx: Pick<QueryCtx, 'db'>,
  agentId: Id<'agents'>,
): Promise<Doc<'charters'> | undefined> {
  const latest = await ctx.db
    .query('charters')
    .withIndex('by_agent', (index) => index.eq('agentId', agentId))
    .order('desc')
    .first();
  return latest?.approved === true ? latest : undefined;
}

/** The employee's newest seeding events, newest first. */
async function seedingEvents(
  ctx: Pick<QueryCtx, 'db'>,
  agentId: Id<'agents'>,
): Promise<SeedingEvent[]> {
  const [failed, requested, derived] = await Promise.all(
    (['charter.seeding-failed', 'charter.seeding-requested', 'work.charter-derived'] as const).map(
      async (type) =>
        await eventsOfType(ctx, agentId, type).order('desc').take(SEEDING_EVENTS_READ),
    ),
  );
  return [...failed!, ...requested!, ...derived!]
    .sort((a, b) => b._creationTime - a._creationTime)
    .flatMap((event): SeedingEvent[] => {
      const payload = event.payload as { charterId?: string; reason?: string; retrying?: boolean };
      if (event.type === 'work.charter-derived') return [{ type: 'work.charter-derived' }];
      if (typeof payload.charterId !== 'string') return [];
      if (event.type === 'charter.seeding-requested') {
        return [{ type: 'charter.seeding-requested', charterId: payload.charterId }];
      }
      return [
        {
          type: 'charter.seeding-failed',
          charterId: payload.charterId,
          reason: payload.reason ?? '',
          retrying: payload.retrying === true,
        },
      ];
    });
}

/**
 * Internal: the check one seeding attempt schedules past the platform's limit. An attempt that
 * neither seeded (`work.charter-derived`) nor recorded its own failure since it started was ended
 * by the platform, which runs no `catch`: the check records `charter.seeding-failed` with
 * {@link SEEDING_DID_NOT_FINISH} and schedules the next attempt, as the attempt's own `catch`
 * would have, or stops after the last. A charter no longer the approved latest is left alone.
 */
export const checkAttempt = internalMutation({
  args: {
    agentId: v.id('agents'),
    charterId: v.id('charters'),
    attempt: v.number(),
    startedAt: v.number(),
  },
  handler: async (ctx, args): Promise<'ended' | 'recorded' | 'superseded'> => {
    const charter = await approvedCharter(ctx, args.agentId);
    if (charter?._id !== args.charterId) return 'superseded';
    const since = { from: args.startedAt };
    const seeded = await eventsOfType(ctx, args.agentId, 'work.charter-derived', since).first();
    const failures = await eventsOfType(ctx, args.agentId, 'charter.seeding-failed', since).take(
      SEEDING_EVENTS_READ,
    );
    const recordedItself = failures.some((event) => {
      const payload = event.payload as { charterId?: string; attempt?: number };
      return payload.charterId === args.charterId && payload.attempt === args.attempt;
    });
    if (seeded || recordedItself) return 'ended';
    const retrying = args.attempt < CHARTER_SEEDING_ATTEMPTS;
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'charter.seeding-failed',
      payload: {
        charterId: args.charterId,
        attempt: args.attempt,
        reason: SEEDING_DID_NOT_FINISH,
        retrying,
      },
      createdAt: Date.now(),
    });
    if (retrying) {
      await ctx.scheduler.runAfter(
        CHARTER_SEEDING_RETRY_MS * args.attempt,
        internal.onboarding.postCharterApproval,
        { agentId: args.agentId, charterId: args.charterId, attempt: args.attempt + 1 },
      );
    }
    return 'recorded';
  },
});

/**
 * Public, guarded by `assertOwnsAgent`: how the seeding of the employee's approved charter stands,
 * with the line the empty Work tab says of it; null when nothing is wrong. Writes nothing.
 */
export const standing = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<(SeedingStanding & { readonly line: string }) | null> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const charter = await approvedCharter(ctx, args.agentId);
    if (!charter) return null;
    const found = seedingStanding(await seedingEvents(ctx, args.agentId), charter._id);
    return found ? { ...found, line: seedingLine(found, agent.name) } : null;
  },
});

/**
 * Public, guarded by `assertOwnsAgent`: the manager's "Find work again", once every attempt at
 * seeding the approved charter failed. Records `charter.seeding-requested` and schedules a first
 * attempt afresh; refused with the reason while a seeding is still being tried, so a second press
 * never runs two.
 */
export const findWorkAgain = mutation({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<void> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const charter = await approvedCharter(ctx, args.agentId);
    if (!charter) throw new ConvexError('Approve the charter first: work is found from it.');
    const found = seedingStanding(await seedingEvents(ctx, args.agentId), charter._id);
    if (found === undefined) throw new ConvexError(nothingToFindAgain(agent.name));
    if (found.state !== 'stopped') throw new ConvexError(stillFindingWork(agent.name));
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'charter.seeding-requested',
      payload: { charterId: charter._id },
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.onboarding.postCharterApproval, {
      agentId: args.agentId,
      charterId: charter._id,
      attempt: 1,
    });
  },
});
