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
  conversation = 0,
): Promise<unknown> {
  return await room.owner.mutation(api.oneToOne.recordAnswer, {
    sessionId: room.sessionId,
    conversation,
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
      request: reply(`e${index}`, [`m${index}`, ANSWERS[index]]),
    });
    if (index < 6) await answer(room, answering, `e${index + 1}`, index + 1);
  }
}

/** A reply to `question`, with the replies drawn since it, as the room sends one. */
function reply(
  question: string | null,
  ...replies: Array<[string, string]>
): { kind: 'reply'; question: string | null; replies: Array<{ id: string; text: string }> } {
  return { kind: 'reply', question, replies: replies.map(([id, text]) => ({ id, text })) };
}

/** A turn asked again, as the room asks one. */
function again(
  question: string | null,
  replies: Array<[string, string]>,
  discarding: string | null = null,
): {
  kind: 'ask-again';
  question: string | null;
  replies: Array<{ id: string; text: string }>;
  discarding: string | null;
} {
  return {
    kind: 'ask-again',
    question,
    replies: replies.map(([id, text]) => ({ id, text })),
    discarding,
  };
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
      request: again('e6', [['m6', ANSWERS[6]]]),
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
      request: reply('e5', ['m5', ANSWERS[5]]),
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
      request: reply('e1', ['m1', ANSWERS[1]]),
    });
    const sentAgain = await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: reply('e1', ['m1', ANSWERS[1]]),
    });
    expect(sentAgain.answering).toBe('m1');
    // The answer to m1 never came (a failed turn); the manager's next reply is kept, not refused.
    const second = await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: reply('e1', ['m1', ANSWERS[1]], ['m2', 'And another thing.']),
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
    const asked = await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: again('e2', [['m2', ANSWERS[2]]]),
    });
    expect(asked.answering).toBe('m2');
    expect((await sessionOf(room)).turns?.slice(-2).map((turn) => turn.id)).toEqual(['e2', 'm2']);
  });

  it('refuses a turn once the one-to-one is drafting, and refuses anyone but the owner', async (): Promise<void> => {
    const room = await openRoom();
    await holdThrough(room, 1);
    await expect(
      room.harness.withIdentity({ subject: 'stranger' }).mutation(api.oneToOne.takeTurn, {
        agentId: room.agentId,
        request: again(null, []),
      }),
    ).rejects.toThrow();
    await room.owner.mutation(api.oneToOne.finish, {
      sessionId: room.sessionId,
      conversation: 0,
      bossLabel: 'boss@day0.local',
    });
    await expect(
      room.owner.mutation(api.oneToOne.takeTurn, {
        agentId: room.agentId,
        request: reply('e1', ['m9', 'One more.']),
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
    ).toEqual({ sessionId, conversation: 0, turns: [], answering: null });
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
        conversation: 0,
        bossLabel: 'boss@day0.local',
      }),
    ).toEqual({ ok: true });
    const session = await sessionOf(room);
    expect(oneToOnePhase(session)).toEqual({ kind: 'drafting' });
    expect(session.pendingTranscript).toContain(`USER: ${ANSWERS[1]}`);
    // Finish sent again after a lost connection starts nothing twice.
    await room.owner.mutation(api.oneToOne.finish, {
      sessionId: room.sessionId,
      conversation: 0,
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
        conversation: 0,
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
      conversation: 0,
      text: 'Half of my ans',
      after: 'm0',
    });
    expect((await sessionOf(room)).replyDraft).toBe('Half of my ans');
    await room.owner.mutation(api.oneToOne.keepReplyDraft, {
      sessionId: room.sessionId,
      conversation: 0,
      text: 'x'.repeat(5000),
      after: 'm0',
    });
    expect((await sessionOf(room)).replyDraft).toHaveLength(4000);
    await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: reply('e1', ['m1', ANSWERS[1]]),
    });
    expect((await sessionOf(room)).replyDraft).toBeUndefined();
    // A keep typed before the send, arriving after it, would put the sent reply back.
    expect(
      await room.owner.mutation(api.oneToOne.keepReplyDraft, {
        sessionId: room.sessionId,
        conversation: 0,
        text: ANSWERS[1],
        after: 'm0',
      }),
    ).toEqual({ kept: false });
    expect((await sessionOf(room)).replyDraft).toBeUndefined();
  });
});

/** The kept turns, as `speaker:id`, for asserting what a stale write did or did not change. */
async function keptTurns(room: Room): Promise<string[]> {
  return ((await sessionOf(room)).turns ?? []).map((turn) => `${turn.speaker}:${turn.id}`);
}

