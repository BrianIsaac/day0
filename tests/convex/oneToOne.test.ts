/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { ConvexError } from 'convex/values';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { oneToOnePhase } from '../../src/agent/one-to-one-phase';
import { allConvexModules } from './all-modules';

const ANSWERS = [
  'Tier-2 asks swamp the close.',
  'Own triage in month one.',
  'Priya in finance ops.',
  'The close runbook.',
  'Linear and Slack #revops.',
  'The September close starts Monday.',
  'Nothing else for now.',
];

interface Room {
  readonly harness: TestConvex<typeof schema>;
  readonly owner: ReturnType<TestConvex<typeof schema>['withIdentity']>;
  readonly agentId: Id<'agents'>;
  readonly sessionId: Id<'voiceSessions'>;
}

/** An employee on day zero whose chat one-to-one has been opened by the room. */
async function openRoom(): Promise<Room> {
  const harness = convexTest(schema, allConvexModules());
  const agentId = await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Aiko',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
      }),
  );
  const owner = harness.withIdentity({ subject: 'owner' });
  const { sessionId } = await owner.mutation(api.voice.start, { agentId, mode: 'chat' });
  return { harness, owner, agentId, sessionId };
}

async function sessionOf(room: Room): Promise<Doc<'voiceSessions'>> {
  const row = await room.harness.run(async (ctx) => await ctx.db.get(room.sessionId));
  if (!row) throw new Error('no session');
  return row;
}

/** The employee's answer to whatever the conversation last asked of it, as the route keeps it. */
async function answer(
  room: Room,
  answering: string | null,
  id: string,
  topicIndex: number,
  closingLine?: string,
): Promise<unknown> {
  return await room.owner.mutation(api.oneToOne.recordAnswer, {
    sessionId: room.sessionId,
    bossLabel: 'boss@day0.local',
    answer: {
      answering,
      id,
      text: closingLine === undefined ? `Question ${topicIndex + 1}?` : '',
      topicIndex,
      ...(closingLine === undefined ? {} : { closingLine }),
    },
  });
}

/** Hold the one-to-one through `replies` answers, each question answered and kept. */
async function holdThrough(room: Room, replies: number): Promise<void> {
  await room.owner.mutation(api.oneToOne.takeTurn, {
    agentId: room.agentId,
    request: { kind: 'open' },
  });
  await answer(room, null, 'e0', 0);
  for (let index = 0; index < replies; index += 1) {
    const { answering } = await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: { kind: 'reply', id: `m${index}`, text: ANSWERS[index] },
    });
    if (index < 6) await answer(room, answering, `e${index + 1}`, index + 1);
  }
}

async function scheduledDrafts(room: Room): Promise<number> {
  const scheduled = await room.harness.run(
    async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
  );
  return scheduled.filter((job) => job.name.includes('draftKeptConversation')).length;
}

afterEach((): void => {
  vi.useRealTimers();
});

