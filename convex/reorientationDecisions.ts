import { ConvexError, v } from 'convex/values';
import { mutation, query, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent, getCallerOrThrow, verifiedAddressOf } from './ownership';
import { appendEvent } from './eventLog';
import { amendCharterInTransaction } from './charters';
import {
  dismissAgreementInTransaction,
  editAgreementInTransaction,
  recheckAgreementInTransaction,
  retireAgreementInTransaction,
} from './workingAgreements';
import { editRelationshipInTransaction, retireRelationshipInTransaction } from './people';
import { clearPageStatusInTransaction, decideByHand } from './docStatus';
import { grantScopeInTransaction, revokeScopeInTransaction } from './agents';
import {
  recheckSkillInTransaction,
  retireSkillInTransaction,
  withdrawSkillInTransaction,
} from './skillControls';
import { charterClausesWhere, openCard } from './reorientation';
import {
  CARD_ACTION_REFUSALS,
  DEFER_DAYS,
  approvedResultWords,
} from '../src/agent/reorientation-words';
import type { JudgedProposal } from '../src/agent/reorientation-proposal';
import { UNDECIDED_REORIENTATION_STATUSES } from '../src/agent/reorientation-vocabulary';
import { RELATIONSHIP_NOUNS } from '../src/people/words';

/*
 * A reorientation card's decisions (wave 16, 16-O; the wave file's section 5.2, A11): Approve
 * applies the card's proposal through the target's own transaction helper and is the only one
 * that changes anything; Defer sets the card aside until a date (a week unless the manager picks
 * another, A21), the hold of a high-risk card kept; Dismiss closes it with nothing changed. Approve
 * and Dismiss release the work the card held. And the cards an employee's page draws, and the card
 * the manager opens by hand for a change of role or goal.
 *
 * This module sits above the targets it applies (the charter, agreements, the people graph, page
 * status, scopes, skills) and below `convex/work.ts`, which it never imports; the trigger writers
 * import `convex/reorientation.ts`, never this module.
 */

const DAY_MS = 86_400_000;

/** The cards a page draws: every standing card, and the decided ones newest first to this bound. */
const DECIDED_CARDS_SHOWN = 20;

/** The standings a card can be decided from: undecided, or deferred. */
const DECIDABLE = [...UNDECIDED_REORIENTATION_STATUSES, 'deferred'] as const;

/** One card as an employee's page draws it, with the names its ids stand for. */
export interface CardView {
  readonly card: Doc<'reorientations'>;
  /** The work it holds, or reaches, by title and state. */
  readonly workItems: Array<{ _id: Id<'workItems'>; title: string; state: string }>;
  /** The pages its evidence names, by title. */
  readonly pages: Array<{ sourceId: Id<'docSources'>; ref: string; title: string }>;
  readonly skills: Array<{ _id: Id<'skills'>; name: string }>;
  readonly agreements: Array<{ _id: Id<'workingAgreements'>; statement: string }>;
  /** The edges it names, each as the person and what they are to the employee. */
  readonly people: Array<{ _id: Id<'relationships'>; words: string }>;
  /** The charter version an Approve of a charter change would amend, when there is one. */
  readonly charterVersion?: string;
}

/** The card, owned by the caller, and still open to a decision. */
async function decidableCard(
  ctx: MutationCtx,
  reorientationId: Id<'reorientations'>,
): Promise<{ card: Doc<'reorientations'>; agent: Doc<'agents'> }> {
  // The caller first, before anything is read about the card (the anonymous-caller guard).
  await getCallerOrThrow(ctx);
  const card = await ctx.db.get(reorientationId);
  if (card === null) throw new ConvexError(CARD_ACTION_REFUSALS.gone);
  const agent = await assertOwnsAgent(ctx, card.agentId);
  if (!(DECIDABLE as readonly string[]).includes(card.status)) {
    throw new ConvexError(CARD_ACTION_REFUSALS.decided);
  }
  return { card, agent };
}

