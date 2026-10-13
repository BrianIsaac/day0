import { v } from 'convex/values';
import { mutation, query, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent, getCallerOrThrow, ownedAgentOrNull } from './ownership';
import { appendEvent } from './eventLog';
import { proposalInputOf } from './reorientation';
import {
  oneToOneTurnValidator,
  reorientationProposalValidator,
  reorientationTalkProposalValidator,
} from './schema';
import {
  MOVED_ON_REFUSAL,
  REPLY_MAX_CHARS,
  conversationOf,
  decideAnswer,
  repliesIn,
  type OneToOneTurn,
} from '../src/agent/one-to-one-conversation';
import {
  PROPOSAL_CHANGES,
  ProposalRefused,
  ScopeNotAPhrase,
  proposalOf,
  type JudgedProposal,
} from '../src/agent/reorientation-proposal';
import {
  TALK_NOTHING_SAID,
  decideTalkTurn,
  managerQuotes,
  talkRefusal,
  type TalkOutcome,
} from '../src/agent/reorientation-talk';
import { talkSystemPrompt } from '../src/agent/reorientation-talk-prompts';
import {
  REORIENTATION_TALK_STATES,
  UNDECIDED_REORIENTATION_STATUSES,
} from '../src/agent/reorientation-vocabulary';
import { log } from '../src/lib/logger';

/*
 * Discuss (wave 16, 16-D; the wave file's section 5.3, RM10 (a)): a conversation of its own about
 * one reorientation card, kept on the card's one talk (`reorientationTalks`, 16-K's table) turn by
 * turn on the one-to-one's pure rules (`src/agent/one-to-one-conversation.ts`, through
 * `src/agent/reorientation-talk.ts`), so a room closed at any point reopens on the same talk.
 * Opening it puts the card at `discussing`; its outcome replaces the card's proposal
 * (`reorientation.proposed` with `by: 'discussion'`) and puts the card back at `open`. It never
 * applies anything: only Approve does (`convex/reorientationDecisions.ts`). The one-to-one's
 * session (`voiceSessions`) is never read or written here.
 *
 * Below `work.ts`: it imports the floor `reorientation.ts`, `ownership`, `eventLog` and `schema`.
 */

/** The statuses a talk may be held on: an undecided card, or one set aside until a date. */
const TALKABLE_STATUSES: readonly Doc<'reorientations'>['status'][] = [
  ...UNDECIDED_REORIENTATION_STATUSES,
  'deferred',
];

/** Said to a room whose card was decided: the talk about it is closed with it. */
const CARD_DECIDED = 'The card was decided, so the talk about it is closed.';

/** Said to a room whose card is gone, or whose employee is. */
const CARD_GONE = 'This card is gone.';

/**
 * Said to a room writing to a conversation the talk has set aside. No talk sets one aside yet (a
 * talk has no restart, K-11); the stamp is checked as the one-to-one checks its own, so a restart
 * added later refuses a write from before it.
 */
const STARTED_AGAIN = 'The talk started again in another window. Reload to carry on.';

/** Said when the candidates a turn was drawn from are not the card's now. */
const CARD_CHANGED = 'The card changed while you talked. Ask again.';

/** Said to Put this on the card asked again of a talk already on the card. */
const ALREADY_ON_CARD = 'This talk is already on the card. Reply to take it up again.';

/** Said when an outcome names what the card does not hold, or an action it does not take. */
const OUTCOME_REFUSED = 'The proposal named something this card cannot change. Ask again.';

/** Said when an outcome's new scope for a relationship is a sentence, not a phrase (W16-R3). */
const SCOPE_REFUSED =
  'The proposal put a sentence where a short phrase of what the relationship covers goes. Ask again.';

