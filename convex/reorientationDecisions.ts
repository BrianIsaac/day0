import { ConvexError, v } from 'convex/values';
import { internalMutation, mutation, query, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent, getCallerOrThrow, verifiedAddressOf } from './ownership';
import { appendEvent } from './eventLog';
import { callersCard, closeTalkOfCard } from './reorientationTalk';
import { ownerAgents } from './reorientationReach';
import { amendCharterInTransaction } from './charters';
import {
  dismissAgreementInTransaction,
  editAgreementInTransaction,
  recheckAgreementInTransaction,
  recheckOwedInTransaction,
  retireAgreementInTransaction,
} from './workingAgreements';
import { editRelationshipInTransaction, retireRelationshipInTransaction } from './people';
import { clearPageStatusInTransaction, decideByHand } from './docStatus';
import { sendBackToDrafting } from './planRedraft';
import { grantScopeInTransaction, revokeScopeInTransaction } from './agents';
import {
  recheckSkillInTransaction,
  retireSkillInTransaction,
  withdrawSkillInTransaction,
} from './skillControls';
import {
  STANDING_CARDS_READ,
  charterClausesWhere,
  heldStageOf,
  markApproving,
  openCard,
  unboundReportingLines,
} from './reorientation';
import type { Charter } from '../src/agent/charter';
import {
  BY_HAND_CARDS_A_DAY,
  CARD_ACTION_REFUSALS,
  DEFER_DAYS,
  PROPOSAL_CHANGED,
  approvedResultWords,
  byHandLimitWords,
  proposalFingerprint,
  type HeldCounts,
} from '../src/agent/reorientation-words';
import { agentZone, dayKey } from '../src/lib/zone';
import type { JudgedProposal } from '../src/agent/reorientation-proposal';
import {
  BOUND_MET,
  REORIENTATION_BLOCKING_LIMIT,
  UNDECIDED_REORIENTATION_STATUSES,
} from '../src/agent/reorientation-vocabulary';
import { log } from '../src/lib/logger';
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

/**
 * The rows one read of an employee's cards resolves into names, across all of them (W16-R24: up
 * to about sixty a card over about 170 cards, near the most reads a query may make). Ten cards
 * with every list full fit; a card past the budget is drawn bare, with what it holds still read.
 */
const CARD_NAMES_READ = 600;

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
  /**
   * The lines of an organisation connection's ledger it rests on (`evidence.connectionEventIds`;
   * wave 17), as stored, for the card to say in the record's words. None on a card opened before
   * 0.21.0.
   */
  readonly ledger: Array<Pick<Doc<'connectionEvents'>, '_id' | 'type' | 'payload' | 'createdAt'>>;
  /** What the card holds, as the hold stops it: none once it is decided (M3). */
  readonly held: HeldCounts;
  /** The charter version an Approve of a charter change would amend, when there is one. */
  readonly charterVersion?: string;
  /**
   * On a handover's card, the words of each reporting-line rule the charter carries that binds no
   * clause, so the card names what the old manager's rule was (W16-R21).
   */
  readonly carriedRules?: string[];
}

/** The card, owned by the caller, and still open to a decision. */
async function decidableCard(
  ctx: MutationCtx,
  reorientationId: Id<'reorientations'>,
): Promise<{ card: Doc<'reorientations'>; agent: Doc<'agents'> }> {
  // The caller first, before anything is read about the card (the anonymous-caller guard); a card
  // that is gone and another owner's answer alike (W16-R35).
  const owned = await callersCard(ctx, reorientationId);
  if (owned === null) throw new ConvexError(CARD_ACTION_REFUSALS.gone);
  const { card, agent } = owned;
  if (!(DECIDABLE as readonly string[]).includes(card.status)) {
    throw new ConvexError(CARD_ACTION_REFUSALS.decided);
  }
  return { card, agent };
}

