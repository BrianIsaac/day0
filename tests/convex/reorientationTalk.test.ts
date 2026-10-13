/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { MAX_KEPT_TURNS } from '../../src/agent/one-to-one-conversation';
import type { ProposalReply } from '../../src/agent/reorientation-proposal';
import { allConvexModules } from './all-modules';
import { OWNER_SUBJECT, managerIdentity } from './fakes/manager-identity';
import { seedEdge, seedPerson } from './fakes/people-graph';
import { basisOf, cardOf, eventTypesOf, seedEmployee } from './fakes/reorientation';

/*
 * The Discuss conversation's store (wave 16, 16-D; the wave file's 5.3, RM10 (a)): a talk of its
 * own per card, kept turn by turn on the one-to-one's rules, opening it puts the card at
 * `discussing`, and its outcome replaces the card's proposal (`by: 'discussion'`) with the card
 * back at `open`. It applies nothing, it resumes from any point, an agent-quoted phrase never
 * becomes its evidence, and the one-to-one's session never hears of it.
 */

const OWNER = managerIdentity();

beforeEach((): void => {
  vi.useFakeTimers();
});
afterEach((): void => {
  vi.useRealTimers();
});

interface Bed {
  readonly harness: TestConvex<typeof schema>;
  readonly owner: ReturnType<TestConvex<typeof schema>['withIdentity']>;
  readonly agentId: Id<'agents'>;
  readonly cardId: Id<'reorientations'>;
}

/** The handover's quickest card: a change of role opened by hand, which reaches the whole charter. */
async function openedCard(): Promise<Bed> {
  const harness = convexTest(schema, allConvexModules());
  const agentId = await seedEmployee(harness);
  const owner = harness.withIdentity(OWNER);
  const { reorientationId } = await owner.mutation(api.reorientationDecisions.openByHand, {
    agentId,
    summary: 'Priya now approves committee-deck numbers',
  });
  if (reorientationId === null) throw new Error('no card opened');
  return { harness, owner, agentId, cardId: reorientationId };
}

/** The handover's case: what the employee asks, and what the manager answers. */
const OPENING = 'Priya now approves committee-deck numbers. Should those drafts go to her first?';
const ANSWER = 'Yes, send committee-deck drafts to Priya first, then to me.';

/** A turn the room asks of the talk, as the route posts it. */
interface TalkRequest {
  readonly kind: 'open' | 'reply' | 'ask-again' | 'finish';
  readonly question?: string | null;
  readonly replies?: Array<{ id: string; text: string }>;
  readonly discarding?: string | null;
}

/** The talk taken one turn, as the route takes it, or the refusal it was given. */
async function take(
  bed: Bed,
  request: TalkRequest,
): Promise<
  | {
      taken: true;
      talkId: Id<'reorientationTalks'>;
      conversation: number;
      answering: string | null;
      candidatesKey: string;
      turns: Doc<'reorientationTalks'>['turns'];
      employeeName: string;
      system: string;
      unkept: number;
    }
  | { taken: false; refusal: string }
> {
  return (await bed.owner.mutation(api.reorientationTalk.takeTurn, {
    reorientationId: bed.cardId,
    request: request as never,
  })) as never;
}

/** A taken turn, failing the test on a refusal. */
async function taken(
  bed: Bed,
  request: Parameters<typeof take>[1],
): Promise<Extract<Awaited<ReturnType<typeof take>>, { taken: true }>> {
  const result = await take(bed, request);
  if (!result.taken) throw new Error(`refused: ${result.refusal}`);
  return result;
}

/** The talk opened and its opening answer kept, as the route keeps it. */
async function opened(
  bed: Bed,
): Promise<Extract<Awaited<ReturnType<typeof take>>, { taken: true }>> {
  const turn = await taken(bed, { kind: 'open' });
  await expect(
    bed.owner.mutation(api.reorientationTalk.recordAnswer, {
      talkId: turn.talkId,
      conversation: turn.conversation,
      candidatesKey: turn.candidatesKey,
      answer: { answering: null, id: 'e0', text: OPENING },
    }),
  ).resolves.toEqual({ kept: true, ended: false });
  return turn;
}