/** What a turn of the talk is: one of the one-to-one's three, or a finish. */
const talkRequestValidator = v.union(
  v.object({ kind: v.literal('open') }),
  v.object({
    kind: v.literal('reply'),
    question: v.union(v.string(), v.null()),
    replies: v.array(v.object({ id: v.string(), text: v.string() })),
  }),
  v.object({
    kind: v.literal('ask-again'),
    question: v.union(v.string(), v.null()),
    replies: v.array(v.object({ id: v.string(), text: v.string() })),
    discarding: v.union(v.string(), v.null()),
  }),
  v.object({
    kind: v.literal('finish'),
    question: v.union(v.string(), v.null()),
    replies: v.array(v.object({ id: v.string(), text: v.string() })),
  }),
);

/** The `reorientationComplete` call's proposal and quotes, as the route hands them on. */
const talkOutcomeValidator = v.object({
  reply: v.object({
    change: v.union(
      ...(PROPOSAL_CHANGES.map((change) => v.literal(change)) as [
        ReturnType<typeof v.literal<(typeof PROPOSAL_CHANGES)[number]>>,
      ]),
    ),
    candidate: v.union(v.number(), v.null()),
    action: v.union(v.string(), v.null()),
    text: v.union(v.string(), v.null()),
    rationale: v.string(),
  }),
  quotes: v.array(v.string()),
});

/** The card a talk is about, owned by the caller: the caller first (the anonymous-caller guard). */
async function ownedCard(
  ctx: MutationCtx,
  reorientationId: Id<'reorientations'>,
): Promise<Doc<'reorientations'> | null> {
  await getCallerOrThrow(ctx);
  const card = await ctx.db.get(reorientationId);
  if (card === null) return null;
  await assertOwnsAgent(ctx, card.agentId);
  return card;
}

/** A talk and its card, both owned by the caller, or why the talk cannot be written. */
async function ownedTalk(
  ctx: MutationCtx,
  talkId: Id<'reorientationTalks'>,
  conversation: number,
): Promise<
  | { ok: true; talk: Doc<'reorientationTalks'>; card: Doc<'reorientations'> }
  | { ok: false; refusal: string }
> {
  await getCallerOrThrow(ctx);
  const talk = await ctx.db.get(talkId);
  if (talk === null) return { ok: false, refusal: CARD_GONE };
  await assertOwnsAgent(ctx, talk.agentId);
  const card = await ctx.db.get(talk.reorientationId);
  if (card === null) return { ok: false, refusal: CARD_GONE };
  if (!TALKABLE_STATUSES.includes(card.status)) {
    await closeTalk(ctx, talk);
    return { ok: false, refusal: CARD_DECIDED };
  }
  if (conversationOf(talk) !== conversation) return { ok: false, refusal: STARTED_AGAIN };
  return { ok: true, talk, card };
}

/** Close a talk whose card was decided under it. */
async function closeTalk(ctx: MutationCtx, talk: Doc<'reorientationTalks'>): Promise<void> {
  if (talk.state === 'closed') return;
  await ctx.db.patch(talk._id, {
    state: 'closed',
    endedAt: talk.endedAt ?? Date.now(),
    replyDraft: undefined,
  });
}

/**
 * Close the card's talk, if it has one, in the transaction that decides the card: Approve and
 * Dismiss end what the talk was about, so its reply being typed goes with it (16-D's m8).
 *
 * @param ctx - The deciding mutation's context.
 * @param reorientationId - The card being decided.
 */
export async function closeTalkOfCard(
  ctx: MutationCtx,
  reorientationId: Id<'reorientations'>,
): Promise<void> {
  const talk = await talkOfCard(ctx, reorientationId);
  if (talk !== null) await closeTalk(ctx, talk);
}

/** The most talks of one employee a handover clears. */
const HANDOVER_TALKS_READ = 1_000;

/**
 * Close every talk of an employee being handed over, with the old manager's words cleared (W16-R1,
 * D-5 (a)): the turns, the reply being typed and the quotes an outcome kept, as the one-to-one's
 * are (`voice.endOneToOnesForHandover`). The proposal an outcome put on its card stays with the
 * card. Called in the handover's transaction (`transferAcceptance`).
 *
 * @param ctx - The handover's mutation context.
 * @param agentId - The employee handed over.
 * @param now - The handover's time.
 */