describe('the chat one-to-one kept turn by turn (30 Sep, a one-to-one lost to a closed tab)', (): void => {
  it('keeps every answer on the session as it is given, so a room closed at any question reopens on them', async (): Promise<void> => {
    const room = await openRoom();
    await holdThrough(room, 3);
    const turns = (await sessionOf(room)).turns ?? [];
    expect(turns.map((turn) => `${turn.speaker}:${turn.id}`)).toEqual([
      'employee:e0',
      'manager:m0',
      'employee:e1',
      'manager:m1',
      'employee:e2',
      'manager:m2',
      'employee:e3',
    ]);
    expect(turns.filter((turn) => turn.speaker === 'manager').map((turn) => turn.text)).toEqual(
      ANSWERS.slice(0, 3),
    );
    expect(turns.find((turn) => turn.id === 'e3')?.topicIndex).toBe(3);
  });

  it("keeps the manager's reply before the employee answers, so closing while it answers loses nothing", async (): Promise<void> => {
    const room = await openRoom();
    await holdThrough(room, 7);
    const turns = (await sessionOf(room)).turns ?? [];
    expect(turns.at(-1)).toMatchObject({ speaker: 'manager', id: 'm6', text: ANSWERS[6] });
    expect(turns.filter((turn) => turn.speaker === 'manager')).toHaveLength(7);
    // The room reopened on it asks again: the employee answers the seventh reply, not question 1.
    const reopened = await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: { kind: 'ask-again', reply: { id: 'm6', text: ANSWERS[6] }, discarding: null },
    });
    expect(reopened.answering).toBe('m6');
    expect(reopened.turns).toHaveLength(14);
  });

  it('starts the draft from the kept conversation in the transaction that keeps an earned close', async (): Promise<void> => {
    vi.useFakeTimers();
    const room = await openRoom();
    await holdThrough(room, 7);
    expect(await answer(room, 'm6', 'e7', 6, 'Thanks, drafting now.')).toEqual({
      kept: true,
      closed: true,
    });
    const session = await sessionOf(room);
    expect(oneToOnePhase(session)).toEqual({ kind: 'drafting' });
    // Claimed for the manager's side, as the room's post claimed it: every re-drive is still left.
    expect(session).toMatchObject({ state: 'synthesising', claimedBy: 'browser' });
    expect(session.recoveryAttempts).toBeUndefined();
    expect(session.turns?.at(-1)).toMatchObject({ closingLine: 'Thanks, drafting now.' });
    for (const reply of ANSWERS) expect(session.pendingTranscript).toContain(`USER: ${reply}`);
    expect(session.pendingTranscript).toContain('ASSISTANT: Thanks, drafting now.');
    expect(session.pendingBossLabel).toBe('boss@day0.local');
    expect(await scheduledDrafts(room)).toBe(1);
  });

  it('keeps a close that is not yet earned as a plain answer, and drafts nothing', async (): Promise<void> => {
    const room = await openRoom();
    await holdThrough(room, 5);
    await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: { kind: 'reply', id: 'm5', text: ANSWERS[5] },
    });
    // Six replies: the seventh question has not been asked, let alone answered.
    expect(await answer(room, 'm5', 'e-early', 6, 'All done!')).toEqual({
      kept: true,
      closed: false,
    });
    const session = await sessionOf(room);
    expect(session.turns?.at(-1)?.closingLine).toBeUndefined();
    expect(oneToOnePhase(session)).toEqual({ kind: 'talking' });
    expect(await scheduledDrafts(room)).toBe(0);
  });

  it('keeps an answer only where the conversation still ends, and the same answer once', async (): Promise<void> => {
    const room = await openRoom();
    await holdThrough(room, 2);
    expect(await answer(room, 'm0', 'e-stale', 1)).toMatchObject({ kept: false });
    expect(await answer(room, 'm1', 'e2', 2)).toEqual({ kept: true, closed: false });
    expect((await sessionOf(room)).turns).toHaveLength(5);
  });

  it('takes a reply sent again after a lost connection once, and keeps a second reply in a row (second pass H2, re-pinned)', async (): Promise<void> => {
    const room = await openRoom();
    await holdThrough(room, 1);
    await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: { kind: 'reply', id: 'm1', text: ANSWERS[1] },
    });
    const again = await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: { kind: 'reply', id: 'm1', text: ANSWERS[1] },
    });
    expect(again.answering).toBe('m1');
    // The answer to m1 never came (a failed turn); the manager's next reply is kept, not refused.
    const second = await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: { kind: 'reply', id: 'm2', text: 'And another thing.' },
    });
    expect(second.answering).toBe('m2');
    expect(
      (await sessionOf(room)).turns?.filter((turn) => turn.speaker === 'manager'),
    ).toHaveLength(3);
  });

  it('keeps an answer and the reply whose send failed when the room asks again (second pass H1)', async (): Promise<void> => {
    const room = await openRoom();
    await holdThrough(room, 2);
    // The room sent m2, which never reached the session, then pressed Ask again.
    const again = await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: { kind: 'ask-again', reply: { id: 'm2', text: ANSWERS[2] }, discarding: null },
    });
    expect(again.answering).toBe('m2');
    expect((await sessionOf(room)).turns?.slice(-2).map((turn) => turn.id)).toEqual(['e2', 'm2']);
  });

  it('refuses a turn once the one-to-one is drafting, and refuses anyone but the owner', async (): Promise<void> => {
    const room = await openRoom();
    await holdThrough(room, 1);
    await expect(
      room.harness.withIdentity({ subject: 'stranger' }).mutation(api.oneToOne.takeTurn, {
        agentId: room.agentId,
        request: { kind: 'ask-again', reply: null, discarding: null },
      }),
    ).rejects.toThrow();
    await room.owner.mutation(api.oneToOne.finish, {
      sessionId: room.sessionId,
      bossLabel: 'boss@day0.local',
    });
    await expect(
      room.owner.mutation(api.oneToOne.takeTurn, {
        agentId: room.agentId,
        request: { kind: 'reply', id: 'm9', text: 'One more.' },
      }),
    ).rejects.toBeInstanceOf(ConvexError);
  });
});