/**
 * Let go the rows a decided card held. Where the decision changed what their plans were drafted
 * under (`changed`: an Approve that amended the charter, changed an edge, a page, an access or a
 * skill), an undecided plan is sent back to drafting, so neither Day0 under the autonomy switch
 * nor the manager decides a plan written for what no longer holds (V17-9, option (a); the
 * joins). Otherwise each plan's decision is asked again, so a released plan goes on.
 */
async function releaseHeldWork(
  ctx: MutationCtx,
  card: Doc<'reorientations'>,
  changed: boolean,
): Promise<void> {
  const now = Date.now();
  for (const workItemId of card.blockingWork) {
    const row = await ctx.db.get(workItemId);
    if (row?.state !== 'plan-pending') continue;
    if (changed && row.decision?.decidedAt === undefined) {
      await sendBackToDrafting(ctx, row, { card }, now);
      continue;
    }
    await ctx.scheduler.runAfter(0, internal.work.decidePlan, { workItemId, recovery: true });
  }
}

/** The employees whose sibling cards an Approve closes in its own transaction; the rest ride a chain. */
const SIBLINGS_INLINE = 8;

/** The employees one link of the sibling chain reads. */
const SIBLINGS_PER_LINK = 25;

/** An edge for everyone that one card's Approve decided, as its sibling cards are closed by it. */
const siblingDecisionValidator = v.object({
  relationshipId: v.id('relationships'),
  /** What the sibling cards' outcome says: whose card decided the edge, and what that did. */
  outcome: v.string(),
  decidedBy: v.optional(v.string()),
  now: v.number(),
});

type SiblingDecision = typeof siblingDecisionValidator.type;

/**
 * Close one employee's undecided cards about an edge for everyone that another employee's card
 * decided (the pre-tag's row 6: Approve on a sibling met "This relationship has already ended",
 * and the only way out was Dismiss, one card an employee). A card about that edge alone closes as
 * decided there, its talk with it, and the work it held goes on; a card that also names something
 * else stays, and a proposal on it that names the ended edge is asked for again.
 */
async function closeSiblingCards(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  decision: SiblingDecision,
): Promise<void> {
  for (const status of DECIDABLE) {
    const cards = await ctx.db
      .query('reorientations')
      .withIndex('by_agent_status', (q) => q.eq('agentId', agentId).eq('status', status))
      .take(STANDING_CARDS_READ);
    for (const card of cards) {
      const edges = new Set([...card.evidence.relationshipIds, ...card.affected.relationships]);
      if (!edges.has(decision.relationshipId)) continue;
      const alone =
        edges.size === 1 &&
        card.affected.charterClauses.length === 0 &&
        card.evidence.pageRefs.length === 0 &&
        card.evidence.skillIds.length === 0 &&
        card.evidence.correctionIds.length === 0;
      if (alone) {
        await ctx.db.patch(card._id, {
          status: 'dismissed',
          decidedAt: decision.now,
          revisitAt: undefined,
          ...(decision.decidedBy !== undefined ? { decidedBy: decision.decidedBy } : {}),
          outcome: { summary: decision.outcome },
        });
        await appendEvent(ctx, {
          agentId,
          type: 'reorientation.dismissed',
          payload: {
            reorientationId: card._id,
            summary: card.triggerSummary,
            outcome: decision.outcome,
          },
          createdAt: decision.now,
        });
        await closeTalkOfCard(ctx, card._id);
        // Another card's Approve changed the edge this card's plans were drafted under.
        await releaseHeldWork(ctx, card, true);
      } else if (
        card.proposed.kind === 'relationship' &&
        card.proposed.relationshipId === decision.relationshipId
      ) {
        await ctx.db.patch(card._id, { proposed: { kind: 'pending' } });
        await ctx.scheduler.runAfter(0, internal.reorientationActions.propose, {
          reorientationId: card._id,
        });
      }
    }
  }
}