export async function clearTalksForHandover(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  now: number,
): Promise<void> {
  const talks = await ctx.db
    .query('reorientationTalks')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .take(HANDOVER_TALKS_READ);
  for (const talk of talks) {
    await ctx.db.patch(talk._id, {
      state: 'closed',
      turns: [],
      replyDraft: undefined,
      endedAt: talk.endedAt ?? now,
      ...(talk.outcome !== undefined ? { outcome: { ...talk.outcome, quotes: [] } } : {}),
    });
  }
}

/** The card's one talk, if it has one. */
async function talkOfCard(
  ctx: MutationCtx,
  reorientationId: Id<'reorientations'>,
): Promise<Doc<'reorientationTalks'> | null> {
  return await ctx.db
    .query('reorientationTalks')
    .withIndex('by_reorientation', (q) => q.eq('reorientationId', reorientationId))
    .first();
}

/**
 * The candidates a proposal about the card chooses among, as one string: an outcome is written
 * only against the candidates its turn was drawn from, so a number never lands on a different
 * clause, agreement, edge, page, scope or skill.
 */
async function candidatesKeyOf(
  ctx: MutationCtx,
  card: Doc<'reorientations'>,
): Promise<{
  input: NonNullable<Awaited<ReturnType<typeof proposalInputOf>>>;
  key: string;
} | null> {
  const input = await proposalInputOf(ctx, card);
  return input === null ? null : { input, key: JSON.stringify(input.candidates) };
}

/**
 * What `takeTurn` hands the route: the talk, the turns to answer from, the candidates' key, and
 * the employee's name and the talk's system prompt, built from the card as it stands.
 */
const takenValidator = v.union(
  v.object({
    taken: v.literal(true),
    talkId: v.id('reorientationTalks'),
    conversation: v.number(),
    turns: v.array(oneToOneTurnValidator),
    answering: v.union(v.string(), v.null()),
    candidatesKey: v.string(),
    employeeName: v.string(),
    system: v.string(),
    /** For a finish, how many of the replies it carried the talk had no room to keep. */
    unkept: v.number(),
  }),
  v.object({ taken: v.literal(false), refusal: v.string() }),
);

/**
 * Take a turn of the card's talk before it is put to the employee, and hand back the talk, the
 * turns the employee answers from (`decideTalkTurn`), the manager turn it answers, the key of
 * the candidates it may propose among and the system prompt it answers under
 * (`talkSystemPrompt`). The first turn opens the card's one talk; every turn puts
 * the card at `discussing`, a talk that ended taken up again where it stopped.
 *
 * Public, owner-guarded (`assertOwnsAgent` through the card); called by the talk's route as the
 * manager. Writes the talk's `turns`, `state` and `replyDraft` and the card's `status`.
 *
 * @returns The turn taken, or the refusal the room shows: the card decided or gone, or a turn
 *   that does not follow the talk as it is kept.
 */
