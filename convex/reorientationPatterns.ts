import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { eventsOfType } from './eventLog';
import {
  REFUSAL_KEY_PREFIX,
  charterClausesWhere,
  isWriteScope,
  openCard,
  openCards,
  type CardTrigger,
} from './reorientation';
import { scopeReach } from './reorientationReach';
import type { ReorientationTrigger } from '../src/agent/reorientation-vocabulary';

/*
 * The counted rows of section 3 (wave 16, 16-O): three gate refusals of one scope in seven days,
 * three out-of-scope skips under one willNotDo clause in thirty, three plan rejections in thirty.
 * Each opens or joins its card at the crossing only, counted by run, and restarts after a card that
 * carried its events is decided (the second pass's M1). Below `convex/reorientation.ts`, whose
 * `openCard` it calls; called by `workRuns.setCompleted`, `workVerdicts.applyVerdict` and
 * `managerDecisions.cancelPlanInTransaction`. It registers no function.
 */

/** The decided cards of one standing a count reads back for its restart, newest first. */
const DECIDED_CARDS_READ = 50;

/** How many times a pattern repeats before it opens a card (section 3: three). */
export const REPEAT_THRESHOLD = 3;

const DAY_MS = 86_400_000;

/** The window a repeated refusal is counted in: seven days. */
export const REFUSAL_WINDOW_MS = 7 * DAY_MS;

/** The window a repeated skip or rejection is counted in: thirty days. */
export const REPEAT_WINDOW_MS = 30 * DAY_MS;

/** The events of one kind a count reads back, newest first. */
const COUNTED_EVENTS_READ = 200;

/** The scope a gate's refusal names (`no grant (<scope>)`), wherever it sits in a held row's reason. */
export function refusedScopeOf(reason: string | undefined): string | undefined {
  return reason === undefined ? undefined : /no grant \(([^)]+)\)/.exec(reason)?.[1];
}

/**
 * When the manager last decided a card about a counted pattern, or 0: a card of the trigger whose
 * key is the pattern's, or one the pattern joined (its evidence holds any of the pattern's events).
 * A count starts after it, so a dismissed pattern opens a card again only once it repeats again.
 */
async function lastDecidedAt(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  pattern: {
    readonly trigger: ReorientationTrigger;
    readonly triggerKey: string;
    readonly eventIds: ReadonlySet<string>;
  },
): Promise<number> {
  const decided = await Promise.all(
    (['applied', 'dismissed'] as const).map(
      async (status) =>
        await ctx.db
          .query('reorientations')
          .withIndex('by_agent_status', (q) => q.eq('agentId', agentId).eq('status', status))
          .order('desc')
          .take(DECIDED_CARDS_READ),
    ),
  );
  return Math.max(
    0,
    ...decided
      .flat()
      .filter(
        (card) =>
          card.trigger === pattern.trigger &&
          (card.triggerKey === pattern.triggerKey ||
            card.evidence.eventIds.some((id) => pattern.eventIds.has(id))),
      )
      .map((card) => card.decidedAt ?? card.createdAt),
  );
}

/** One counted occurrence of a pattern: the event it was written in, and when. */
interface Occurrence {
  readonly id: Id<'events'>;
  readonly at: number;
}

/**
 * The occurrences of a pattern since the manager last decided a card about it, each event once,
 * when there are exactly enough to open a card: a card opens, or a trigger joins the day's card,
 * at the crossing only, so a pattern that goes on repeating writes nothing more until it is decided.
 */
async function crossing(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  pattern: { readonly trigger: ReorientationTrigger; readonly triggerKey: string },
  occurrences: readonly Occurrence[],
): Promise<Occurrence[] | undefined> {
  const distinct = [
    ...new Map(occurrences.map((occurrence) => [occurrence.id, occurrence])).values(),
  ];
  const since = await lastDecidedAt(ctx, agentId, {
    ...pattern,
    eventIds: new Set(distinct.map((occurrence) => occurrence.id)),
  });
  const counted = distinct.filter((occurrence) => occurrence.at > since);
  return counted.length === REPEAT_THRESHOLD ? counted : undefined;
}

/**
 * Open a card for every scope Day0's gate refused the employee in three runs in seven days (section
 * 3's refusal row), counted over the held rows of its settled runs, a run once, since the last card
 * about the scope was decided. Called where a run's ledger is settled (`workRuns.setCompleted`).
 */
