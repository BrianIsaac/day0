/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { managerIdentity } from '../../../../convex/fakes/manager-identity';

/*
 * Discuss's acceptance, end to end (16-D; the wave file's 6 "16-D"): the talk's route against
 * the real store (`convex/reorientationTalk.ts` under convex-test, as the card's owner), only the
 * model provider stood in for. The conversation ends in a proposal on the card and applies
 * nothing; it resumes from any point; an agent-quoted phrase never becomes evidence; the
 * one-to-one's session and its readers are untouched; and the event it writes is said by both
 * renderers.
 */

vi.mock('../../../../../src/lib/dev-auth-server', () => ({
  establishCaller: async () => ({ ok: true, userId: 'dev-no-auth-subject' }),
}));
vi.mock('@clerk/nextjs/server', () => ({
  auth: async (): Promise<{ getToken: () => Promise<string> }> => ({
    getToken: async (): Promise<string> => 'convex-token',
  }),
}));

/** The store the route's Convex client reaches: the harness, as the card's owner. */
const seam = vi.hoisted(() => ({
  owner: undefined as
    | undefined
    | {
        mutation: (reference: unknown, args: unknown) => Promise<unknown>;
        query: (reference: unknown, args: unknown) => Promise<unknown>;
      },
}));

vi.mock('convex/browser', () => ({
  ConvexHttpClient: class {
    setAuth(): void {}
    async mutation(reference: unknown, args: unknown): Promise<unknown> {
      return await seam.owner!.mutation(reference, args);
    }
    async query(reference: unknown, args: unknown): Promise<unknown> {
      return await seam.owner!.query(reference, args);
    }
  },
}));

import { api } from '../../../../../convex/_generated/api';
import type { Doc, Id } from '../../../../../convex/_generated/dataModel';
import schema from '../../../../../convex/schema';
import { eventLabel } from '../../../../../app/agent/[agentId]/event-labels';
import { recordWords } from '../../../../../app/agent/[agentId]/record/record-words';
import { allConvexModules } from '../../../../convex/all-modules';
import { seedEmployee } from '../../../../convex/fakes/reorientation';

type Harness = TestConvex<typeof schema>;

const OWNER = managerIdentity();
const GLM = 'zai-org/GLM-5.3-Flash';

/** The handover's case: what the employee asks, and what the manager answers. */
const OPENING =
  'Priya now approves committee-deck numbers. Should tier-2 drafts about them go to her first?';
const ANSWER = 'Yes, send committee-deck drafts to Priya first, then to me.';

/** The provider's answers, in order, and what it was sent. */
let replies: (() => Response)[] = [];
let sent: Record<string, unknown>[] = [];

function completionStream(deltas: [Record<string, unknown>, string | null][]): Response {
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-talk',
      object: 'chat.completion.chunk',
      created: 1,
      model: GLM,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return new Response(deltas.map(([d, f]) => chunk(d, f)).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function said(text: string): Response {
  return completionStream([
    [{ role: 'assistant', content: text }, null],
    [{}, 'stop'],
  ]);
}

/** A turn that says `text` and puts the Escalates clause's rewrite on the card, quoting `quotes`. */
function completing(text: string, quotes: string[]): Response {
  const outcome = {
    change: 'edit-clause',
    candidate: 3,
    action: null,
    text: 'Surface tier-2 drafts about committee-deck numbers to Priya first, then to the manager',
    rationale: 'You said committee-deck drafts go to Priya first now.',
    quotes,
    closingLine: 'I will put that on the card.',
  };
  return completionStream([
    [{ role: 'assistant', content: text }, null],
    [
      {
        tool_calls: [
          {
            index: 0,
            id: 'call_complete',
            type: 'function',
            function: { name: 'reorientationComplete', arguments: JSON.stringify(outcome) },
          },
        ],
      },
      null,
    ],
    [{}, 'tool_calls'],
  ]);
}

/**
 * A bed: the employee, its card opened by hand, and the route loaded on the stubbed provider.
 *
 * `signal` is the test's own: a test that timed out (the route's first import, under load) stops
 * at its next step, where it went on in the background into the next test's provider answers and
 * failed that test too (18-G).
 */
async function bed(signal: AbortSignal): Promise<{
  harness: Harness;
  agentId: Id<'agents'>;
  cardId: Id<'reorientations'>;
  POST: (req: Request) => Promise<Response>;
}> {
  const harness = convexTest(schema, allConvexModules());
  const agentId = await seedEmployee(harness);
  const owner = harness.withIdentity(OWNER);
  seam.owner = owner as never;
  // The card's own judgement is scheduled on a fake clock that never moves: the talk is the subject.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const { reorientationId } = await owner.mutation(api.reorientationDecisions.openByHand, {
    agentId,
    summary: 'Priya now approves committee-deck numbers',
  });
  vi.useRealTimers();
  if (reorientationId === null) throw new Error('no card opened');
  vi.resetModules();
  sent = [];
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://day0.convex.invalid');
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.stubEnv('OPENAI_BASE_URL', 'https://api.featherless.ai/v1');
  vi.stubEnv('OPENAI_MODEL', GLM);
  vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', '');
  vi.stubEnv('OPENAI_REASONING_EFFORT', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const reply = replies.shift();
      if (reply === undefined) throw new Error('the provider was asked once too often');
      return reply();
    }),
  );
  const { POST } = await import('../../../../../app/api/reorientation/chat/route');
  signal.throwIfAborted();
  return {
    harness,
    agentId,
    cardId: reorientationId,
    POST: async (req: Request): Promise<Response> => {
      signal.throwIfAborted();
      return await POST(req);
    },
  };
}

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  replies = [];
  seam.owner = undefined;
});