/** The outcome a `reorientationComplete` call carries: candidate 3 is the Escalates clause. */
function outcome(
  quotes: string[] = ['send committee-deck drafts to Priya first, then to me'],
  candidate = 3,
): { reply: ProposalReply; quotes: string[] } {
  return {
    reply: {
      change: 'edit-clause',
      candidate,
      action: null,
      text: 'Surface tier-2 drafts about committee-deck numbers to Priya first, then to the manager',
      rationale: 'You said committee-deck drafts go to Priya first now.',
    },
    quotes,
  };
}

/** The manager's reply taken and the employee's answer, ending the talk with `ending`. */
async function answered(
  bed: Bed,
  ending?: ReturnType<typeof outcome>,
): Promise<{ kept: true; ended: boolean } | { kept: false; refusal: string }> {
  const turn = await taken(bed, {
    kind: 'reply',
    question: 'e0',
    replies: [{ id: 'm0', text: ANSWER }],
  });
  return await bed.owner.mutation(api.reorientationTalk.recordAnswer, {
    talkId: turn.talkId,
    conversation: turn.conversation,
    candidatesKey: turn.candidatesKey,
    answer: { answering: turn.answering, id: 'e1', text: 'I will put that on the card.' },
    ...(ending === undefined ? {} : { outcome: ending }),
  });
}

/** The card's one talk as stored. */
async function talkOf(bed: Bed): Promise<Doc<'reorientationTalks'>> {
  const talks = await bed.harness.run(
    async (ctx) =>
      await ctx.db
        .query('reorientationTalks')
        .withIndex('by_reorientation', (q) => q.eq('reorientationId', bed.cardId))
        .collect(),
  );
  expect(talks).toHaveLength(1);
  return talks[0];
}

describe('opening a talk', (): void => {
  it('puts the card at discussing and keeps the opening on a talk of its own', async (): Promise<void> => {
    const bed = await openedCard();
    const turn = await opened(bed);
    expect(turn).toMatchObject({ employeeName: 'Mira' });
    expect(turn.system).toContain('What changed: Priya now approves committee-deck numbers');
    expect(turn.system).toContain(
      '3. Charter clause (Escalates when): “Surface tier-2 answer drafts to the manager for review” [edit-clause]',
    );
    expect((await cardOf(bed.harness, bed.cardId)).status).toBe('discussing');
    expect(await talkOf(bed)).toMatchObject({
      agentId: bed.agentId,
      state: 'active',
      conversation: 0,
      turns: [{ id: 'e0', speaker: 'employee', text: OPENING }],
    });
  });

  it('keeps one talk per card: a second opening is refused in the talk’s words', async (): Promise<void> => {
    const bed = await openedCard();
    await opened(bed);
    await expect(take(bed, { kind: 'open' })).resolves.toEqual({
      taken: false,
      refusal: 'The talk has already begun. Reload to carry on.',
    });
    await talkOf(bed);
  });

  it('refuses a card already decided, and closes its talk', async (): Promise<void> => {
    const bed = await openedCard();
    await opened(bed);
    await bed.owner.mutation(api.reorientationDecisions.dismiss, { reorientationId: bed.cardId });
    await expect(
      take(bed, { kind: 'reply', question: 'e0', replies: [{ id: 'm0', text: ANSWER }] }),
    ).resolves.toEqual({
      taken: false,
      refusal: 'The card was decided, so the talk about it is closed.',
    });
    expect((await talkOf(bed)).state).toBe('closed');
    expect((await cardOf(bed.harness, bed.cardId)).status).toBe('dismissed');
  });

  it('tells another owner what a card that is not stored is told, at the turn, the finish and the page (W16-R35)', async (): Promise<void> => {
    // The review's W16-R35: `ownedCard`, `ownedTalk` and `forCard` read the row and said "gone"
    // before the owner was checked, so a signed-in stranger could tell a card that exists (the
    // employee is not yours) from one that does not.
    const bed = await openedCard();
    const stranger = bed.harness.withIdentity(managerIdentity('someone-else'));
    const refused = { taken: false, refusal: 'This card is gone.' };
    expect(
      await stranger.mutation(api.reorientationTalk.takeTurn, {
        reorientationId: bed.cardId,
        request: { kind: 'open' },
      }),
    ).toEqual(refused);
    expect((await cardOf(bed.harness, bed.cardId)).status).toBe('open');
    expect(
      await stranger.query(api.reorientationTalk.forCard, { reorientationId: bed.cardId }),
    ).toBeNull();
    // The owner's own talk, then the stranger at its write path: the same answer as for a talk
    // that is not stored, and nothing written.
    const turn = await taken(bed, { kind: 'open' });
    expect(
      await stranger.mutation(api.reorientationTalk.keepReplyDraft, {
        talkId: turn.talkId,
        conversation: turn.conversation,
        text: 'a stranger’s words',
        after: null,
      }),
    ).toEqual({ kept: false });
    expect((await talkOf(bed)).replyDraft).toBeUndefined();
  });
});