export const takeTurn = mutation({
  args: { reorientationId: v.id('reorientations'), request: talkRequestValidator },
  returns: takenValidator,
  handler: async (ctx, args) => {
    const card = await ownedCard(ctx, args.reorientationId);
    const talk = card === null ? null : await talkOfCard(ctx, card._id);
    if (card === null) return { taken: false as const, refusal: CARD_GONE };
    if (!TALKABLE_STATUSES.includes(card.status)) {
      if (talk !== null) await closeTalk(ctx, talk);
      return { taken: false as const, refusal: CARD_DECIDED };
    }
    const candidates = await candidatesKeyOf(ctx, card);
    if (candidates === null) return { taken: false as const, refusal: CARD_GONE };
    const now = Date.now();
    const current = talk?.turns ?? [];
    const decision = decideTalkTurn(current, args.request, now);
    if (!decision.ok) return { taken: false as const, refusal: decision.refusal };
    // A finish that keeps nothing new leaves the talk and its card as they are: a talk already on
    // the card is not asked for its outcome again (the second pass's m4).
    const settles = args.request.kind === 'finish' && !decision.replied;
    if (settles && talk?.state === 'finished') {
      return { taken: false as const, refusal: ALREADY_ON_CARD };
    }
    const talkId =
      talk?._id ??
      (await ctx.db.insert('reorientationTalks', {
        agentId: card.agentId,
        reorientationId: card._id,
        state: 'active',
        turns: [],
        conversation: 0,
        startedAt: now,
      }));
    if (!settles) {
      await ctx.db.patch(talkId, {
        state: 'active',
        ...(decision.turns !== current ? { turns: [...decision.turns] } : {}),
        // A reply kept is no longer the reply being typed.
        ...(decision.replied ? { replyDraft: undefined } : {}),
        // A talk taken up again has not ended; the card keeps the proposal it ended in.
        ...(talk?.state === 'finished' ? { outcome: undefined, endedAt: undefined } : {}),
      });
      // A deferred card keeps its date through a talk (the second pass's M2); only an open one is
      // put at discussing.
      if (card.status === 'open') await ctx.db.patch(card._id, { status: 'discussing' });
    }
    return {
      taken: true as const,
      talkId,
      conversation: talk === null ? 0 : conversationOf(talk),
      turns: [...decision.turns],
      answering: decision.answering,
      candidatesKey: candidates.key,
      employeeName: candidates.input.employeeName,
      system: talkSystemPrompt(candidates.input, card.proposed),
      unkept: decision.unkept?.length ?? 0,
    };
  },
});

/** What a write that ends a talk was given. */
interface Ending {
  readonly talk: Doc<'reorientationTalks'>;
  readonly card: Doc<'reorientations'>;
  readonly turns: readonly OneToOneTurn[];
  readonly outcome: TalkOutcome;
  readonly candidatesKey: string;
}

/**
 * End the talk in a proposal on the card, which never applies it: the outcome is read against
 * the card's candidates (`proposalOf`), its quotes kept only where they are the manager's own
 * words (`managerQuotes`, the floor under the route's own guard), and the card's proposal
 * replaced, the card back at `open`, with `reorientation.proposed` by the discussion. A proposal written here stands against a judgement
 * still in flight, whose write takes only a pending card (`reorientation.writeProposal`).
 *
 * @returns Null once it is written, or the refusal the room shows; nothing is written then.
 */
async function endInProposal(ctx: MutationCtx, ending: Ending): Promise<string | null> {
  const { talk, card, turns, outcome } = ending;
  const candidates = await candidatesKeyOf(ctx, card);
  if (candidates === null) return CARD_GONE;
  if (candidates.key !== ending.candidatesKey) return CARD_CHANGED;
  let proposed: JudgedProposal;
  try {
    proposed = proposalOf(outcome.reply, candidates.input.candidates);
  } catch (err: unknown) {
    if (!(err instanceof ProposalRefused)) throw err;
    log.warn('reorientation talk: the outcome was refused', {
      reorientationId: card._id,
      reason: err.message,
    });
    return err instanceof ScopeNotAPhrase ? SCOPE_REFUSED : OUTCOME_REFUSED;
  }
  const now = Date.now();
  // A card being talked through is open again; a deferred one keeps its date (the second pass's M2).
  await ctx.db.patch(card._id, {
    proposed,
    ...(card.status === 'discussing' ? { status: 'open' as const } : {}),
  });
  await appendEvent(ctx, {
    agentId: card.agentId,
    type: 'reorientation.proposed',
    payload: {
      reorientationId: card._id,
      summary: card.triggerSummary,
      kind: proposed.kind,
      by: 'discussion',
    },
    createdAt: now,
  });
  await ctx.db.patch(talk._id, {
    turns: [...turns],
    state: 'finished',
    outcome: { proposed, quotes: managerQuotes(outcome.quotes, turns) },
    endedAt: now,
    replyDraft: undefined,
  });
  return null;
}