/** Ask the plan's decision again for each row a decided card held, so a released plan goes on. */
async function releaseHeldWork(ctx: MutationCtx, card: Doc<'reorientations'>): Promise<void> {
  for (const workItemId of card.blockingWork) {
    const row = await ctx.db.get(workItemId);
    if (row?.state !== 'plan-pending') continue;
    await ctx.scheduler.runAfter(0, internal.work.decidePlan, { workItemId, recovery: true });
  }
}

/** Apply a card's proposal through its target's transaction helper; what it did, in words. */
async function applyProposal(
  ctx: MutationCtx,
  card: Doc<'reorientations'>,
  proposed: JudgedProposal,
): Promise<{ result: string; charterId?: Id<'charters'> }> {
  switch (proposed.kind) {
    case 'none':
      return { result: approvedResultWords.none };
    case 'charter-change': {
      await refuseMovedClauses(ctx, card.agentId, proposed);
      const amended = await amendCharterInTransaction(ctx, {
        agentId: card.agentId,
        changes: proposed.changes,
        via: 'reorientation',
        reason: `reorientation: ${card.triggerSummary}`,
      });
      return { result: approvedResultWords.charter(amended.version), charterId: amended.charterId };
    }
    case 'agreement': {
      const agreement = await ctx.db.get(proposed.agreementId);
      if (agreement === null || agreement.userId !== card.userId) {
        throw new ConvexError(CARD_ACTION_REFUSALS.targetGone);
      }
      const action = proposed.action;
      switch (action) {
        case 'keep':
          if (agreement.status !== 'active') throw new ConvexError(CARD_ACTION_REFUSALS.moved);
          break;
        case 'edit':
          await editAgreementInTransaction(ctx, agreement, {
            agentId: card.agentId,
            statement: proposed.statement ?? '',
            via: 'agreements-card',
          });
          break;
        case 'recheck':
          await recheckAgreementInTransaction(ctx, agreement, card.agentId);
          break;
        case 'retire':
          await retireAgreementInTransaction(ctx, agreement, card.agentId);
          break;
        case 'dismiss':
          await dismissAgreementInTransaction(ctx, agreement, card.agentId);
          break;
        default: {
          const unknown: never = action;
          throw new Error(`unhandled agreement action ${String(unknown)}`);
        }
      }
      return { result: approvedResultWords.agreement[action] };
    }
    case 'relationship': {
      const edge = await ctx.db.get(proposed.relationshipId);
      if (edge === null || edge.userId !== card.userId) {
        throw new ConvexError(CARD_ACTION_REFUSALS.targetGone);
      }
      if (proposed.action === 'edit') {
        await editRelationshipInTransaction(ctx, edge, {
          agentId: card.agentId,
          type: proposed.type ?? edge.type,
          ...(proposed.scope !== undefined ? { scope: proposed.scope } : {}),
        });
      } else {
        await retireRelationshipInTransaction(ctx, edge, card.agentId);
      }
      return { result: approvedResultWords.relationship[proposed.action] };
    }
    case 'page-status':
      return await applyPageStatus(ctx, proposed, card.userId);
    case 'scope':
      if (proposed.action === 'revoke') {
        await revokeScopeInTransaction(ctx, { agentId: card.agentId, scope: proposed.scope });
      } else {
        await grantScopeInTransaction(ctx, card.agentId, proposed.scope, 'manager');
      }
      return { result: approvedResultWords.scope(proposed.action, proposed.scope) };
    case 'skill-action': {
      const skill = await ctx.db.get(proposed.skillId);
      if (skill === null || skill.agentId !== card.agentId) {
        throw new ConvexError(CARD_ACTION_REFUSALS.targetGone);
      }
      if (proposed.action === 'recheck') await recheckSkillInTransaction(ctx, skill);
      else if (proposed.action === 'retire') {
        await retireSkillInTransaction(ctx, skill, proposed.rationale.slice(0, 500));
      } else await withdrawSkillInTransaction(ctx, skill, proposed.rationale.slice(0, 500));
      return { result: approvedResultWords.skill(proposed.action, skill.name) };
    }
    default: {
      const unknown: never = proposed;
      throw new Error(`unhandled proposal ${String(unknown)}`);
    }
  }
}