describe('the conversation ends in a proposal on the card and applies nothing', (): void => {
  it('replaces the card’s proposal by the discussion’s, back at open, and applies nothing', async (): Promise<void> => {
    const bed = await openedCard();
    await opened(bed);
    const before = await bed.harness.run(async (ctx) => ({
      charters: await ctx.db.query('charters').collect(),
      agent: await ctx.db.get(bed.agentId),
    }));
    await expect(answered(bed, outcome())).resolves.toEqual({ kept: true, ended: true });
    const card = await cardOf(bed.harness, bed.cardId);
    expect(card.status).toBe('open');
    expect(card.proposed).toEqual({
      kind: 'charter-change',
      changes: [
        {
          kind: 'edit-clause',
          field: 'escalationTriggers',
          index: 0,
          text: 'Surface tier-2 drafts about committee-deck numbers to Priya first, then to the manager',
        },
      ],
      rationale: 'You said committee-deck drafts go to Priya first now.',
      before: 'Surface tier-2 answer drafts to the manager for review',
      after:
        'Surface tier-2 drafts about committee-deck numbers to Priya first, then to the manager',
    });
    expect(
      await bed.harness.run(async (ctx) => ({
        charters: await ctx.db.query('charters').collect(),
        agent: await ctx.db.get(bed.agentId),
      })),
    ).toEqual(before);
    expect(await eventTypesOf(bed.harness, bed.agentId)).toEqual([
      'reorientation.opened',
      'reorientation.proposed',
    ]);
    const proposed = await bed.harness.run(
      async (ctx) =>
        (await ctx.db.query('events').collect()).find(
          (event) => event.type === 'reorientation.proposed',
        )?.payload,
    );
    expect(proposed).toEqual({
      reorientationId: bed.cardId,
      summary: 'Priya now approves committee-deck numbers',
      kind: 'charter-change',
      by: 'discussion',
    });
    expect(await talkOf(bed)).toMatchObject({
      state: 'finished',
      outcome: {
        proposed: card.proposed,
        quotes: ['send committee-deck drafts to Priya first, then to me'],
      },
    });
  });

  it('stands against a judgement in flight: the judgement’s later answer is not written', async (): Promise<void> => {
    const bed = await openedCard();
    const basis = await basisOf(bed.harness, bed.cardId);
    await opened(bed);
    await answered(bed, outcome());
    await expect(
      bed.harness.mutation(internal.reorientation.writeProposal, {
        reorientationId: bed.cardId,
        proposed: { kind: 'none', rationale: 'Nothing needs to change.' },
        basis,
      }),
    ).resolves.toEqual({ written: false });
    expect((await cardOf(bed.harness, bed.cardId)).proposed.kind).toBe('charter-change');
  });

  it('is put on the card by Put this on the card, keeping the reply it carries first', async (): Promise<void> => {
    const bed = await openedCard();
    await opened(bed);
    const turn = await taken(bed, {
      kind: 'finish',
      question: 'e0',
      replies: [{ id: 'm0', text: ANSWER }],
    });
    expect(turn.turns.map((kept) => kept.id)).toEqual(['e0', 'm0']);
    await expect(
      bed.owner.mutation(api.reorientationTalk.finish, {
        talkId: turn.talkId,
        conversation: turn.conversation,
        candidatesKey: turn.candidatesKey,
        after: 'm0',
        outcome: outcome(),
      }),
    ).resolves.toEqual({ ended: true });
    expect((await cardOf(bed.harness, bed.cardId)).status).toBe('open');
    expect((await talkOf(bed)).turns.map((kept) => kept.id)).toEqual(['e0', 'm0']);
  });

  it('refuses an outcome that names what the card does not hold, writing nothing', async (): Promise<void> => {
    const bed = await openedCard();
    await opened(bed);
    await expect(answered(bed, outcome(undefined, 9))).resolves.toEqual({
      kept: false,
      refusal: 'The proposal named something this card cannot change. Ask again.',
    });
    expect(await cardOf(bed.harness, bed.cardId)).toMatchObject({
      status: 'discussing',
      proposed: { kind: 'pending' },
    });
    expect((await talkOf(bed)).state).toBe('active');
  });

  it('refuses a relationship scope written as a sentence, in the room’s words, writing nothing (W16-R3)', async (): Promise<void> => {
    const bed = await openedCard();
    const personId = await seedPerson(bed.harness, 'Ines Duarte', { userId: OWNER_SUBJECT });
    const edgeId = await seedEdge(bed.harness, personId, {
      type: 'approval-authority',
      userId: OWNER_SUBJECT,
      scope: 'NetLedger journal changes and REVOPS close plans',
    });
    await bed.harness.run(async (ctx) => {
      const card = await ctx.db.get(bed.cardId);
      if (card === null) throw new Error('no card');
      await ctx.db.patch(bed.cardId, {
        evidence: { ...card.evidence, relationshipIds: [edgeId] },
      });
    });
    await opened(bed);
    // The seeded charter's three clauses come first, so the edge is the fourth item.
    const sentence = {
      reply: {
        change: 'relationship' as const,
        candidate: 4,
        action: 'edit',
        text: 'Ines Duarte approves NetLedger journal changes only; no longer approver for REVOPS close plans, which Aisha Bello now approves first.',
        rationale: 'You said Aisha Bello now approves REVOPS close plans.',
      },
      quotes: [],
    };
    await expect(answered(bed, sentence)).resolves.toEqual({
      kept: false,
      refusal:
        'The proposal put a sentence where a short phrase of what the relationship covers goes. Ask again.',
    });
    expect(await cardOf(bed.harness, bed.cardId)).toMatchObject({ proposed: { kind: 'pending' } });
    await expect(
      answered(bed, {
        ...sentence,
        reply: { ...sentence.reply, text: 'NetLedger journal changes' },
      }),
    ).resolves.toEqual({ kept: true, ended: true });
    expect((await cardOf(bed.harness, bed.cardId)).proposed).toMatchObject({
      kind: 'relationship',
      action: 'edit',
      scope: 'NetLedger journal changes',
    });
  });

  it('refuses an outcome drawn from candidates the card no longer offers', async (): Promise<void> => {
    const bed = await openedCard();
    await opened(bed);
    const turn = await taken(bed, {
      kind: 'reply',
      question: 'e0',
      replies: [{ id: 'm0', text: ANSWER }],
    });
    await expect(
      bed.owner.mutation(api.reorientationTalk.recordAnswer, {
        talkId: turn.talkId,
        conversation: turn.conversation,
        candidatesKey: '[]',
        answer: { answering: 'm0', id: 'e1', text: 'Done.' },
        outcome: outcome(),
      }),
    ).resolves.toEqual({
      kept: false,
      refusal: 'The card changed while you talked. Ask again.',
    });
  });

  it('refuses to end a talk the manager has said nothing in', async (): Promise<void> => {
    const bed = await openedCard();
    const turn = await opened(bed);
    await expect(
      bed.owner.mutation(api.reorientationTalk.finish, {
        talkId: turn.talkId,
        conversation: turn.conversation,
        candidatesKey: turn.candidatesKey,
        after: 'e0',
        outcome: outcome([]),
      }),
    ).resolves.toEqual({
      ended: false,
      refusal: 'Answer at least once before putting this on the card.',
    });
  });

  it('takes the talk up again from the card once it ended, the same talk at discussing', async (): Promise<void> => {
    const bed = await openedCard();
    await opened(bed);
    await answered(bed, outcome());
    await taken(bed, {
      kind: 'reply',
      question: 'e1',
      replies: [{ id: 'm1', text: 'Actually, copy me as well.' }],
    });
    expect((await cardOf(bed.harness, bed.cardId)).status).toBe('discussing');
    expect(await talkOf(bed)).toMatchObject({ state: 'active' });
  });
});

