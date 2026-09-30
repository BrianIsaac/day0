import { ConvexError, v } from 'convex/values';
import { mutation, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { assertOwnsAgent, assertOwnsVoiceSession } from './ownership';
import { oneToOneTurnValidator } from './schema';
import {
  REPLY_MAX_CHARS,
  conversationOf,
  conversationTranscript,
  decideAnswer,
  decideTurn,
  repliesIn,
  type OneToOneTurn,
} from '../src/agent/one-to-one-conversation';
import { oneToOnePhase } from '../src/agent/one-to-one-phase';
import { claimSession } from './voice';

/**
 * The chat one-to-one, kept on its session turn by turn.
 *
 * The conversation used to live only in the room's memory: the chat route was handed the whole
 * history on every turn and kept none of it, and the session heard of the conversation only when
 * the room posted the transcript at the close. A room closed before that post (a closed tab, a
 * crash, a closed laptop, a lost connection) lost every answer, and the reopened room began
 * again at question 1 on the same session (30 Sep, wave 7 finding 5).
 *
 * Now the session is the conversation's one copy. The chat route keeps the manager's reply
 * before the employee is asked (`takeTurn`) and the employee's answer before the room hears it
 * finished (`recordAnswer`); a reopened room is drawn from these turns and carries on from where
 * they end. A close, earned or the manager's own (`finish`), starts the draft in the same
 * transaction that keeps it, so the draft does not wait on the room either.
 */

/** Why the session will not take a turn: said in the room, so a `ConvexError` (standard 6.3). */
function refuse(refusal: string): never {
  throw new ConvexError(refusal);
}

/** The session's kept turns, none for a session that has kept none. */
function turnsOf(session: Doc<'voiceSessions'>): readonly OneToOneTurn[] {
  return session.turns ?? [];
}

/** Refuse a turn on a session whose one-to-one is no longer being held: it is drafting or drafted. */
function assertTalking(session: Doc<'voiceSessions'>): void {
  if (oneToOnePhase(session).kind !== 'talking') {
    refuse('The one-to-one is over; the charter is drafted from it.');
  }
}

/** Said to a chat room whose session a call now holds: nothing it writes belongs to the call. */
const MOVED_TO_CALL = 'The one-to-one moved to a call in another window. Reload to carry on.';

/** Said to a room writing to a conversation the session has set aside and started again. */
const STARTED_AGAIN = 'The one-to-one started again in another window. Reload to carry on.';

/**
 * Why a chat write for conversation `conversation` does not belong to this session's one-to-one,
 * or null when it does: the session is held in chat, and it still holds that conversation.
 */
function staleWrite(session: Doc<'voiceSessions'>, conversation: number): string | null {
  if (session.mode !== 'chat') return MOVED_TO_CALL;
  if (conversationOf(session) !== conversation) return STARTED_AGAIN;
  return null;
}

/**
 * Start the draft from the kept conversation, in the transaction that ends it: the session is
 * claimed for the manager's side as the room's own post of the transcript claimed it
 * (`voice.claimSession`, `browser`), so the deployment's three re-drives still follow a failed
 * first attempt, and the draft (`onboarding.draftKeptConversation`) is scheduled here, so it runs
 * whether or not any room is open. A draft whose run never starts is re-driven by the sweep once
 * its claim's lease has passed.
 */
async function queueDraft(
  ctx: MutationCtx,
  session: Doc<'voiceSessions'>,
  draft: { readonly turns: readonly OneToOneTurn[]; readonly bossLabel: string },
): Promise<void> {
  await ctx.db.patch(session._id, { turns: [...draft.turns], replyDraft: undefined });
  const claim = await claimSession(ctx, session, 'browser', {
    transcript: conversationTranscript(draft.turns),
    bossLabel: draft.bossLabel,
  });
  // Only a session being held reaches here, and nothing else holds it: the claim is this one's.
  if (claim.outcome !== 'claimed') {
    throw new Error(`draft not claimed: the session is ${claim.outcome}`);
  }
  await ctx.scheduler.runAfter(0, internal.onboarding.draftKeptConversation, {
    sessionId: session._id,
    claimToken: claim.claimToken,
  });
}

/**
 * The employee's one-to-one being held: its newest session, which `voice.start` opened for the
 * room. A turn names the employee, not the session, so the session decides which conversation it
 * belongs to.
 */
async function heldSession(ctx: MutationCtx, agentId: Id<'agents'>): Promise<Doc<'voiceSessions'>> {
  await assertOwnsAgent(ctx, agentId);
  const session = await ctx.db
    .query('voiceSessions')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc')
    .first();
  if (!session || session.state === 'done') refuse('The one-to-one has not opened yet.');
  return session;
}

/**
 * Take a turn of the employee's chat one-to-one before it is put to the employee, and hand back
 * the session, the conversation the employee answers (`decideTurn`) and the stamp that names it:
 * the opening, the manager's replies (kept here, and the reply being typed cleared), or a turn
 * asked again.
 *
 * Public, owner-guarded (`assertOwnsAgent`); called by the chat route as the manager. Writes the
 * held session's `turns` and `replyDraft`.
 *
 * @throws ConvexError with the refusal the room shows: no one-to-one is open, a call holds it, it
 *   is over, or the turn does not follow the conversation as the session holds it.
 */
export const takeTurn = mutation({
  args: {
    agentId: v.id('agents'),
    request: v.union(
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
    ),
  },
  returns: v.object({
    sessionId: v.id('voiceSessions'),
    conversation: v.number(),
    turns: v.array(oneToOneTurnValidator),
    answering: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    sessionId: Id<'voiceSessions'>;
    conversation: number;
    turns: OneToOneTurn[];
    answering: string | null;
  }> => {
    const session = await heldSession(ctx, args.agentId);
    if (session.mode !== 'chat') refuse(MOVED_TO_CALL);
    assertTalking(session);
    const current = turnsOf(session);
    const decision = decideTurn(current, args.request, Date.now());
    if (!decision.ok) refuse(decision.refusal);
    if (decision.turns !== current) {
      await ctx.db.patch(session._id, {
        turns: [...decision.turns],
        // A reply kept, by a send or by Ask again, is no longer the reply being typed.
        ...(decision.replied ? { replyDraft: undefined } : {}),
      });
    }
    return {
      sessionId: session._id,
      conversation: conversationOf(session),
      turns: [...decision.turns],
      answering: decision.answering,
    };
  },
});

/**
 * Keep the employee's answer (`decideAnswer`) as its turn finishes, on the conversation the turn
 * was taken on (`conversation`, from `takeTurn`): an answer in flight when the one-to-one started
 * again or moved to a call is not kept. An answer that earns the close starts the draft in the
 * same transaction (`queueDraft`).
 *
 * Public, owner-guarded (`assertOwnsVoiceSession`); called by the chat route as the manager.
 * Writes the session's `turns`, and on a close its pending material and the scheduled draft.
 *
 * @returns Whether the answer was kept; `refusal` says why not, for the room.
 */
export const recordAnswer = mutation({
  args: {
    sessionId: v.id('voiceSessions'),
    conversation: v.number(),
    bossLabel: v.string(),
    answer: v.object({
      answering: v.union(v.string(), v.null()),
      id: v.string(),
      text: v.string(),
      topicIndex: v.number(),
      closingLine: v.optional(v.string()),
    }),
  },
  returns: v.union(
    v.object({ kept: v.literal(true), closed: v.boolean() }),
    v.object({ kept: v.literal(false), refusal: v.string() }),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<{ kept: true; closed: boolean } | { kept: false; refusal: string }> => {
    const session = await assertOwnsVoiceSession(ctx, args.sessionId);
    const stale = staleWrite(session, args.conversation);
    if (stale !== null) return { kept: false, refusal: stale };
    if (oneToOnePhase(session).kind !== 'talking') {
      return { kept: false, refusal: 'The one-to-one is already over.' };
    }
    const current = turnsOf(session);
    const decision = decideAnswer(current, args.answer, Date.now());
    if (!decision.ok) return { kept: false, refusal: decision.refusal };
    if (decision.closed) {
      await queueDraft(ctx, session, { turns: decision.turns, bossLabel: args.bossLabel });
    } else if (decision.turns !== current) {
      await ctx.db.patch(session._id, { turns: [...decision.turns] });
    }
    return { kept: true, closed: decision.closed };
  },
});

/**
 * End the chat one-to-one at the manager's word and draft the charter from what the session kept
 * (`queueDraft`). A session already drafting is left as it is, so a Finish sent again after a
 * lost connection starts nothing twice. A Finish from a room drawing a conversation the session
 * has set aside (`conversation`) finishes nothing.
 *
 * Public, owner-guarded (`assertOwnsVoiceSession`). Writes the session's pending material and
 * schedules the draft.
 *
 * @throws ConvexError when the manager has answered nothing yet, the one-to-one was drafted, a
 *   call holds it, or it started again.
 */
export const finish = mutation({
  args: { sessionId: v.id('voiceSessions'), conversation: v.number(), bossLabel: v.string() },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const session = await assertOwnsVoiceSession(ctx, args.sessionId);
    const stale = staleWrite(session, args.conversation);
    if (stale !== null) refuse(stale);
    const phase = oneToOnePhase(session).kind;
    if (phase === 'drafting') return { ok: true };
    if (phase !== 'talking') refuse('The one-to-one is over; the charter is drafted from it.');
    const turns = turnsOf(session);
    if (repliesIn(turns) === 0) refuse('Answer at least one question before finishing.');
    await queueDraft(ctx, session, { turns, bossLabel: args.bossLabel });
    return { ok: true };
  },
});

/**
 * Keep the reply the manager is typing, so a room closed mid-reply reopens with it in the
 * composer. Bounded as a reply is; an empty field clears it. Nothing is kept once the one-to-one
 * is over, for a conversation it has set aside (`conversation`), or once a reply after `after`
 * (the last reply the session had kept when the room wrote) has been kept.
 *
 * Public, owner-guarded (`assertOwnsVoiceSession`). Writes the session's `replyDraft`.
 */
export const keepReplyDraft = mutation({
  args: {
    sessionId: v.id('voiceSessions'),
    conversation: v.number(),
    text: v.string(),
    after: v.union(v.string(), v.null()),
  },
  returns: v.object({ kept: v.boolean() }),
  handler: async (ctx, args): Promise<{ kept: boolean }> => {
    const session = await assertOwnsVoiceSession(ctx, args.sessionId);
    if (staleWrite(session, args.conversation) !== null) return { kept: false };
    if (oneToOnePhase(session).kind !== 'talking') return { kept: false };
    // A keep that arrives after the reply it was typing was sent would put the sent words back.
    const lastReply = turnsOf(session).findLast((turn) => turn.speaker === 'manager');
    if ((lastReply?.id ?? null) !== args.after) return { kept: false };
    const text = args.text.slice(0, REPLY_MAX_CHARS);
    await ctx.db.patch(session._id, { replyDraft: text.trim() ? text : undefined });
    return { kept: true };
  },
});