/** The charter's list clauses, by list, as an approved charter's body holds them. */
type ClauseLists = Readonly<
  Record<'willDo' | 'willNotDo' | 'escalationTriggers', readonly string[]>
>;

/**
 * Refuse a charter change whose clause is no longer what the card showed (the second pass's M2):
 * a clause is edited by its place in its list, and another amendment since the proposal may have
 * moved or rewritten it, so Approve compares the text the card drew as "before".
 */
async function refuseMovedClauses(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  proposed: Extract<JudgedProposal, { kind: 'charter-change' }>,
): Promise<void> {
  const edits = proposed.changes.filter((change) => change.kind === 'edit-clause');
  if (edits.length === 0 || proposed.before === undefined) return;
  const charter = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc')
    .first();
  const lists = (charter?.body as { proposedBoundaries?: ClauseLists } | undefined)
    ?.proposedBoundaries;
  for (const edit of edits) {
    if (lists?.[edit.field]?.[edit.index] !== proposed.before) {
      throw new ConvexError(CARD_ACTION_REFUSALS.moved);
    }
  }
}

/** A page's proposed status, set as the manager sets one by hand, or handed back to its source. */
async function applyPageStatus(
  ctx: MutationCtx,
  proposed: Extract<JudgedProposal, { kind: 'page-status' }>,
  owner: string,
): Promise<{ result: string }> {
  const pageAt = async (ref: { sourceId: Id<'docSources'>; ref: string }) =>
    await ctx.db
      .query('docPages')
      .withIndex('by_source_ref', (q) => q.eq('sourceId', ref.sourceId).eq('ref', ref.ref))
      .first();
  const page = await pageAt(proposed.page);
  const source = await ctx.db.get(proposed.page.sourceId);
  if (page === null || source === null || source.userId !== owner) {
    throw new ConvexError(CARD_ACTION_REFUSALS.targetGone);
  }
  if (proposed.status === 'clear') {
    await clearPageStatusInTransaction(ctx, source, page);
    return { result: approvedResultWords.page('clear', page.title) };
  }
  let supersededBy: { sourceId: Id<'docSources'>; ref: string } | undefined;
  if (proposed.status === 'superseded') {
    const successor = proposed.supersededBy ? await pageAt(proposed.supersededBy) : null;
    if (successor === null || (successor.status ?? 'active') !== 'active') {
      throw new ConvexError(CARD_ACTION_REFUSALS.successor);
    }
    supersededBy = { sourceId: successor.sourceId, ref: successor.ref };
  }
  const caller = await getCallerOrThrow(ctx);
  await decideByHand(ctx, {
    source,
    page,
    status: proposed.status,
    supersededBy,
    decidedBy: verifiedAddressOf(caller),
    now: Date.now(),
  });
  return { result: approvedResultWords.page(proposed.status, page.title) };
}

/**
 * Approve a card: apply its proposal through the target's own transaction helper (a charter
 * amendment with `via: 'reorientation'`, an agreement's, an edge's, a page's status, a scope or a
 * skill), close the card `applied` with what it did, and release the work it held. Public, guarded
 * by the card's employee's owner. Writes the target's own rows and events, the card's outcome and
 * `reorientation.approved`.
 *
 * @throws ConvexError when the card is gone or decided, nothing is proposed yet, or the target
 *   refuses (gone, moved on, a successor not current).
 */
