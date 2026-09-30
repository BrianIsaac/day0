/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { ConvexError } from 'convex/values';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

async function failedSession(state: 'active' | 'synthesising' = 'active') {
  const harness = convexTest(schema, allConvexModules());
  const { agentId, sessionId } = await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
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
      startedAt: 1,
    });
    return { agentId, sessionId };
  });
  return { harness, agentId, sessionId };
}

describe('holding the one-to-one again after its draft failed for good', (): void => {
  it('sets aside the kept conversation, the old transcript, the notes and the spent retries, so none reaches the next draft or its room', async (): Promise<void> => {
    const { harness, sessionId } = await failedSession();
    const owner = harness.withIdentity({ subject: 'owner' });
    expect(await owner.mutation(api.voice.restart, { sessionId })).toEqual({ ok: true });
    const row = await harness.run(async (ctx) => await ctx.db.get(sessionId));
    expect(row).toMatchObject({ state: 'active' });
    for (const field of [
      'turns',
      'replyDraft',
      'pendingTranscript',
      'pendingBossLabel',
      'changeRequests',
      'recoveryAttempts',
      'finalisationError',
      'finalisationFailedAt',
    ] as const) {
      expect(row?.[field], field).toBeUndefined();
    }
  });

  it('refuses while a finisher holds the session, and refuses anyone but the owner', async (): Promise<void> => {
    const { harness, sessionId } = await failedSession('synthesising');
    await expect(
      harness.withIdentity({ subject: 'owner' }).mutation(api.voice.restart, { sessionId }),
    ).rejects.toBeInstanceOf(ConvexError);
    await expect(
      harness.withIdentity({ subject: 'stranger' }).mutation(api.voice.restart, { sessionId }),
    ).rejects.toThrow();
    expect((await harness.run(async (ctx) => await ctx.db.get(sessionId)))?.pendingTranscript).toBe(
      'ASSISTANT: Why?\n\nUSER: The close.',
    );
  });
});