/** Whether a talk can still take an answer or a finish. */
function refusalOfState(talk: Doc<'reorientationTalks'>): string | null {
  return talk.state === 'active' ? null : talkRefusal('The one-to-one is already over.');
}

/**
 * Keep the employee's answer (`decideAnswer`) as its turn finishes, on the conversation the turn
 * was taken on, and when it called `reorientationComplete`, end the talk in its proposal in the
 * same transaction (`endInProposal`): an answer whose outcome is refused is not kept either, so
 * the room asks again rather than showing words about a proposal the card never got.
 *
 * Public, owner-guarded (`assertOwnsAgent` through the talk); called by the talk's route as the
 * manager. Writes the talk's `turns`, and on an outcome the card's `proposed` and `status`, the
 * talk's `outcome` and `state` and `reorientation.proposed`.
 *
 * @returns Whether the answer was kept and whether it ended the talk; `refusal` says why not.
 */
export const recordAnswer = mutation({
  args: {
    talkId: v.id('reorientationTalks'),
    conversation: v.number(),
    candidatesKey: v.string(),
    answer: v.object({
      answering: v.union(v.string(), v.null()),
      id: v.string(),
      text: v.string(),
    }),
    outcome: v.optional(talkOutcomeValidator),
  },
  returns: v.union(
    v.object({ kept: v.literal(true), ended: v.boolean() }),
    v.object({ kept: v.literal(false), refusal: v.string() }),
  ),
  handler: async (ctx, args) => {
    const owned = await ownedTalk(ctx, args.talkId, args.conversation);
    if (!owned.ok) return { kept: false as const, refusal: owned.refusal };
    const over = refusalOfState(owned.talk);
    if (over !== null) return { kept: false as const, refusal: over };
    // A talk's turns carry no question number: the one-to-one's seven topics are not its own.
    const decision = decideAnswer(owned.talk.turns, { ...args.answer, topicIndex: -1 }, Date.now());
    if (!decision.ok) return { kept: false as const, refusal: talkRefusal(decision.refusal) };
    if (args.outcome === undefined) {
      if (decision.turns !== owned.talk.turns) {
        await ctx.db.patch(owned.talk._id, { turns: [...decision.turns] });
      }
      return { kept: true as const, ended: false };
    }
    const refusal = await endInProposal(ctx, {
      ...owned,
      turns: decision.turns,
      outcome: args.outcome,
      candidatesKey: args.candidatesKey,
    });
    return refusal === null
      ? { kept: true as const, ended: true }
      : { kept: false as const, refusal };
  },
});

/**
 * End the talk at the manager's word ("Put this on the card"): the route asked the employee for
 * the outcome from the turns `takeTurn` handed it with a finish, and the talk must still end
 * where it did then (`after`, its last kept turn). The finish keeps no turn of its own, so a talk
 * at the 40-turn bound can be put on the card too.
 *
 * Public, owner-guarded (`assertOwnsAgent` through the talk); called by the talk's route as the
 * manager. Writes what `endInProposal` writes.
 *
 * @returns Whether the talk ended in the proposal; `refusal` says why not.
 */
export const finish = mutation({
  args: {
    talkId: v.id('reorientationTalks'),
    conversation: v.number(),
    candidatesKey: v.string(),
    after: v.string(),
    outcome: talkOutcomeValidator,
  },
  returns: v.union(
    v.object({ ended: v.literal(true) }),
    v.object({ ended: v.literal(false), refusal: v.string() }),
  ),
  handler: async (ctx, args) => {
    const owned = await ownedTalk(ctx, args.talkId, args.conversation);
    if (!owned.ok) return { ended: false as const, refusal: owned.refusal };
    const over = refusalOfState(owned.talk);
    if (over !== null) return { ended: false as const, refusal: over };
    if (owned.talk.turns.at(-1)?.id !== args.after) {
      return { ended: false as const, refusal: talkRefusal(MOVED_ON_REFUSAL) };
    }
    if (repliesIn(owned.talk.turns) === 0) {
      return { ended: false as const, refusal: TALK_NOTHING_SAID };
    }
    const refusal = await endInProposal(ctx, {
      ...owned,
      turns: owned.talk.turns,
      outcome: args.outcome,
      candidatesKey: args.candidatesKey,
    });
    return refusal === null ? { ended: true as const } : { ended: false as const, refusal };
  },
});