/** Post one turn of the card's talk, as the room does, and read the whole answer. */
async function turn(
  POST: (req: Request) => Promise<Response>,
  cardId: Id<'reorientations'>,
  request: Record<string, unknown>,
): Promise<Response> {
  const response = await POST(
    new Request('http://127.0.0.1:3000/api/reorientation/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reorientationId: cardId, request }),
    }),
  );
  await response.clone().text();
  return response;
}

/** The card's one talk as stored. */
async function talkOf(
  harness: Harness,
  cardId: Id<'reorientations'>,
): Promise<Doc<'reorientationTalks'>> {
  const talk = await harness.run(
    async (ctx) =>
      await ctx.db
        .query('reorientationTalks')
        .withIndex('by_reorientation', (q) => q.eq('reorientationId', cardId))
        .first(),
  );
  if (talk === null) throw new Error('no talk');
  return talk;
}

/** Open the talk and reply once, the employee's answer ending it in `quotes`. */
async function talkedThrough(
  signal: AbortSignal,
  quotes: string[] = ['send committee-deck drafts to Priya first, then to me'],
): Promise<Awaited<ReturnType<typeof bed>>> {
  const opened = await bed(signal);
  replies = [() => said(OPENING), () => completing('Noted.', quotes)];
  expect((await turn(opened.POST, opened.cardId, { kind: 'open' })).status).toBe(200);
  const first = (await talkOf(opened.harness, opened.cardId)).turns[0];
  expect(
    (
      await turn(opened.POST, opened.cardId, {
        kind: 'reply',
        question: first.id,
        replies: [{ id: 'm0', text: ANSWER }],
      })
    ).status,
  ).toBe(200);
  return opened;
}

describe('the conversation ends in a proposal on the card and applies nothing (through the route)', (): void => {
  it('puts the discussion’s proposal on the card, back at open, and changes no charter', async ({
    signal,
  }): Promise<void> => {
    const { harness, agentId, cardId } = await talkedThrough(signal);
    const card = await harness.run(async (ctx) => await ctx.db.get(cardId));
    expect(card).toMatchObject({
      status: 'open',
      proposed: {
        kind: 'charter-change',
        before: 'Surface tier-2 answer drafts to the manager for review',
        after:
          'Surface tier-2 drafts about committee-deck numbers to Priya first, then to the manager',
      },
    });
    const charters = await harness.run(async (ctx) => await ctx.db.query('charters').collect());
    expect(charters.map((charter) => charter.version)).toEqual(['0.1']);
    expect((await talkOf(harness, cardId)).state).toBe('finished');
    const events = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).filter((event) => event.agentId === agentId),
    );
    expect(events.map((event) => event.type)).toEqual([
      'reorientation.opened',
      'reorientation.proposed',
    ]);
  });

  it('writes reorientation.proposed by the discussion, which both renderers say as the talk’s', async ({
    signal,
  }): Promise<void> => {
    const { harness, agentId } = await talkedThrough(signal);
    const proposed = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).find(
        (event) => event.agentId === agentId && event.type === 'reorientation.proposed',
      ),
    );
    expect(proposed?.payload).toMatchObject({ kind: 'charter-change', by: 'discussion' });
    expect(eventLabel(proposed!)).toBe('reorientation card proposes a change after the discussion');
    expect(recordWords(proposed!, { name: 'Mira' })).toBe(
      'Mira proposed a change on the reorientation card after talking it through with you: Priya now approves committee-deck numbers.',
    );
  });
});