/** Close the sibling cards of the first employees of a list, and schedule one function for the rest. */
async function closeSiblingsOf(
  ctx: MutationCtx,
  agentIds: readonly Id<'agents'>[],
  decision: SiblingDecision,
  take: number,
): Promise<void> {
  for (const agentId of agentIds.slice(0, take)) await closeSiblingCards(ctx, agentId, decision);
  const rest = agentIds.slice(take);
  if (rest.length > 0) {
    await ctx.scheduler.runAfter(0, internal.reorientationDecisions.closeSiblingCardsLater, {
      agentIds: rest,
      decision,
    });
  }
}

/**
 * Close the sibling cards of the next employees an edge for everyone reaches, and pass the rest
 * on (wave 17, 17-O): one function at a time, as the cards' own chain. Internal; scheduled by
 * `approve` and by itself. Writes each closed card's standing and outcome, and its talk's close.
 */
export const closeSiblingCardsLater = internalMutation({
  args: { agentIds: v.array(v.id('agents')), decision: siblingDecisionValidator },
  handler: async (ctx, args): Promise<void> => {
    await closeSiblingsOf(ctx, args.agentIds, args.decision, SIBLINGS_PER_LINK);
  },
});

/**
 * After a card's Approve changed or retired an edge that holds for everyone, close every other
 * employee's undecided card about that edge as decided on this one.
 */
async function closeSiblingsAfterApprove(
  ctx: MutationCtx,
  card: Doc<'reorientations'>,
  decided: {
    readonly result: string;
    readonly decidedBy: string | undefined;
    readonly now: number;
  },
): Promise<void> {
  if (card.proposed.kind !== 'relationship') return;
  const edge = await ctx.db.get(card.proposed.relationshipId);
  if (edge === null || edge.fromAgentId !== undefined || edge.fromPersonId !== undefined) return;
  const approved = await ctx.db.get(card.agentId);
  const others = (await ownerAgents(ctx, edge.userId))
    .map((agent) => agent._id)
    .filter((agentId) => agentId !== card.agentId);
  await closeSiblingsOf(
    ctx,
    others,
    {
      relationshipId: edge._id,
      outcome: approvedResultWords.decidedElsewhere(
        approved?.name ?? 'another employee',
        decided.result,
      ),
      ...(decided.decidedBy !== undefined ? { decidedBy: decided.decidedBy } : {}),
      now: decided.now,
    },
    SIBLINGS_INLINE,
  );
}

/** What Approve did to the card's target. */
interface Applied {
  /** What it did, in words. */
  readonly result: string;
  readonly charterId?: Id<'charters'>;
  /**
   * Whether it changed what a plan the card held was drafted under: the charter, an agreement in
   * force, an edge, a page's status, an access or a skill (V17-9). A keep, a re-check and a
   * proposal of nothing change nothing a plan rests on.
   */
  readonly changed: boolean;
}