export const approve = mutation({
  args: { reorientationId: v.id('reorientations') },
  handler: async (ctx, args): Promise<{ result: string }> => {
    const { card } = await decidableCard(ctx, args.reorientationId);
    if (card.proposed.kind === 'pending') throw new ConvexError(CARD_ACTION_REFUSALS.pending);
    const caller = await getCallerOrThrow(ctx);
    const now = Date.now();
    const decidedBy = verifiedAddressOf(caller);
    // Closed before the target runs and given its outcome after, so the change Approve makes
    // opens no second card about itself on this employee (`openCard` reads an applied card with
    // no outcome, which only this transaction can see).
    await ctx.db.patch(card._id, {
      status: 'applied',
      decidedAt: now,
      ...(decidedBy !== undefined ? { decidedBy } : {}),
    });
    const applied = await applyProposal(ctx, card, card.proposed);
    await ctx.db.patch(card._id, {
      outcome: {
        summary: applied.result,
        ...(applied.charterId !== undefined ? { charterId: applied.charterId } : {}),
      },
    });
    await appendEvent(ctx, {
      agentId: card.agentId,
      type: 'reorientation.approved',
      payload: {
        reorientationId: card._id,
        summary: card.triggerSummary,
        kind: card.proposed.kind,
        result: applied.result,
        ...(applied.charterId !== undefined ? { charterId: applied.charterId } : {}),
      },
      createdAt: now,
    });
    await releaseHeldWork(ctx, card);
    return { result: applied.result };
  },
});

/**
 * Dismiss a card: it closes and nothing changes; the work it held goes on. Public, guarded by the
 * card's employee's owner. Writes the card's standing and `reorientation.dismissed`.
 */
export const dismiss = mutation({
  args: { reorientationId: v.id('reorientations') },
  handler: async (ctx, args): Promise<null> => {
    const { card } = await decidableCard(ctx, args.reorientationId);
    const decidedBy = verifiedAddressOf(await getCallerOrThrow(ctx));
    const now = Date.now();
    await ctx.db.patch(card._id, {
      status: 'dismissed',
      decidedAt: now,
      ...(decidedBy !== undefined ? { decidedBy } : {}),
      outcome: { summary: approvedResultWords.dismissed },
    });
    await appendEvent(ctx, {
      agentId: card.agentId,
      type: 'reorientation.dismissed',
      payload: { reorientationId: card._id, summary: card.triggerSummary },
      createdAt: now,
    });
    await releaseHeldWork(ctx, card);
    return null;
  },
});

/**
 * Defer a card until a date, a week from now unless the manager picks another (A21): nothing
 * changes, a high-risk card keeps its hold, and the sweep opens it again then. Public, guarded by
 * the card's employee's owner. Writes the card's standing and date, and `reorientation.deferred`.
 *
 * @throws ConvexError for a date not after now or more than a year away.
 */
export const defer = mutation({
  args: { reorientationId: v.id('reorientations'), revisitAt: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ revisitAt: number }> => {
    const { card } = await decidableCard(ctx, args.reorientationId);
    const now = Date.now();
    const revisitAt = args.revisitAt ?? now + DEFER_DAYS * DAY_MS;
    if (revisitAt <= now || revisitAt > now + 365 * DAY_MS) {
      throw new ConvexError(CARD_ACTION_REFUSALS.date);
    }
    await ctx.db.patch(card._id, { status: 'deferred', revisitAt });
    await appendEvent(ctx, {
      agentId: card.agentId,
      type: 'reorientation.deferred',
      payload: { reorientationId: card._id, summary: card.triggerSummary, revisitAt },
      createdAt: now,
    });
    return { revisitAt };
  },
});

/**
 * Open a card by hand for a change of the employee's role or goal (section 3's last row): the
 * whole charter is what it reaches, and the judgement proposes the clause to change. Public,
 * guarded by the employee's owner. Writes the card and `reorientation.opened`, and schedules the
 * judgement.
 *
 * @throws ConvexError for an empty summary or one past 300 characters.
 */
