import { v } from 'convex/values';
import { mutation, query, internalMutation, internalQuery } from './_generated/server';
import { assertOwnsAgent, assertOwnsVoiceSession } from './ownership';

/**
 * Voice + chat session lifecycle. The agent itself asks the boss
 * which mode they prefer at the very start of Day-1; `mode` is the
 * boss's choice. Public surfaces enforce per-account ownership.
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
 * it is reporting on — see `bindWebhookSession`. Only the boss who owns the
 * agent ever sees it: this mutation is ownership-checked.
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
 * the id at that point. Best-effort: `bindWebhookSession` records the id
 * itself when this call never lands.
 */
export const attachConversationId = mutation({
  args: {
    sessionId: v.id('voiceSessions'),
    elevenLabsConversationId: v.string(),
  },
  handler: async (ctx, args) => {
    await assertOwnsVoiceSession(ctx, args.sessionId);
    await ctx.db.patch(args.sessionId, {
      elevenLabsConversationId: args.elevenLabsConversationId,
    });
    return { ok: true };
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
 * Resolve a post-call webhook delivery to the session it claims to report on.
 *
 * The only value in that payload an outsider cannot produce is
 * `webhookToken`: the agent id is the routing id from `/agent/<agentId>`, and
 * the conversation id is chosen by whoever posts the body. The token is minted
 * server-side by `voice.start`, handed only to the boss who owns the agent,
 * and travels browser -> ElevenLabs -> back to us as a dynamic variable, so
 * matching it is what binds the transcript to a real session.
 *
 * The conversation id is a consistency check, never a fallback. It is stamped
 * on the row the first time it arrives, because the browser's `onConnect`
 * handler may have lost the race to attach it; once stamped, a delivery
 * carrying a different id is refused rather than silently reassigned.
 */
export const bindWebhookSession = internalMutation({
  args: {
    agentId: v.id('agents'),
    webhookToken: v.string(),
    conversationId: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query('voiceSessions')
      .withIndex('by_webhook_token', (q) => q.eq('webhookToken', args.webhookToken))
      .first();
    if (!session) throw new Error('webhook denied: no voice session for that token');
    if (session.agentId !== args.agentId) {
      throw new Error('webhook denied: token belongs to a different agent');
    }
    if (session.state !== 'active') {
      throw new Error(`webhook denied: voice session is ${session.state}, not active`);
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
    return session._id;
  },
});

export const complete = internalMutation({
  args: {
    sessionId: v.id('voiceSessions'),
    transcriptText: v.optional(v.string()),
    answers: v.any(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.sessionId);
    if (!row) throw new Error(`voice.complete: session ${args.sessionId} not found`);
    await ctx.db.patch(args.sessionId, {
      state: 'done',
      transcriptText: args.transcriptText,
      answers: args.answers,
      endedAt: Date.now(),
    });
    await ctx.db.patch(row.agentId, { state: 'charter-pending' });
    await ctx.db.insert('events', {
      agentId: row.agentId,
      type: 'voice.completed',
      payload: { sessionId: args.sessionId },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});