describe('the turn fence: a write lands only on the conversation it was composed against (review M1)', (): void => {
  for (const transition of ['restart', 'voice'] as const) {
    it(`refuses the opening answer still in flight when the one-to-one is ${transition === 'restart' ? 'started again' : 'moved to a call'} (codex repro)`, async (): Promise<void> => {
      const room = await openRoom();
      const taken = await room.owner.mutation(api.oneToOne.takeTurn, {
        agentId: room.agentId,
        request: { kind: 'open' },
      });
      if (transition === 'restart') {
        await room.owner.mutation(api.voice.restart, { sessionId: room.sessionId });
      } else {
        await room.owner.mutation(api.voice.start, { agentId: room.agentId, mode: 'elevenlabs' });
      }
      expect(
        await answer(room, null, 'old-opening', 0, undefined, taken.conversation),
      ).toMatchObject({ kept: false });
      expect(await keptTurns(room)).toEqual([]);
    });
  }

  it("refuses a stale window's reply after the one-to-one started again, and keeps the new opening (codex repro)", async (): Promise<void> => {
    const room = await openRoom();
    await answer(room, null, 'opening-a', 0);
    await room.owner.mutation(api.voice.restart, { sessionId: room.sessionId });
    const { conversation } = await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: { kind: 'open' },
    });
    expect(conversation).toBe(1);
    await answer(room, null, 'opening-b', 0, undefined, conversation);
    await expect(
      room.owner.mutation(api.oneToOne.takeTurn, {
        agentId: room.agentId,
        request: reply('opening-a', ['stale-reply', 'Answer to the old question']),
      }),
    ).rejects.toBeInstanceOf(ConvexError);
    expect(await keptTurns(room)).toEqual(['employee:opening-b']);
  });

  it("refuses a second window's reply to a question the conversation has moved past (Fable F1)", async (): Promise<void> => {
    const room = await openRoom();
    await answer(room, null, 'q1', 0);
    // Window A answers question 1 and is asked question 2; window B still draws question 1.
    await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: reply('q1', ['a1', 'Window A on question 1']),
    });
    await answer(room, 'a1', 'q2', 1);
    await expect(
      room.owner.mutation(api.oneToOne.takeTurn, {
        agentId: room.agentId,
        request: reply('q1', ['b1', 'Window B, also on question 1']),
      }),
    ).rejects.toThrow('moved on in another window');
    expect(await keptTurns(room)).toEqual(['employee:q1', 'manager:a1', 'employee:q2']);
  });

  it('refuses every chat write on a session a call now holds (Fable F2)', async (): Promise<void> => {
    const room = await openRoom();
    await room.owner.mutation(api.voice.start, { agentId: room.agentId, mode: 'elevenlabs' });
    await expect(
      room.owner.mutation(api.oneToOne.takeTurn, {
        agentId: room.agentId,
        request: { kind: 'open' },
      }),
    ).rejects.toThrow('moved to a call');
    // Even an answer naming the conversation the call holds belongs to no chat.
    expect(await answer(room, null, 'late', 0, undefined, 1)).toMatchObject({ kept: false });
    expect(
      await room.owner.mutation(api.oneToOne.keepReplyDraft, {
        sessionId: room.sessionId,
        conversation: 1,
        text: 'Typed in the chat.',
        after: null,
      }),
    ).toEqual({ kept: false });
    const session = await sessionOf(room);
    expect(session.mode).toBe('elevenlabs');
    expect(session.turns).toBeUndefined();
    expect(session.replyDraft).toBeUndefined();
  });

  it('refuses a stale draft and a stale Finish once the one-to-one started again', async (): Promise<void> => {
    vi.useFakeTimers();
    const room = await openRoom();
    await holdThrough(room, 2);
    await room.owner.mutation(api.voice.restart, { sessionId: room.sessionId });
    await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: { kind: 'open' },
    });
    await answer(room, null, 'n0', 0, undefined, 1);
    await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: reply('n0', ['n-m0', 'The new first answer.']),
    });
    expect(
      await room.owner.mutation(api.oneToOne.keepReplyDraft, {
        sessionId: room.sessionId,
        conversation: 0,
        text: 'Typed in the old conversation.',
        after: 'n-m0',
      }),
    ).toEqual({ kept: false });
    await expect(
      room.owner.mutation(api.oneToOne.finish, {
        sessionId: room.sessionId,
        conversation: 0,
        bossLabel: 'boss@day0.local',
      }),
    ).rejects.toThrow('started again');
    const session = await sessionOf(room);
    expect(session.replyDraft).toBeUndefined();
    expect(session.pendingTranscript).toBeUndefined();
    expect(await keptTurns(room)).toEqual(['employee:n0', 'manager:n-m0']);
    expect(await scheduledDrafts(room)).toBe(0);
  });

  it('keeps a reply whose send failed before the one sent after it, and clears the draft of both (Fable M2)', async (): Promise<void> => {
    const room = await openRoom();
    await holdThrough(room, 1);
    await room.owner.mutation(api.oneToOne.keepReplyDraft, {
      sessionId: room.sessionId,
      conversation: 0,
      text: 'FIRST: escalate anything over 50k.',
      after: 'm0',
    });
    // FIRST never reached the session; SECOND is sent after it and carries it.
    await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: reply(
        'e1',
        ['m1', 'FIRST: escalate anything over 50k.'],
        ['m2', 'SECOND: report on Mondays.'],
      ),
    });
    const session = await sessionOf(room);
    expect(session.turns?.slice(-2).map((turn) => turn.text)).toEqual([
      'FIRST: escalate anything over 50k.',
      'SECOND: report on Mondays.',
    ]);
    expect(session.replyDraft).toBeUndefined();
  });
});