export const openByHand = mutation({
  args: { agentId: v.id('agents'), summary: v.string() },
  handler: async (ctx, args): Promise<{ reorientationId: Id<'reorientations'> | null }> => {
    await assertOwnsAgent(ctx, args.agentId);
    const summary = args.summary.replace(/\s+/g, ' ').trim();
    if (summary === '' || summary.length > 300) throw new ConvexError(CARD_ACTION_REFUSALS.summary);
    const now = Date.now();
    const reorientationId = await openCard(ctx, {
      agentId: args.agentId,
      trigger: 'role-changed',
      triggerKey: `role-changed:${now}`,
      summary,
      affected: { charterClauses: await charterClausesWhere(ctx, args.agentId, () => true) },
      now,
    });
    return { reorientationId };
  },
});

/**
 * An employee's cards as its page draws them: every standing card, newest first, then the last
 * decided ones, each with the names its ids stand for. Public, guarded by the employee's owner.
 */
export const listForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<CardView[]> => {
    await assertOwnsAgent(ctx, args.agentId);
    const read = async (status: Doc<'reorientations'>['status'], take: number) =>
      await ctx.db
        .query('reorientations')
        .withIndex('by_agent_status', (q) => q.eq('agentId', args.agentId).eq('status', status))
        .order('desc')
        .take(take);
    const standing = (
      await Promise.all(DECIDABLE.map(async (status) => await read(status, DECIDED_CARDS_SHOWN)))
    ).flat();
    const decided = (
      await Promise.all([
        read('applied', DECIDED_CARDS_SHOWN),
        read('dismissed', DECIDED_CARDS_SHOWN),
      ])
    )
      .flat()
      .sort((left, right) => (right.decidedAt ?? 0) - (left.decidedAt ?? 0))
      .slice(0, DECIDED_CARDS_SHOWN);
    const charter = await ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .first();
    const views: CardView[] = [];
    for (const card of [
      ...standing.sort((left, right) => right.createdAt - left.createdAt),
      ...decided,
    ]) {
      const ids = [...new Set([...card.blockingWork, ...card.affected.workItems])].slice(0, 10);
      const rows = await Promise.all(ids.map(async (id) => await ctx.db.get(id)));
      const pages = await Promise.all(
        card.evidence.pageRefs.slice(0, 10).map(
          async (ref) =>
            await ctx.db
              .query('docPages')
              .withIndex('by_source_ref', (q) => q.eq('sourceId', ref.sourceId).eq('ref', ref.ref))
              .first(),
        ),
      );
      const skills = await Promise.all(
        [...new Set([...card.affected.skills, ...card.evidence.skillIds])]
          .slice(0, 10)
          .map(async (id) => await ctx.db.get(id)),
      );
      const agreements = await Promise.all(
        card.affected.agreements.slice(0, 10).map(async (id) => await ctx.db.get(id)),
      );
      const edges = await Promise.all(
        [...new Set([...card.affected.relationships, ...card.evidence.relationshipIds])]
          .slice(0, 10)
          .map(async (id) => await ctx.db.get(id)),
      );
      const people: CardView['people'] = [];
      for (const edge of edges) {
        if (edge === null) continue;
        const person = await ctx.db.get(edge.toPersonId);
        people.push({
          _id: edge._id,
          words: `${person?.displayName ?? 'Someone'}, its ${RELATIONSHIP_NOUNS[edge.type]}${
            edge.scope !== undefined && edge.scope !== '' ? ` for ${edge.scope}` : ''
          }`,
        });
      }
      views.push({
        card,
        workItems: rows.flatMap((row) =>
          row === null ? [] : [{ _id: row._id, title: row.title, state: row.state }],
        ),
        pages: pages.flatMap((page) =>
          page === null ? [] : [{ sourceId: page.sourceId, ref: page.ref, title: page.title }],
        ),
        skills: skills.flatMap((skill) =>
          skill === null ? [] : [{ _id: skill._id, name: skill.name }],
        ),
        agreements: agreements.flatMap((agreement) =>
          agreement === null ? [] : [{ _id: agreement._id, statement: agreement.statement }],
        ),
        people,
        ...(charter?.approved ? { charterVersion: charter.version } : {}),
      });
    }
    return views;
  },
});
