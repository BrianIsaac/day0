/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

async function failedSession(state: 'active' | 'synthesising' = 'active') {
  const harness = convexTest(schema, allConvexModules());
  const { agentId, sessionId } = await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Mira',
      userId: 'owner',
      state: 'day-one-in-progress',
      createdAt: 1,
    });
    const sessionId = await ctx.db.insert('voiceSessions', {
      agentId,
      mode: 'chat',
      state,
      answers: {},
      turns: [
        { id: 'e0', speaker: 'employee', text: 'Why?', topicIndex: 0, at: 1 },
        { id: 'm0', speaker: 'manager', text: 'The close.', at: 2 },
      ],
      replyDraft: 'unsent',
      pendingTranscript: 'ASSISTANT: Why?\n\nUSER: The close.',
      pendingBossLabel: 'boss@day0.local',
      changeRequests: [{ reason: 'Name the deck.', struck: [], requestedAt: 2 }],
      recoveryAttempts: 3,
      finalisationError: 'the model timed out',
      finalisationFailedAt: 3,
      conversationEndedAt: 3,
      startedAt: 1,
    });
    return { agentId, sessionId };
  });
  return { harness, agentId, sessionId };
}

describe('holding the one-to-one again after its draft failed for good', (): void => {
  it('sets aside the kept conversation, the old transcript, the notes and the spent retries, so none reaches the next draft or its room', async (): Promise<void> => {
    const { harness, sessionId } = await failedSession();
    const owner = harness.withIdentity(managerIdentity());
    expect(await owner.mutation(api.voice.restart, { sessionId })).toEqual({ ok: true });
    const row = await harness.run(async (ctx) => await ctx.db.get(sessionId));
    // The conversation moves on, so a write still in flight for the one set aside is refused.
    expect(row).toMatchObject({ state: 'active', conversation: 1 });
    for (const field of [
      'turns',
      'replyDraft',
      'pendingTranscript',
      'pendingBossLabel',
      'changeRequests',
      'recoveryAttempts',
      'finalisationError',
      'finalisationFailedAt',
      'conversationEndedAt',
    ] as const) {
      expect(row?.[field], field).toBeUndefined();
    }
  });

  it('refuses while a finisher holds the session, and refuses anyone but the owner', async (): Promise<void> => {
    const { harness, sessionId } = await failedSession('synthesising');
    await expect(
      harness.withIdentity(managerIdentity()).mutation(api.voice.restart, { sessionId }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      harness.withIdentity(managerIdentity('stranger')).mutation(api.voice.restart, { sessionId }),
    ).rejects.toThrow();
    expect((await harness.run(async (ctx) => await ctx.db.get(sessionId)))?.pendingTranscript).toBe(
      'ASSISTANT: Why?\n\nUSER: The close.',
    );
  });
});

describe('when the conversation closed (second review x7)', (): void => {
  afterEach((): void => {
    vi.useRealTimers();
  });

  it('is the first claim of its transcript, kept when the draft is claimed again later', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { harness, agentId, sessionId } = await failedSession();
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(sessionId, { conversationEndedAt: undefined, recoveryAttempts: 0 });
    });
    const closed = Date.UTC(2026, 8, 29, 9, 40);
    vi.setSystemTime(closed);
    const claim = { sessionId, expectedAgentId: agentId, transcript: 'T', bossLabel: 'boss' };
    expect(await harness.mutation(internal.voice.claimFinalisation, claim)).toMatchObject({
      outcome: 'claimed',
    });
    // Handed back (a failed draft, or one the manager sent back), then claimed a day later.
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(sessionId, {
        state: 'active',
        claimToken: undefined,
        claimedAt: undefined,
      });
    });
    vi.setSystemTime(Date.UTC(2026, 8, 30, 11, 5));
    await harness.mutation(internal.voice.claimFinalisation, claim);
    const row = await harness.run(async (ctx) => await ctx.db.get(sessionId));
    expect(row?.conversationEndedAt).toBe(closed);
    expect(row?.claimedAt).toBe(Date.UTC(2026, 8, 30, 11, 5));
  });
});

describe('a call taking over a chat one-to-one (second pass)', (): void => {
  it('sets the chat’s close aside with its turns, so the call is dated by its own', async (): Promise<void> => {
    const { harness, agentId, sessionId } = await failedSession();
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(sessionId, { pendingTranscript: undefined, conversationEndedAt: 5 });
    });
    await harness
      .withIdentity(managerIdentity())
      .mutation(api.voice.start, { agentId, mode: 'elevenlabs' });
    const row = await harness.run(async (ctx) => await ctx.db.get(sessionId));
    expect(row?.turns).toBeUndefined();
    expect(row?.conversationEndedAt).toBeUndefined();
  });
});

describe('opening the one-to-one on a session already under way', (): void => {
  it('hands the room the conversation the session keeps, and the reply being typed', async (): Promise<void> => {
    const { harness, agentId, sessionId } = await failedSession();
    await harness.run(async (ctx) => {
      await ctx.db.patch(sessionId, {
        pendingTranscript: undefined,
        finalisationError: undefined,
        recoveryAttempts: undefined,
      });
    });
    const owner = harness.withIdentity(managerIdentity());
    expect(await owner.mutation(api.voice.start, { agentId, mode: 'chat' })).toMatchObject({
      sessionId,
      resumed: true,
      turns: [
        { id: 'e0', speaker: 'employee', text: 'Why?', topicIndex: 0, at: 1 },
        { id: 'm0', speaker: 'manager', text: 'The close.', at: 2 },
      ],
      replyDraft: 'unsent',
      conversation: 0,
    });
  });
});

describe('a call started over a chat one-to-one', (): void => {
  it('sets the chat turns aside, so switching back does not draw them over the call (second pass M2)', async (): Promise<void> => {
    const { harness, agentId, sessionId } = await failedSession();
    await harness.run(async (ctx) => {
      await ctx.db.patch(sessionId, {
        pendingTranscript: undefined,
        finalisationError: undefined,
        recoveryAttempts: undefined,
      });
    });
    const owner = harness.withIdentity(managerIdentity());
    expect(await owner.mutation(api.voice.start, { agentId, mode: 'elevenlabs' })).toMatchObject({
      turns: [],
      replyDraft: null,
      conversation: 1,
    });
    const row = await harness.run(async (ctx) => await ctx.db.get(sessionId));
    expect(row?.turns).toBeUndefined();
    expect(row?.replyDraft).toBeUndefined();
    // Back in chat the stamp stays where leaving chat moved it: the new chat room is told it.
    expect(await owner.mutation(api.voice.start, { agentId, mode: 'chat' })).toMatchObject({
      conversation: 1,
    });
  });
});