describe('the second pass’s findings (16-D)', (): void => {
  it('keeps a deferred card deferred through a talk, its date and all, the proposal replaced (M2)', async (): Promise<void> => {
    const bed = await openedCard();
    const { revisitAt } = await bed.owner.mutation(api.reorientationDecisions.defer, {
      reorientationId: bed.cardId,
    });
    await opened(bed);
    expect(await cardOf(bed.harness, bed.cardId)).toMatchObject({ status: 'deferred', revisitAt });
    await answered(bed, outcome());
    expect(await cardOf(bed.harness, bed.cardId)).toMatchObject({
      status: 'deferred',
      revisitAt,
      proposed: { kind: 'charter-change' },
    });
  });

  it('keeps a card deferred while its talk was under way deferred when the talk ends (M2)', async (): Promise<void> => {
    const bed = await openedCard();
    await opened(bed);
    expect((await cardOf(bed.harness, bed.cardId)).status).toBe('discussing');
    await bed.owner.mutation(api.reorientationDecisions.defer, { reorientationId: bed.cardId });
    await answered(bed, outcome());
    expect((await cardOf(bed.harness, bed.cardId)).status).toBe('deferred');
  });

  it('finishes from the kept turns when the reply a finish carries no longer fits, and says it was not kept (M3)', async (): Promise<void> => {
    const bed = await openedCard();
    await opened(bed);
    let question = 'e0';
    for (let index = 0; ; index += 1) {
      const turn = await take(bed, {
        kind: 'reply',
        question,
        replies: [{ id: `m${index}`, text: `Reply ${index}.` }],
      });
      if (!turn.taken) break;
      question = `e${index + 1}`;
      await bed.owner.mutation(api.reorientationTalk.recordAnswer, {
        talkId: turn.talkId,
        conversation: 0,
        candidatesKey: turn.candidatesKey,
        answer: { answering: turn.answering, id: question, text: `Answer ${index}.` },
      });
    }
    const finish = await take(bed, {
      kind: 'finish',
      question,
      replies: [{ id: 'm-late', text: 'One more.' }],
    });
    expect(finish).toMatchObject({ taken: true, unkept: 1 });
    expect((await talkOf(bed)).turns).toHaveLength(MAX_KEPT_TURNS - 1);
  });

  it('leaves a finished talk and its card as they are when Put this on the card is asked again (m4)', async (): Promise<void> => {
    const bed = await openedCard();
    await opened(bed);
    await answered(bed, outcome());
    await expect(take(bed, { kind: 'finish', question: 'e1', replies: [] })).resolves.toEqual({
      taken: false,
      refusal: 'This talk is already on the card. Reply to take it up again.',
    });
    expect((await cardOf(bed.harness, bed.cardId)).status).toBe('open');
    expect((await talkOf(bed)).state).toBe('finished');
  });

  it('takes a finished talk up again on a reply, setting its outcome aside (m4)', async (): Promise<void> => {
    const bed = await openedCard();
    await opened(bed);
    await answered(bed, outcome());
    await taken(bed, {
      kind: 'reply',
      question: 'e1',
      replies: [{ id: 'm1', text: 'Actually, copy me as well.' }],
    });
    const talk = await talkOf(bed);
    expect(talk.state).toBe('active');
    expect(talk.outcome).toBeUndefined();
    expect(talk.endedAt).toBeUndefined();
  });

  it('keeps a quote in a script without spaces between words, and the manager’s accents (m6)', async (): Promise<void> => {
    const bed = await openedCard();
    const turn = await taken(bed, { kind: 'open' });
    await bed.owner.mutation(api.reorientationTalk.recordAnswer, {
      talkId: turn.talkId,
      conversation: 0,
      candidatesKey: turn.candidatesKey,
      answer: { answering: null, id: 'e0', text: 'Who approves committee-deck numbers now?' },
    });
    const reply = await taken(bed, {
      kind: 'reply',
      question: 'e0',
      replies: [{ id: 'm0', text: '委员会的数字先给普丽娅审批。 Señora Priya décide.' }],
    });
    await bed.owner.mutation(api.reorientationTalk.recordAnswer, {
      talkId: reply.talkId,
      conversation: 0,
      candidatesKey: reply.candidatesKey,
      answer: { answering: 'm0', id: 'e1', text: 'Noted.' },
      outcome: outcome(['先给普丽娅审批', 'Señora Priya décide']),
    });
    expect((await talkOf(bed)).outcome?.quotes).toEqual(['先给普丽娅审批', 'Señora Priya décide']);
  });

  it('draws a decided card’s talk as closed, with no reply being typed (m8)', async (): Promise<void> => {
    const bed = await openedCard();
    const turn = await opened(bed);
    await bed.owner.mutation(api.reorientationTalk.keepReplyDraft, {
      talkId: turn.talkId,
      conversation: 0,
      text: 'Half a reply',
      after: null,
    });
    await bed.owner.mutation(api.reorientationDecisions.dismiss, { reorientationId: bed.cardId });
    const view = await bed.owner.query(api.reorientationTalk.forCard, {
      reorientationId: bed.cardId,
    });
    expect(view?.talk?.state).toBe('closed');
    expect(view?.talk?.replyDraft).toBeUndefined();
  });

  it('reads a card whose employee is gone as no card (m11)', async (): Promise<void> => {
    const bed = await openedCard();
    await bed.harness.run(async (ctx) => await ctx.db.delete(bed.agentId));
    await expect(
      bed.owner.query(api.reorientationTalk.forCard, { reorientationId: bed.cardId }),
    ).resolves.toBeNull();
  });
});

