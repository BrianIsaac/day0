import { v } from 'convex/values';
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent, assertOwnsVoiceSession } from './ownership';
import { commitCharterAndWorkspace, workspaceFileValidator } from './charters';

/**
 * Voice + chat session lifecycle. The agent itself asks the boss
 * which mode they prefer at the very start of Day-1; `mode` is the
 * boss's choice. Public surfaces enforce per-account ownership.
 *
 * Finalisation is a state machine rather than a sequence of writes, because a
 * genuine call has two independent finishers: the browser posts from
 * `onDisconnect` as soon as it holds a transcript, and ElevenLabs posts the
 * signed post-call webhook — which it may deliver more than once, with a
 * byte-identical payload, and which expects a prompt 200 either way.
 *
 *   active ──claim──▶ synthesising ──finalise──▶ done
 *      ▲                    │
 *      └──── release ───────┘   (a model call failed, or the lease expired)
 *
 * The claim is the whole point: it is a single transaction that both decides
 * and writes, so exactly one finisher proceeds to spend model calls. Everyone
 * else is told the work is already recorded or already running, and answers
 * successfully. The final commit is likewise one transaction covering the
 * charter, the workspace, the session and the events, so there is no state in
 * which a session is finished without the charter it is supposed to have
 * produced.
 */

export const list = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('voiceSessions')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .collect();
  },
});

export const latest = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    return await ctx.db
      .query('voiceSessions')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .order('desc')
      .first();
  },
});

/**
 * Open a session. Returns the row id plus `webhookToken`, the capability the
 * caller hands to ElevenLabs so the post-call webhook can prove which session
 * it is reporting on — see `claimWebhookFinalisation`. Only the boss who owns
 * the agent ever sees it: this mutation is ownership-checked.
 */
export const start = mutation({
  args: {
    agentId: v.id('agents'),
    mode: v.union(v.literal('elevenlabs'), v.literal('gemini-live'), v.literal('chat')),
    elevenLabsConversationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    const webhookToken = crypto.randomUUID();
    const id = await ctx.db.insert('voiceSessions', {
      agentId: args.agentId,
      mode: args.mode,
      state: 'active',
      answers: {},
      elevenLabsConversationId: args.elevenLabsConversationId,
      webhookToken,
      startedAt: Date.now(),
    });
    await ctx.db.patch(args.agentId, { state: 'day-one-in-progress' });
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'voice.started',
      payload: { sessionId: id, mode: args.mode },
      createdAt: Date.now(),
    });
    return { sessionId: id, webhookToken };
  },
});

/**
 * Patch the ElevenLabs conversation id onto an existing voice session
 * row. Called from the browser's `onConnect` callback once the SDK
 * assigns a conversation id — the row was created earlier (in
 * `voice.start`) before the WebSocket connected, so we couldn't store
 * the id at that point. Best-effort: `claimWebhookFinalisation` records the id
 * itself when this call never lands.
 */
export const attachConversationId = mutation({
  args: {
    sessionId: v.id('voiceSessions'),
    elevenLabsConversationId: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await assertOwnsVoiceSession(ctx, args.sessionId);
    // A session already being finalised has had its conversation id checked
    // against the delivery that is finalising it; re-stamping it here would
    // undo that check. Nothing renders this result, so a no-op is the answer.
    if (session.state !== 'pending' && session.state !== 'active') {
      return { ok: true, stamped: false };
    }
    await ctx.db.patch(args.sessionId, {
      elevenLabsConversationId: args.elevenLabsConversationId,
    });
    return { ok: true, stamped: true };
  },
});

export const recordAnswer = mutation({
  args: {
    sessionId: v.id('voiceSessions'),
    topic: v.string(),
    answer: v.string(),
  },
  handler: async (ctx, args) => {
    const row = await assertOwnsVoiceSession(ctx, args.sessionId);
    const next = { ...((row.answers as Record<string, string>) ?? {}), [args.topic]: args.answer };
    await ctx.db.patch(args.sessionId, { answers: next });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'voice.answer-recorded',
      payload: { topic: args.topic },
      createdAt: Date.now(),
    });
    return { ok: true, captured: Object.keys(next).length };
  },
});

export const getInternal = internalQuery({
  args: { sessionId: v.id('voiceSessions') },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.sessionId);
  },
});