describe('an agent-quoted phrase never becomes evidence (through the route)', (): void => {
  it('keeps only the manager’s words of the quotes the employee offered', async ({
    signal,
  }): Promise<void> => {
    const { harness, cardId } = await talkedThrough(signal, [
      OPENING,
      'should tier-2 drafts about them go to her first',
      'send committee-deck drafts to Priya first, then to me',
    ]);
    expect((await talkOf(harness, cardId)).outcome?.quotes).toEqual([
      'send committee-deck drafts to Priya first, then to me',
    ]);
  });
});

describe('it resumes from any point (through the route)', (): void => {
  it('answers a reply kept before the room closed, when the reopened room asks again', async ({
    signal,
  }): Promise<void> => {
    const { harness, cardId, POST } = await bed(signal);
    replies = [() => said(OPENING)];
    await turn(POST, cardId, { kind: 'open' });
    const first = (await talkOf(harness, cardId)).turns[0];
    // The reply reached the talk and the room closed before the answer came back.
    replies = [
      () => {
        throw new TypeError('the room closed');
      },
    ];
    await turn(POST, cardId, {
      kind: 'reply',
      question: first.id,
      replies: [{ id: 'm0', text: ANSWER }],
    });
    expect((await talkOf(harness, cardId)).turns.map((kept) => kept.speaker)).toEqual([
      'employee',
      'manager',
    ]);
    replies = [() => said('And everything else still comes to you?')];
    const again = await turn(POST, cardId, {
      kind: 'ask-again',
      question: first.id,
      replies: [{ id: 'm0', text: ANSWER }],
      discarding: null,
    });
    expect(again.status).toBe(200);
    expect((await talkOf(harness, cardId)).turns.map((kept) => kept.text)).toEqual([
      OPENING,
      ANSWER,
      'And everything else still comes to you?',
    ]);
  });

  it('puts a talk on the card at the manager’s word from wherever it stands', async ({
    signal,
  }): Promise<void> => {
    const { harness, cardId, POST } = await bed(signal);
    replies = [() => said(OPENING)];
    await turn(POST, cardId, { kind: 'open' });
    const first = (await talkOf(harness, cardId)).turns[0];
    replies = [
      () =>
        Response.json({
          id: 'chatcmpl-talk',
          object: 'chat.completion',
          created: 1,
          model: GLM,
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_complete',
                    type: 'function',
                    function: {
                      name: 'reorientationComplete',
                      arguments: JSON.stringify({
                        change: 'none',
                        candidate: null,
                        action: null,
                        text: null,
                        rationale: 'You said nothing needs to change.',
                        quotes: ['Leave it as it is.'],
                        closingLine: 'Nothing changes.',
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
    ];
    const finished = await turn(POST, cardId, {
      kind: 'finish',
      question: first.id,
      replies: [{ id: 'm0', text: 'Leave it as it is.' }],
    });
    await expect(finished.json()).resolves.toEqual({ ended: true });
    expect(await harness.run(async (ctx) => await ctx.db.get(cardId))).toMatchObject({
      status: 'open',
      proposed: { kind: 'none', rationale: 'You said nothing needs to change.' },
    });
    expect((await talkOf(harness, cardId)).outcome?.quotes).toEqual(['Leave it as it is.']);
  });
});

describe('the one-to-one’s session and its readers are untouched by a talk (through the route)', (): void => {
  it('leaves the employee’s one-to-one where it stood, every reader of it answering as before', async ({
    signal,
  }): Promise<void> => {
    const { harness, agentId, cardId, POST } = await bed(signal);
    const owner = harness.withIdentity(OWNER);
    await owner.mutation(api.voice.start, { agentId, mode: 'chat' });
    await owner.mutation(api.oneToOne.takeTurn, { agentId, request: { kind: 'open' } });
    // The session's rows, the newest session (the shell's, the room's and day zero's reader), every
    // session, the reset's count of them, and the one-to-one's own turn: each as it was.
    const readers = async (): Promise<unknown> => ({
      rows: await harness.run(async (ctx) => await ctx.db.query('voiceSessions').collect()),
      latest: await owner.query(api.voice.latest, { agentId }),
      list: await owner.query(api.voice.list, { agentId }),
      resetCount: (await owner.query(api.reset.retirePreview, { agentId }))?.rowCounts
        .voiceSessions,
    });
    const before = await readers();
    replies = [() => said(OPENING), () => completing('Noted.', [ANSWER])];
    await turn(POST, cardId, { kind: 'open' });
    const first = (await talkOf(harness, cardId)).turns[0];
    await turn(POST, cardId, {
      kind: 'reply',
      question: first.id,
      replies: [{ id: 'm0', text: ANSWER }],
    });
    expect((await talkOf(harness, cardId)).state).toBe('finished');
    expect(await readers()).toEqual(before);
    await expect(
      owner.mutation(api.oneToOne.takeTurn, { agentId, request: { kind: 'open' } }),
    ).resolves.toMatchObject({ turns: [] });
  });
});