describe('it resumes from any point', (): void => {
  it('draws a reopened room from the kept turns, the reply typed and the answer still owed', async (): Promise<void> => {
    const bed = await openedCard();
    const turn = await opened(bed);
    await bed.owner.mutation(api.reorientationTalk.keepReplyDraft, {
      talkId: turn.talkId,
      conversation: 0,
      text: 'Yes, send committee',
      after: null,
    });
    expect(
      await bed.owner.query(api.reorientationTalk.forCard, { reorientationId: bed.cardId }),
    ).toMatchObject({
      summary: 'Priya now approves committee-deck numbers',
      status: 'discussing',
      talk: { state: 'active', replyDraft: 'Yes, send committee', turns: [{ id: 'e0' }] },
    });
    // The room closed after the reply was kept and before the answer: the reply stands.
    await taken(bed, { kind: 'reply', question: 'e0', replies: [{ id: 'm0', text: ANSWER }] });
    const reopened = await bed.owner.query(api.reorientationTalk.forCard, {
      reorientationId: bed.cardId,
    });
    expect(reopened?.talk?.turns.map((kept) => kept.id)).toEqual(['e0', 'm0']);
    expect(reopened?.talk?.replyDraft).toBeUndefined();
    // Asked again from the reopened room, the owed answer is kept on the same talk.
    const again = await taken(bed, {
      kind: 'ask-again',
      question: 'e0',
      replies: [{ id: 'm0', text: ANSWER }],
      discarding: null,
    });
    await expect(
      bed.owner.mutation(api.reorientationTalk.recordAnswer, {
        talkId: again.talkId,
        conversation: again.conversation,
        candidatesKey: again.candidatesKey,
        answer: { answering: again.answering, id: 'e1', text: 'And the rest to you?' },
      }),
    ).resolves.toEqual({ kept: true, ended: false });
    expect((await talkOf(bed)).turns.map((kept) => kept.id)).toEqual(['e0', 'm0', 'e1']);
  });

  it('refuses an answer to a reply the talk has moved past', async (): Promise<void> => {
    const bed = await openedCard();
    const turn = await opened(bed);
    await expect(
      bed.owner.mutation(api.reorientationTalk.recordAnswer, {
        talkId: turn.talkId,
        conversation: 0,
        candidatesKey: turn.candidatesKey,
        answer: { answering: 'm7', id: 'e1', text: 'Stale.' },
      }),
    ).resolves.toEqual({
      kept: false,
      refusal: 'The talk moved on in another window. Reload to carry on.',
    });
  });

  it('keeps no reply typed once a later reply was kept', async (): Promise<void> => {
    const bed = await openedCard();
    const turn = await opened(bed);
    await taken(bed, { kind: 'reply', question: 'e0', replies: [{ id: 'm0', text: ANSWER }] });
    await expect(
      bed.owner.mutation(api.reorientationTalk.keepReplyDraft, {
        talkId: turn.talkId,
        conversation: 0,
        text: 'Yes, send committee',
        after: null,
      }),
    ).resolves.toEqual({ kept: false });
  });

  it('is bounded at 40 turns, and can still be put on the card', async (): Promise<void> => {
    const bed = await openedCard();
    const first = await opened(bed);
    let question = 'e0';
    let refused: Awaited<ReturnType<typeof take>> | undefined;
    for (let index = 0; refused === undefined; index += 1) {
      const turn = await take(bed, {
        kind: 'reply',
        question,
        replies: [{ id: `m${index}`, text: `Reply ${index}.` }],
      });
      if (!turn.taken) {
        refused = turn;
        break;
      }
      question = `e${index + 1}`;
      await bed.owner.mutation(api.reorientationTalk.recordAnswer, {
        talkId: turn.talkId,
        conversation: 0,
        candidatesKey: turn.candidatesKey,
        answer: { answering: turn.answering, id: question, text: `Answer ${index}.` },
      });
    }
    // The reply that would leave no room for its answer is the one refused (the one-to-one's rule).
    expect(refused).toEqual({
      taken: false,
      refusal: 'The talk is as long as it can be. Put it on the card from what was said.',
    });
    expect((await talkOf(bed)).turns).toHaveLength(MAX_KEPT_TURNS - 1);
    const finish = await taken(bed, { kind: 'finish', question, replies: [] });
    await expect(
      bed.owner.mutation(api.reorientationTalk.finish, {
        talkId: first.talkId,
        conversation: 0,
        candidatesKey: finish.candidatesKey,
        after: question,
        outcome: outcome([]),
      }),
    ).resolves.toEqual({ ended: true });
  });
});