/**
 * How long a `synthesising` reservation is honoured before another finisher may
 * take it over. An action that dies mid-flight — an interrupted deploy, a
 * process restart — never releases its own claim, so without an expiry a
 * session would be wedged short of `done` with no way back.
 *
 * Comfortably longer than two model calls including their retry ladders, and
 * shorter than the later rungs of the ElevenLabs retry schedule (immediate,
 * 30s, 2m, 8m, 30m), so a genuine retry is what recovers an abandoned claim.
 */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * What a finisher is told when it asks to finalise a session.
 *
 *   claimed     — it won; it alone may spend model calls and commit.
 *   in-progress — another finisher holds a live claim.
 *   already-done — the work is recorded; here is what it produced.
 */
export type FinalisationClaim =
  | {
      outcome: 'claimed';
      sessionId: Id<'voiceSessions'>;
      agentId: Id<'agents'>;
      claimToken: string;
    }
  | { outcome: 'in-progress'; sessionId: Id<'voiceSessions'> }
  | {
      outcome: 'already-done';
      sessionId: Id<'voiceSessions'>;
      charterId: Id<'charters'> | null;
      version: string | null;
    };

/**
 * Decide and write in one transaction. Convex runs a mutation serialisably, so
 * a second caller reading this row necessarily sees the first caller's patch —
 * which is the property a separate check-then-act pair cannot have.
 */
async function claimSession(
  ctx: MutationCtx,
  session: Doc<'voiceSessions'>,
  claimedBy: 'browser' | 'webhook',
): Promise<FinalisationClaim> {
  if (session.state === 'done') {
    return {
      outcome: 'already-done',
      sessionId: session._id,
      charterId: session.charterId ?? null,
      version: session.charterVersion ?? null,
    };
  }

  if (session.state === 'synthesising') {
    const heldFor = Date.now() - (session.claimedAt ?? 0);
    if (heldFor < CLAIM_LEASE_MS) {
      return { outcome: 'in-progress', sessionId: session._id };
    }
    await ctx.db.insert('events', {
      agentId: session.agentId,
      type: 'voice.finalisation-reclaimed',
      payload: { sessionId: session._id, heldForMs: heldFor, claimedBy },
      createdAt: Date.now(),
    });
  }

  const claimToken = crypto.randomUUID();
  await ctx.db.patch(session._id, {
    state: 'synthesising',
    claimToken,
    claimedAt: Date.now(),
    claimedBy,
    finalisationError: undefined,
  });
  return {
    outcome: 'claimed',
    sessionId: session._id,
    agentId: session.agentId,
    claimToken,
  };
}

/**
 * Browser entry. `expectedAgentId` is the agent the caller has already proved it
 * owns, and this is where that proof is joined to the session: a session that
 * belongs to a different agent is refused here, transactionally, rather than
 * being trusted because the caller supplied its id. A session id is not
 * authorisation for the session it names.
 */
export const claimFinalisation = internalMutation({
  args: {
    sessionId: v.id('voiceSessions'),
    expectedAgentId: v.id('agents'),
  },
  handler: async (ctx, args): Promise<FinalisationClaim> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error('finalisation denied: voice session not found');
    if (session.agentId !== args.expectedAgentId) {
      throw new Error('finalisation denied: voice session belongs to a different agent');
    }
    return await claimSession(ctx, session, 'browser');
  },
});

/**
 * Webhook entry — resolve the delivery to its session and claim it in the same
 * transaction, so nothing can slip between recognising the session and
 * reserving it.
 *
 * The only value in that payload an outsider cannot produce is `webhookToken`:
 * the agent id is the routing id from `/agent/<agentId>`, and the conversation
 * id is chosen by whoever posts the body. The token is minted server-side by
 * `voice.start`, handed only to the boss who owns the agent, and travels
 * browser -> ElevenLabs -> back to us as a dynamic variable, so matching it is
 * what binds the transcript to a real session.
 *
 * The conversation id is a consistency check, never a fallback. It is stamped
 * on the row the first time it arrives, because the browser's `onConnect`
 * handler may have lost the race to attach it; once stamped, a delivery
 * carrying a different id is refused rather than silently reassigned.
 *
 * A delivery for a session that is already finished is not refused: ElevenLabs
 * retries with a byte-identical payload and reads 4xx as a permanent failure
 * that counts towards disabling the webhook. It is told what the first delivery
 * produced instead.
 */