/**
 * Keep the reply the manager is typing, so a room closed mid-reply reopens with it, a talk already
 * on the card included, since a reply takes it up again. Bounded as a reply is; an empty field
 * clears it. Nothing is kept once the card is decided, for a conversation the talk has set aside,
 * or once a reply after `after` (the last reply the talk had kept when the room wrote) has been
 * kept.
 *
 * Public, owner-guarded (`assertOwnsAgent` through the talk). Writes the talk's `replyDraft`.
 */
export const keepReplyDraft = mutation({
  args: {
    talkId: v.id('reorientationTalks'),
    conversation: v.number(),
    text: v.string(),
    after: v.union(v.string(), v.null()),
  },
  returns: v.object({ kept: v.boolean() }),
  handler: async (ctx, args) => {
    const owned = await ownedTalk(ctx, args.talkId, args.conversation);
    if (!owned.ok) return { kept: false };
    const lastReply = owned.talk.turns.findLast((turn) => turn.speaker === 'manager');
    if ((lastReply?.id ?? null) !== args.after) return { kept: false };
    const text = args.text.slice(0, REPLY_MAX_CHARS);
    await ctx.db.patch(owned.talk._id, { replyDraft: text.trim() ? text : undefined });
    return { kept: true };
  },
});

/** A talk as the room draws it. */
const talkViewValidator = v.object({
  _id: v.id('reorientationTalks'),
  state: v.union(...REORIENTATION_TALK_STATES.map((state) => v.literal(state))),
  turns: v.array(oneToOneTurnValidator),
  replyDraft: v.optional(v.string()),
  conversation: v.number(),
  outcome: v.optional(
    v.object({ proposed: reorientationTalkProposalValidator, quotes: v.array(v.string()) }),
  ),
});

/**
 * One card as its talk's room draws it: what changed, where the card stands, what it proposes and
 * its talk with the turns kept so far, or null for an id that names no card. Public, owner-guarded
 * (`assertOwnsAgent` through the card).
 */
export const forCard = query({
  args: { reorientationId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      reorientationId: v.id('reorientations'),
      agentId: v.id('agents'),
      summary: v.string(),
      status: v.union(
        v.literal('open'),
        v.literal('discussing'),
        v.literal('applied'),
        v.literal('dismissed'),
        v.literal('deferred'),
      ),
      proposed: reorientationProposalValidator,
      talk: v.union(v.null(), talkViewValidator),
    }),
  ),
  handler: async (ctx, args) => {
    await getCallerOrThrow(ctx);
    const reorientationId = ctx.db.normalizeId('reorientations', args.reorientationId);
    if (reorientationId === null) return null;
    const card = await ctx.db.get(reorientationId);
    if (card === null) return null;
    // A stale link to a card whose employee is gone reads as no card (the second pass's m11).
    if ((await ownedAgentOrNull(ctx, card.agentId)) === null) return null;
    // A decided card's talk is closed with it, whether or not a write has closed the row yet.
    const decided = !TALKABLE_STATUSES.includes(card.status);
    const talk = await ctx.db
      .query('reorientationTalks')
      .withIndex('by_reorientation', (q) => q.eq('reorientationId', card._id))
      .first();
    return {
      reorientationId: card._id,
      agentId: card.agentId,
      summary: card.triggerSummary,
      status: card.status,
      proposed: card.proposed,
      talk:
        talk === null
          ? null
          : {
              _id: talk._id,
              state: decided ? ('closed' as const) : talk.state,
              turns: talk.turns,
              ...(talk.replyDraft === undefined || decided ? {} : { replyDraft: talk.replyDraft }),
              conversation: talk.conversation,
              ...(talk.outcome === undefined ? {} : { outcome: talk.outcome }),
            },
    };
  },
});