/** Apply a card's proposal through its target's transaction helper; what it did, in words. */
async function applyProposal(
  ctx: MutationCtx,
  card: Doc<'reorientations'>,
  proposed: JudgedProposal,
): Promise<Applied> {
  switch (proposed.kind) {
    case 'none':
      return { result: approvedResultWords.none, changed: false };
    case 'charter-change': {
      await refuseMovedClauses(ctx, card.agentId, proposed);
      // The charter's own refusals are each the charter no longer taking the change, said in the
      // card's words (m15), and each in a sentence of its own (W16-R24): a change that changes
      // nothing and a charter not approved yet were both said as "has moved on since".
      const amended = await amendCharterInTransaction(ctx, {
        agentId: card.agentId,
        changes: proposed.changes,
        via: 'reorientation',
        reason: card.triggerSummary,
      }).catch((error: unknown) => {
        if (error instanceof ConvexError) throw error;
        // Read by the amendment's own words (`amendCharterInTransaction`'s three plain errors),
        // which the two approve tests of these sentences hold end to end.
        const said = error instanceof Error ? error.message : '';
        if (said.includes('changes nothing')) throw new ConvexError(CARD_ACTION_REFUSALS.unchanged);
        if (said.includes('not approved yet') || said.includes('no charter to amend')) {
          throw new ConvexError(CARD_ACTION_REFUSALS.noCharter);
        }
        throw new ConvexError(CARD_ACTION_REFUSALS.moved);
      });
      return {
        result: approvedResultWords.charter(amended.version),
        charterId: amended.charterId,
        changed: true,
      };
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
            via: 'reorientation',
          });
          break;
        case 'recheck':
          // An owed check's card checks every agreement it names that is still owed one (RM34 (a)).
          if (card.trigger !== 'agreement-check-owed') {
            await recheckAgreementInTransaction(ctx, agreement, card.agentId);
          } else if (
            !(await recheckOwedInTransaction(ctx, card.agentId, card.affected.agreements))
          ) {
            throw new ConvexError(CARD_ACTION_REFUSALS.checked);
          }
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
      // A proposed agreement set aside was never in force, so no plan rests on it.
      return {
        result: approvedResultWords.agreement[action],
        changed: action === 'edit' || action === 'retire',
      };
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
      return { result: approvedResultWords.relationship[proposed.action], changed: true };
    }
    case 'page-status':
      return { ...(await applyPageStatus(ctx, proposed, card.userId)), changed: true };
    case 'scope':
      if (proposed.action === 'revoke') {
        await revokeScopeInTransaction(ctx, { agentId: card.agentId, scope: proposed.scope });
      } else {
        await grantScopeInTransaction(ctx, card.agentId, proposed.scope, 'manager');
      }
      return { result: approvedResultWords.scope(proposed.action, proposed.scope), changed: true };
    case 'skill-action': {
      const skill = await ctx.db.get(proposed.skillId);
      if (skill === null || skill.agentId !== card.agentId) {
        throw new ConvexError(CARD_ACTION_REFUSALS.targetGone);
      }
      if (proposed.action === 'recheck') await recheckSkillInTransaction(ctx, skill);
      else if (proposed.action === 'retire') {
        await retireSkillInTransaction(ctx, skill, proposed.rationale.slice(0, 500));
      } else await withdrawSkillInTransaction(ctx, skill, proposed.rationale.slice(0, 500));
      return {
        result: approvedResultWords.skill(proposed.action, skill.name),
        changed: proposed.action !== 'recheck',
      };
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
    // Only a status the manager set is handed back; the source's own has nothing to clear (M2).
    if (page.statusSource !== 'manager') throw new ConvexError(CARD_ACTION_REFUSALS.moved);
    await clearPageStatusInTransaction(ctx, source, page);
    return { result: approvedResultWords.page('clear', page.title) };
  }
  // A status the page already holds from its source changes nothing but pins the page to the
  // manager, after which the source's own later word is ignored (W17-R2, D-1 (a)).
  if (
    page.statusSource !== 'manager' &&
    (page.status ?? 'active') === proposed.status &&
    (proposed.status !== 'superseded' ||
      (page.supersededBy?.sourceId === proposed.supersededBy?.sourceId &&
        page.supersededBy?.ref === proposed.supersededBy?.ref))
  ) {
    throw new ConvexError(CARD_ACTION_REFUSALS.held);
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
 * skill), close the card `applied` with what it did and its talk with it, and release the work it
 * held. Public, guarded by the card's employee's owner. Writes the target's own rows and events,
 * the card's outcome, its talk's close and `reorientation.approved`; and, where it changed or
 * retired an edge that holds for everyone, the close of every other employee's undecided card
 * about that edge as decided here (the first in this transaction, the rest by a chain).
 *
 * @throws ConvexError when the card is gone or decided, nothing is proposed yet, the proposal is
 *   no longer the one the page showed, or the target refuses (gone, moved on, a successor not
 *   current).
 */