describe('the one-to-one a turn belongs to', (): void => {
  it("is the employee's held session, refused before one is open", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name: 'Nia',
          userId: 'owner',
          state: 'deployed',
          createdAt: 1,
        }),
    );
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.mutation(api.oneToOne.takeTurn, { agentId, request: { kind: 'open' } }),
    ).rejects.toBeInstanceOf(ConvexError);
    const { sessionId } = await owner.mutation(api.voice.start, { agentId, mode: 'chat' });
    expect(
      await owner.mutation(api.oneToOne.takeTurn, { agentId, request: { kind: 'open' } }),
    ).toEqual({ sessionId, turns: [], answering: null });
  });
});

describe("finishing the chat one-to-one at the manager's word", (): void => {
  it('drafts from the kept conversation, whether or not a room stays open', async (): Promise<void> => {
    vi.useFakeTimers();
    const room = await openRoom();
    await holdThrough(room, 2);
    expect(
      await room.owner.mutation(api.oneToOne.finish, {
        sessionId: room.sessionId,
        bossLabel: 'boss@day0.local',
      }),
    ).toEqual({ ok: true });
    const session = await sessionOf(room);
    expect(oneToOnePhase(session)).toEqual({ kind: 'drafting' });
    expect(session.pendingTranscript).toContain(`USER: ${ANSWERS[1]}`);
    // Finish sent again after a lost connection starts nothing twice.
    await room.owner.mutation(api.oneToOne.finish, {
      sessionId: room.sessionId,
      bossLabel: 'boss@day0.local',
    });
    expect(await scheduledDrafts(room)).toBe(1);
  });

  it('refuses before the manager has answered anything', async (): Promise<void> => {
    const room = await openRoom();
    await holdThrough(room, 0);
    await expect(
      room.owner.mutation(api.oneToOne.finish, {
        sessionId: room.sessionId,
        bossLabel: 'boss@day0.local',
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect((await sessionOf(room)).pendingTranscript).toBeUndefined();
  });
});

describe('the reply being typed', (): void => {
  it('is kept as the manager types, bounded, and cleared once the reply is sent', async (): Promise<void> => {
    const room = await openRoom();
    await holdThrough(room, 1);
    await room.owner.mutation(api.oneToOne.keepReplyDraft, {
      sessionId: room.sessionId,
      text: 'Half of my ans',
      after: 'm0',
    });
    expect((await sessionOf(room)).replyDraft).toBe('Half of my ans');
    await room.owner.mutation(api.oneToOne.keepReplyDraft, {
      sessionId: room.sessionId,
      text: 'x'.repeat(5000),
      after: 'm0',
    });
    expect((await sessionOf(room)).replyDraft).toHaveLength(4000);
    await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: { kind: 'reply', id: 'm1', text: ANSWERS[1] },
    });
    expect((await sessionOf(room)).replyDraft).toBeUndefined();
    // A keep typed before the send, arriving after it, would put the sent reply back.
    expect(
      await room.owner.mutation(api.oneToOne.keepReplyDraft, {
        sessionId: room.sessionId,
        text: ANSWERS[1],
        after: 'm0',
      }),
    ).toEqual({ kept: false });
    expect((await sessionOf(room)).replyDraft).toBeUndefined();
  });
});