export async function openRepeatedRefusalCards(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  now: number,
): Promise<void> {
  const events = await eventsOfType(ctx, agentId, 'work.actions-withheld', {
    after: now - REFUSAL_WINDOW_MS,
  })
    .order('desc')
    .take(COUNTED_EVENTS_READ);
  const byScope = new Map<string, Occurrence[]>();
  for (const event of events) {
    const rows =
      (event.payload as { withheld?: ReadonlyArray<{ reason?: string }> }).withheld ?? [];
    for (const scope of new Set(rows.flatMap((row) => refusedScopeOf(row.reason) ?? []))) {
      byScope.set(scope, [
        ...(byScope.get(scope) ?? []),
        { id: event._id, at: event._creationTime },
      ]);
    }
  }
  const cards: CardTrigger[] = [];
  for (const [scope, refusals] of byScope) {
    const triggerKey = `${REFUSAL_KEY_PREFIX}${scope}`;
    const counted = await crossing(
      ctx,
      agentId,
      { trigger: 'repeated-refusal', triggerKey },
      refusals,
    );
    if (counted === undefined) continue;
    cards.push({
      agentId,
      trigger: 'repeated-refusal',
      triggerKey,
      summary: `Day0's gate refused its “${scope}” work in ${counted.length} runs in seven days`,
      evidence: { eventIds: counted.map((refusal) => refusal.id) },
      affected: await scopeReach(ctx, agentId, scope),
      writeScope: isWriteScope(scope),
      now,
    });
  }
  // One list for every scope that crossed in this run: a run can cross more than one (17-O; O-2).
  await openCards(ctx, cards);
}

/**
 * Open a card when three items in thirty days were skipped as outside the role on one willNotDo
 * clause (section 3's skip row): the clause, to amend or confirm. Called where the skip is written
 * (`workVerdicts.applyVerdict`).
 */
export async function openRepeatedSkipCard(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  clause: string,
  now: number,
): Promise<void> {
  const triggerKey = `skip:${clause}`;
  const skips = (
    await eventsOfType(ctx, agentId, 'work.skipped', { after: now - REPEAT_WINDOW_MS })
      .order('desc')
      .take(COUNTED_EVENTS_READ)
  ).filter((event) => (event.payload as { clause?: unknown }).clause === clause);
  // An item counts once under its clause, at its first skip in the window (W16-R37): a page's
  // status change re-admits the out-of-scope skips and the model skips them again, which is the
  // same three items, not three new skips, so a card the manager dismissed stays dismissed.
  const firstSkips = new Map<string, Occurrence>();
  for (const event of skips) {
    const item = String((event.payload as { workItemId?: unknown }).workItemId ?? event._id);
    firstSkips.set(item, { id: event._id, at: event._creationTime });
  }
  const counted = await crossing(ctx, agentId, { trigger: 'repeated-skip', triggerKey }, [
    ...firstSkips.values(),
  ]);
  if (counted === undefined) return;
  await openCard(ctx, {
    agentId,
    trigger: 'repeated-skip',
    triggerKey,
    summary: `${counted.length} items in thirty days were skipped as outside its role under “${clause}”`,
    evidence: { eventIds: counted.map((skip) => skip.id) },
    affected: {
      charterClauses: await charterClausesWhere(
        ctx,
        agentId,
        (candidate) => candidate.field === 'willNotDo' && candidate.text === clause,
      ),
    },
    now,
  });
}

/** How a plan rejection's key reads: one standing card about the employee's rejected plans. */
const REJECTIONS_KEY = 'rejections';

/**
 * Open a card when the manager rejected three of the employee's plans in thirty days (section 3's
 * rejection row): the charter's clauses, to amend or confirm. Called where a plan is cancelled
 * (`managerDecisions.cancelPlanInTransaction`).
 */
export async function openRepeatedRejectionCard(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  now: number,
): Promise<void> {
  const rejections = (
    await eventsOfType(ctx, agentId, 'work.cancelled', { after: now - REPEAT_WINDOW_MS })
      .order('desc')
      .take(COUNTED_EVENTS_READ)
  ).filter((event) => (event.payload as { decidedVia?: unknown }).decidedVia !== undefined);
  const counted = await crossing(
    ctx,
    agentId,
    { trigger: 'repeated-rejection', triggerKey: REJECTIONS_KEY },
    rejections.map((event) => ({ id: event._id, at: event._creationTime })),
  );
  if (counted === undefined) return;
  await openCard(ctx, {
    agentId,
    trigger: 'repeated-rejection',
    triggerKey: REJECTIONS_KEY,
    summary: `You rejected ${counted.length} of its plans in thirty days`,
    evidence: { eventIds: counted.map((rejection) => rejection.id) },
    affected: {
      charterClauses: await charterClausesWhere(
        ctx,
        agentId,
        (clause) => clause.field === 'willDo' || clause.field === 'willNotDo',
      ),
    },
    now,
  });
}