export const claimWebhookFinalisation = internalMutation({
  args: {
    agentId: v.id('agents'),
    webhookToken: v.string(),
    conversationId: v.string(),
  },
  handler: async (ctx, args): Promise<FinalisationClaim> => {
    const session = await ctx.db
      .query('voiceSessions')
      .withIndex('by_webhook_token', (q) => q.eq('webhookToken', args.webhookToken))
      .first();
    if (!session) throw new Error('webhook denied: no voice session for that token');
    if (session.agentId !== args.agentId) {
      throw new Error('webhook denied: token belongs to a different agent');
    }
    if (
      session.elevenLabsConversationId &&
      session.elevenLabsConversationId !== args.conversationId
    ) {
      throw new Error('webhook denied: conversation id does not match the voice session');
    }
    if (!session.elevenLabsConversationId) {
      await ctx.db.patch(session._id, { elevenLabsConversationId: args.conversationId });
    }
    return await claimSession(ctx, session, 'webhook');
  },
});

/** What a finisher gets back when it tries to commit. */
export type FinalisationResult =
  | { outcome: 'finalised'; charterId: Id<'charters'>; version: string }
  | { outcome: 'already-done'; charterId: Id<'charters'> | null; version: string | null }
  | { outcome: 'claim-lost' };

/**
 * The single write that ends a Day-1 1:1: charter, workspace, session, agent
 * state and events, in one transaction. Either all of it lands or none of it
 * does, so `done` always means "there is a charter for this".
 *
 * `expectedAgentId` is re-checked here rather than trusted from the claim,
 * because the claim and the commit are separated by two model calls.
 */
export const finaliseSession = internalMutation({
  args: {
    sessionId: v.id('voiceSessions'),
    expectedAgentId: v.id('agents'),
    claimToken: v.string(),
    transcriptText: v.optional(v.string()),
    answers: v.any(),
    charterVersion: v.string(),
    charterBody: v.any(),
    workspaceFiles: v.array(workspaceFileValidator),
  },
  handler: async (ctx, args): Promise<FinalisationResult> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error('finalisation denied: voice session not found');
    if (session.agentId !== args.expectedAgentId) {
      throw new Error('finalisation denied: voice session belongs to a different agent');
    }
    if (session.state === 'done') {
      return {
        outcome: 'already-done',
        charterId: session.charterId ?? null,
        version: session.charterVersion ?? null,
      };
    }
    // The lease expired and someone else took the session over. Their run is
    // the one that counts; this one stops without writing anything.
    if (session.state !== 'synthesising' || session.claimToken !== args.claimToken) {
      return { outcome: 'claim-lost' };
    }

    const charterId = await commitCharterAndWorkspace(ctx, {
      agentId: session.agentId,
      version: args.charterVersion,
      body: args.charterBody,
      workspaceFiles: args.workspaceFiles,
    });
    await ctx.db.patch(session._id, {
      state: 'done',
      transcriptText: args.transcriptText,
      answers: args.answers,
      endedAt: Date.now(),
      charterId,
      charterVersion: args.charterVersion,
      claimToken: undefined,
      claimedAt: undefined,
      finalisationError: undefined,
    });
    await ctx.db.patch(session.agentId, { state: 'charter-pending' });
    await ctx.db.insert('events', {
      agentId: session.agentId,
      type: 'voice.completed',
      payload: { sessionId: session._id, charterId, via: session.claimedBy ?? 'unknown' },
      createdAt: Date.now(),
    });
    return { outcome: 'finalised', charterId, version: args.charterVersion };
  },
});

/**
 * Hand the session back when a finaliser cannot finish — a model call failed,
 * or the object came back unusable. The session returns to `active`, which is
 * the state a fresh finisher can claim, so a failed run costs one attempt
 * rather than the charter. The reason is kept on the row and in the feed so the
 * failure is visible rather than merely survivable.
 */
export const releaseFinalisation = internalMutation({
  args: {
    sessionId: v.id('voiceSessions'),
    claimToken: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return { released: false };
    if (session.state !== 'synthesising' || session.claimToken !== args.claimToken) {
      return { released: false };
    }
    await ctx.db.patch(args.sessionId, {
      state: 'active',
      claimToken: undefined,
      claimedAt: undefined,
      finalisationError: args.reason.slice(0, 500),
    });
    await ctx.db.insert('events', {
      agentId: session.agentId,
      type: 'voice.finalisation-failed',
      payload: { sessionId: args.sessionId, reason: args.reason.slice(0, 500) },
      createdAt: Date.now(),
    });
    return { released: true };
  },
});