export const approve = mutation({
  args: {
    reorientationId: v.id('reorientations'),
    /**
     * The proposal the manager was shown (`proposalFingerprint`): the page sends it with the
     * press, and Approve is refused when the card proposes something else by then (W16-R24).
     * Absent from a caller that draws no card, which approves what the card holds.
     */
    shown: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ result: string }> => {
    const { card } = await decidableCard(ctx, args.reorientationId);
    if (card.proposed.kind === 'pending') throw new ConvexError(CARD_ACTION_REFUSALS.pending);
    if (args.shown !== undefined && args.shown !== proposalFingerprint(card.proposed)) {
      throw new ConvexError(PROPOSAL_CHANGED);
    }
    const caller = await getCallerOrThrow(ctx);
    const now = Date.now();
    const decidedBy = verifiedAddressOf(caller);
    // Closed before the target runs and given its outcome after; the change Approve makes opens
    // no second card about itself on this employee, nor on the others an edge for everyone
    // reaches (`markApproving`).
    await markApproving(ctx, card);
    await ctx.db.patch(card._id, {
      status: 'applied',
      decidedAt: now,
      ...(decidedBy !== undefined ? { decidedBy } : {}),
    });
    const applied = await applyProposal(ctx, card, card.proposed);
    await closeTalkOfCard(ctx, card._id);
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
    await releaseHeldWork(ctx, card, applied.changed);
    await closeSiblingsAfterApprove(ctx, card, { result: applied.result, decidedBy, now });
    return { result: applied.result };
  },
});

/**
 * Dismiss a card: it closes, its talk with it, and nothing changes; the work it held goes on.
 * Public, guarded by the card's employee's owner. Writes the card's standing, its talk's close and
 * `reorientation.dismissed`.
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
    await closeTalkOfCard(ctx, card._id);
    await appendEvent(ctx, {
      agentId: card.agentId,
      type: 'reorientation.dismissed',
      payload: { reorientationId: card._id, summary: card.triggerSummary },
      createdAt: now,
    });
    await releaseHeldWork(ctx, card, false);
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
    if (!Number.isFinite(revisitAt) || revisitAt <= now || revisitAt > now + 365 * DAY_MS) {
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

/** The most a by-hand card's summary grows to as later changes of the day join it. */
const JOINED_SUMMARY_CHARS = 600;

/** Whether the card's proposal is one a finished talk put there: the manager's own, never reset. */
async function proposedByTalk(
  ctx: MutationCtx,
  reorientationId: Id<'reorientations'>,
): Promise<boolean> {
  const talk = await ctx.db
    .query('reorientationTalks')
    .withIndex('by_reorientation', (q) => q.eq('reorientationId', reorientationId))
    .first();
  return talk !== null && talk.state === 'finished' && talk.outcome !== undefined;
}

/**
 * Open a card by hand for a change of the employee's role or goal (section 3's last row): the
 * whole charter is what it reaches, and the judgement proposes the clause to change. Public,
 * guarded by the employee's owner. Writes the card and `reorientation.opened`, and schedules the
 * judgement.
 *
 * @returns The card; whether the change joined one already standing that day; whether the
 *   proposal is asked for again; and whether the typed words are on the card, which a joined
 *   change past the summary's bound is not (the joined event keeps them).
 * @throws ConvexError for an empty summary or one past 300 characters.
 */
