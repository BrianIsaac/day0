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

export const start = mutation({
  args: {
    agentId: v.id('agents'),
    mode: v.union(v.literal('elevenlabs'), v.literal('gemini-live'), v.literal('chat')),
    elevenLabsConversationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertOwnsAgent(ctx, args.agentId);
    const id = await ctx.db.insert('voiceSessions', {
      agentId: args.agentId,
      mode: args.mode,
      state: 'active',
      answers: {},
      elevenLabsConversationId: args.elevenLabsConversationId,
      startedAt: Date.now(),
    });
    await ctx.db.patch(args.agentId, { state: 'day-one-in-progress' });
    await ctx.db.insert('events', {
      agentId: args.agentId,
      type: 'voice.started',
      payload: { sessionId: id, mode: args.mode },
      createdAt: Date.now(),
    });
    return id;
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
 * Look up the active voice session for an agent + ElevenLabs conversation id.
 * Used by the post-call webhook path to bind an external transcript back
 * to a session that the legitimate user (and only the legitimate user)
 * could have started via the ownership-checked `voice.start` mutation.
 */
export const findActiveByConversation = internalQuery({
  args: { agentId: v.id('agents'), conversationId: v.string() },
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query('voiceSessions')
      .withIndex('by_agent', (q) => q.eq('agentId', args.agentId))
      .collect();
    return (
      sessions.find(
        (s) => s.elevenLabsConversationId === args.conversationId && s.state === 'active',
      ) ?? null
    );
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