describe('the reply being typed, once a reply is kept by Ask again (review M3)', (): void => {
  it('is cleared when Ask again delivers the failed send, so the reopened composer is empty (codex repro)', async (): Promise<void> => {
    const room = await openRoom();
    await answer(room, null, 'opening', 0);
    await room.owner.mutation(api.oneToOne.keepReplyDraft, {
      sessionId: room.sessionId,
      conversation: 0,
      after: null,
      text: 'The answer I will send',
    });
    await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: again('opening', [['offline-send', 'The answer I will send']]),
    });
    await answer(room, 'offline-send', 'answer', 1);
    const resumed = await room.owner.mutation(api.voice.start, {
      agentId: room.agentId,
      mode: 'chat',
    });
    expect(resumed.replyDraft).toBeNull();
    expect(resumed.turns.map((turn) => turn.id)).toEqual(['opening', 'offline-send', 'answer']);
  });

  it('is left alone by an Ask again that keeps no reply', async (): Promise<void> => {
    const room = await openRoom();
    await holdThrough(room, 1);
    await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: reply('e1', ['m1', ANSWERS[1]]),
    });
    await room.owner.mutation(api.oneToOne.keepReplyDraft, {
      sessionId: room.sessionId,
      conversation: 0,
      after: 'm1',
      text: 'Typing the next one',
    });
    await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: again('e1', [['m1', ANSWERS[1]]]),
    });
    expect((await sessionOf(room)).replyDraft).toBe('Typing the next one');
  });
});

describe('the bounds a direct call is held to', (): void => {
  it('keeps no more than 40 turns, the last answer included: 40 stays 40 (codex m1)', async (): Promise<void> => {
    const room = await openRoom();
    const turns = Array.from({ length: 40 }, (_, index) => ({
      id: `t${index}`,
      speaker: index % 2 === 1 ? ('manager' as const) : ('employee' as const),
      text: 'text',
      at: index,
    }));
    await room.harness.run(async (ctx) => await ctx.db.patch(room.sessionId, { turns }));
    expect(await answer(room, 't39', 'answer41', 6)).toMatchObject({ kept: false });
    expect((await sessionOf(room)).turns).toHaveLength(40);
  });

  it('refuses an answer under the id of a turn it already keeps (Fable m8)', async (): Promise<void> => {
    const room = await openRoom();
    await holdThrough(room, 1);
    await room.owner.mutation(api.oneToOne.takeTurn, {
      agentId: room.agentId,
      request: reply('e1', ['m1', ANSWERS[1]]),
    });
    expect(await answer(room, 'm1', 'e0', 2)).toMatchObject({ kept: false });
    expect(await keptTurns(room)).toEqual([
      'employee:e0',
      'manager:m0',
      'employee:e1',
      'manager:m1',
    ]);
  });

  for (const name of ['recordAnswer', 'finish', 'keepReplyDraft'] as const) {
    it(`refuses anyone but the owner at ${name}, and writes nothing (Fable m9)`, async (): Promise<void> => {
      const room = await openRoom();
      await holdThrough(room, 1);
      const stranger = room.harness.withIdentity({ subject: 'stranger' });
      const before = await sessionOf(room);
      const attempt =
        name === 'recordAnswer'
          ? stranger.mutation(api.oneToOne.recordAnswer, {
              sessionId: room.sessionId,
              conversation: 0,
              bossLabel: 'x',
              answer: { answering: 'e1', id: 'x', text: 'x', topicIndex: 0 },
            })
          : name === 'finish'
            ? stranger.mutation(api.oneToOne.finish, {
                sessionId: room.sessionId,
                conversation: 0,
                bossLabel: 'x',
              })
            : stranger.mutation(api.oneToOne.keepReplyDraft, {
                sessionId: room.sessionId,
                conversation: 0,
                text: 'x',
                after: 'm0',
              });
      await expect(attempt).rejects.toThrow();
      expect(await sessionOf(room)).toEqual(before);
    });
  }
});