export const openByHand = mutation({
  args: { agentId: v.id('agents'), summary: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    reorientationId: Id<'reorientations'> | null;
    joined: boolean;
    asked: boolean;
    onCard: boolean;
  }> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const summary = args.summary.replace(/\s+/g, ' ').trim();
    if (summary === '' || summary.length > 300) throw new ConvexError(CARD_ACTION_REFUSALS.summary);
    const now = Date.now();
    // Three by-hand cards an employee a day (W16-R35): each asks the model for a proposal, and a
    // card dismissed and opened again was one call each time. A change that joins the day's
    // standing card opens none, and is not refused.
    const today = await ctx.db
      .query('reorientations')
      .withIndex('by_agent_day_trigger', (q) =>
        q
          .eq('agentId', args.agentId)
          .eq('day', dayKey(now, agentZone(agent)))
          .eq('trigger', 'role-changed'),
      )
      .take(BY_HAND_CARDS_A_DAY + 1);
    const standing = today.some((card) => (DECIDABLE as readonly string[]).includes(card.status));
    if (!standing && today.length >= BY_HAND_CARDS_A_DAY) {
      throw new ConvexError(byHandLimitWords(agent.name));
    }
    const triggerKey = `role-changed:${now}`;
    const reorientationId = await openCard(ctx, {
      agentId: args.agentId,
      trigger: 'role-changed',
      triggerKey,
      summary,
      affected: { charterClauses: await charterClausesWhere(ctx, args.agentId, () => true) },
      now,
    });
    const card = reorientationId === null ? null : await ctx.db.get(reorientationId);
    // A second change typed the same day joins the card already standing (one card a kind a day):
    // its words go onto that card beside the first (W16-R24), once, and while the summary stays
    // inside its bound (the joined event keeps them either way).
    const joined = card !== null && card.triggerKey !== triggerKey;
    let asked = !joined;
    // Whether the typed words are on the card: a joined change past the summary's bound is not.
    let onCard = true;
    if (card !== null && joined) {
      const held = card.triggerSummary.replace(/[.;\s]+$/u, '');
      const said = held.toLowerCase().includes(summary.replace(/[.;\s]+$/u, '').toLowerCase());
      const fits = held.length + 2 + summary.length <= JOINED_SUMMARY_CHARS;
      onCard = said || fits;
      // The proposal is asked again over both only where it is the judgement's own and the card
      // is open: a talk under way finishes in its own, and a finished talk's is the manager's.
      asked =
        !said &&
        fits &&
        card.status === 'open' &&
        card.proposed.kind !== 'pending' &&
        !(await proposedByTalk(ctx, card._id));
      if (!said && fits) {
        await ctx.db.patch(card._id, {
          triggerSummary: `${held}; ${summary}`,
          ...(asked ? { proposed: { kind: 'pending' as const } } : {}),
        });
      }
      if (asked) {
        await ctx.scheduler.runAfter(0, internal.reorientationActions.propose, {
          reorientationId: card._id,
        });
      }
      // A card still waiting on its first proposal is judged over both by the join itself.
      asked ||= !said && fits && card.status === 'open' && card.proposed.kind === 'pending';
    }
    return { reorientationId, joined, asked, onCard };
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
      await Promise.all(DECIDABLE.map(async (status) => await read(status, STANDING_CARDS_READ)))
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
    // Each source is read once, however many cards and pages name it.
    const sources = new Map<Id<'docSources'>, Promise<Doc<'docSources'> | null>>();
    const sourceOf = async (sourceId: Id<'docSources'>): Promise<Doc<'docSources'> | null> => {
      const read = sources.get(sourceId) ?? ctx.db.get(sourceId);
      sources.set(sourceId, read);
      return await read;
    };
    const views: CardView[] = [];
    // The rows read into names so far, and the cards drawn bare once the budget was spent.
    let spent = 0;
    let leftBare = 0;
    for (const card of [
      ...standing.sort((left, right) => right.createdAt - left.createdAt),
      ...decided,
    ]) {
      const holding =
        card.risk === 'high' && (DECIDABLE as readonly string[]).includes(card.status);
      const workIds = [...new Set([...card.blockingWork, ...card.affected.workItems])].slice(0, 10);
      const pageRefs = card.evidence.pageRefs.slice(0, 10);
      const skillIds = [...new Set([...card.affected.skills, ...card.evidence.skillIds])].slice(
        0,
        10,
      );
      const agreementIds = card.affected.agreements.slice(0, 10);
      const edgeIds = [
        ...new Set([...card.affected.relationships, ...card.evidence.relationshipIds]),
      ].slice(0, 10);
      const ledgerIds = (card.evidence.connectionEventIds ?? []).slice(0, 10);
      // An edge is two rows, itself and its person.
      const wanted =
        workIds.length +
        pageRefs.length +
        skillIds.length +
        agreementIds.length +
        2 * edgeIds.length +
        ledgerIds.length;
      const named = spent + wanted <= CARD_NAMES_READ;
      if (named) spent += wanted;
      else leftBare += 1;
      // A bare card still reads the work it holds: its line says what waits on it.
      const ids = named ? workIds : holding ? card.blockingWork.slice(0, 10) : [];
      const rows = await Promise.all(ids.map(async (id) => await ctx.db.get(id)));
      // Only rows of the card's own owner are named on it: after a handover the old manager's
      // graph, agreements and documentation stay theirs (W16-R1, `people.ts`' rule).
      const owned = <Row extends { readonly userId: string }>(row: Row | null): Row | null =>
        row !== null && row.userId === card.userId ? row : null;
      const pages = await Promise.all(
        (named ? pageRefs : []).map(async (ref) => {
          if (owned(await sourceOf(ref.sourceId)) === null) return null;
          return await ctx.db
            .query('docPages')
            .withIndex('by_source_ref', (q) => q.eq('sourceId', ref.sourceId).eq('ref', ref.ref))
            .first();
        }),
      );
      const skills = await Promise.all(
        (named ? skillIds : []).map(async (id) => await ctx.db.get(id)),
      );
      const agreements = await Promise.all(
        (named ? agreementIds : []).map(async (id) => owned(await ctx.db.get(id))),
      );
      const edges = await Promise.all(
        (named ? edgeIds : []).map(async (id) => owned(await ctx.db.get(id))),
      );
      const people: CardView['people'] = [];
      for (const edge of edges) {
        if (edge === null) continue;
        const person = owned(await ctx.db.get(edge.toPersonId));
        people.push({
          _id: edge._id,
          words: `${person?.displayName ?? 'Someone'}, its ${RELATIONSHIP_NOUNS[edge.type]}${
            edge.scope !== undefined && edge.scope !== '' ? ` for ${edge.scope}` : ''
          }`,
        });
      }
      const ledger = await Promise.all(
        (named ? ledgerIds : []).map(async (id) => await ctx.db.get(id)),
      );
      const notHeld =
        holding && card.blockingWork.length >= REORIENTATION_BLOCKING_LIMIT
          ? card.affected.workItems.filter((id) => !card.blockingWork.includes(id)).length
          : 0;
      const stages = holding
        ? rows.flatMap((row) =>
            row !== null && card.blockingWork.includes(row._id) ? [heldStageOf(row)] : [],
          )
        : [];
      views.push({
        card,
        held: {
          plans: stages.filter((stage) => stage === 'plan').length,
          runs: stages.filter((stage) => stage === 'run').length,
          // The open work the change reached past what a card holds (W16-R22): said, not held.
          ...(notHeld > 0 ? { notHeld } : {}),
        },
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
        ledger: ledger.flatMap((line) =>
          line === null
            ? []
            : [
                {
                  _id: line._id,
                  type: line.type,
                  payload: line.payload as unknown,
                  createdAt: line.createdAt,
                },
              ],
        ),
        ...(charter?.approved ? { charterVersion: charter.version } : {}),
        ...(card.trigger === 'manager-changed' && charter?.approved
          ? { carriedRules: unboundReportingLines(charter.body as Charter) }
          : {}),
      });
    }
    if (leftBare > 0) {
      log.warn(BOUND_MET, {
        bound: 'CARD_NAMES_READ',
        limit: CARD_NAMES_READ,
        agentId: args.agentId,
        leftBare,
      });
    }
    return views;
  },
});