describe('an agent-quoted phrase never becomes evidence', (): void => {
  it('keeps the manager’s words and drops the employee’s own', async (): Promise<void> => {
    const bed = await openedCard();
    await opened(bed);
    await answered(
      bed,
      outcome([OPENING, 'send committee-deck drafts to Priya first, then to me']),
    );
    expect((await talkOf(bed)).outcome?.quotes).toEqual([
      'send committee-deck drafts to Priya first, then to me',
    ]);
  });
});

describe('the one-to-one’s session and its ten readers are untouched by a talk', (): void => {
  it('leaves the session row, the newest session and the one-to-one’s turns as they were', async (): Promise<void> => {
    const bed = await openedCard();
    const { sessionId } = await bed.owner.mutation(api.voice.start, {
      agentId: bed.agentId,
      mode: 'chat',
    });
    await bed.owner.mutation(api.oneToOne.takeTurn, {
      agentId: bed.agentId,
      request: { kind: 'open' },
    });
    const session = async (): Promise<unknown> =>
      await bed.harness.run(async (ctx) => await ctx.db.query('voiceSessions').collect());
    const before = await session();
    const latest = await bed.owner.query(api.voice.latest, { agentId: bed.agentId });
    await opened(bed);
    await answered(bed, outcome());
    expect(await session()).toEqual(before);
    expect(await bed.owner.query(api.voice.latest, { agentId: bed.agentId })).toEqual(latest);
    expect(latest?._id).toBe(sessionId);
    await expect(
      bed.owner.mutation(api.oneToOne.takeTurn, {
        agentId: bed.agentId,
        request: { kind: 'open' },
      }),
    ).resolves.toMatchObject({ sessionId, turns: [] });
  });

  it('opens no session of its own for an employee that has none', async (): Promise<void> => {
    const bed = await openedCard();
    await opened(bed);
    await answered(bed, outcome());
    expect(
      await bed.harness.run(async (ctx) => await ctx.db.query('voiceSessions').collect()),
    ).toEqual([]);
    expect(await bed.owner.query(api.voice.latest, { agentId: bed.agentId })).toBeNull();
  });
});

describe('the room’s read of a card', (): void => {
  it('is null for an id that names no card, and the card with no talk before one opens', async (): Promise<void> => {
    const bed = await openedCard();
    await expect(
      bed.owner.query(api.reorientationTalk.forCard, { reorientationId: 'not-a-card' }),
    ).resolves.toBeNull();
    await expect(
      bed.owner.query(api.reorientationTalk.forCard, { reorientationId: bed.cardId }),
    ).resolves.toMatchObject({ agentId: bed.agentId, status: 'open', talk: null });
  });
});
