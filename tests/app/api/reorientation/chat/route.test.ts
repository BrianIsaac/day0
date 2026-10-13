import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OneToOneTurn } from '../../../../../src/agent/one-to-one-conversation';
import { TALK_FINISH_NOTE } from '../../../../../src/agent/reorientation-talk-prompts';

vi.mock('../../../../../src/lib/dev-auth-server', () => ({
  establishCaller: async () => ({ ok: true, userId: 'dev-no-auth-subject' }),
}));
vi.mock('@clerk/nextjs/server', () => ({
  auth: async (): Promise<{ getToken: () => Promise<string> }> => ({
    getToken: async (): Promise<string> => 'convex-token',
  }),
}));

/*
 * The Discuss talk's route (16-D; the wave file's 5.3): one turn of the talk on the owner's key,
 * from the turns the card's talk keeps (`reorientationTalk.takeTurn`), the answer kept before the
 * room hears it finished (`reorientationTalk.recordAnswer`), and Put this on the card asking the
 * employee for the outcome by the `reorientationComplete` tool (`reorientationTalk.finish`).
 */

/** The talk the route keeps turns on, behind the Convex transport, decided by the talk's own rules. */
const talk = vi.hoisted(() => ({
  turns: [] as OneToOneTurn[],
  /** A refusal `takeTurn` answers with, when set. */
  refusal: undefined as string | undefined,
  /** What `recordAnswer` or `finish` answers instead of writing, when set. */
  keepRefusal: undefined as string | undefined,
  outcome: undefined as unknown,
  /** Whether `finish` throws as a store that could not be reached does. */
  finishThrows: false,
  /** The replies a finish's `takeTurn` says it could not keep. */
  unkept: 0,
  calls: [] as { name: string; args: Record<string, unknown> }[],
}));

vi.mock('convex/browser', async () => {
  const { getFunctionName } = await import('convex/server');
  const { decideAnswer } = await import('../../../../../src/agent/one-to-one-conversation');
  const { decideTalkTurn } = await import('../../../../../src/agent/reorientation-talk');
  return {
    ConvexHttpClient: class {
      setAuth(): void {}
      async mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown> {
        const name = getFunctionName(reference as never);
        talk.calls.push({ name, args });
        if (name === 'reorientationTalk:takeTurn') {
          if (talk.refusal) return { taken: false, refusal: talk.refusal };
          const decision = decideTalkTurn(talk.turns, args.request as never, 1);
          if (!decision.ok) return { taken: false, refusal: decision.refusal };
          talk.turns = [...decision.turns];
          return {
            taken: true,
            talkId: 'talk-1',
            conversation: 0,
            turns: talk.turns,
            answering: decision.answering,
            candidatesKey: 'key-1',
            employeeName: 'Mira',
            system: 'THE TALK SYSTEM PROMPT',
            unkept: talk.unkept,
          };
        }
        if (name === 'reorientationTalk:recordAnswer') {
          if (talk.keepRefusal) return { kept: false, refusal: talk.keepRefusal };
          const answer = args.answer as { answering: string | null; id: string; text: string };
          const decision = decideAnswer(talk.turns, { ...answer, topicIndex: -1 }, 2);
          if (!decision.ok) return { kept: false, refusal: decision.refusal };
          talk.turns = [...decision.turns];
          talk.outcome = args.outcome;
          return { kept: true, ended: args.outcome !== undefined };
        }
        if (name === 'reorientationTalk:finish') {
          if (talk.finishThrows) throw new Error('fetch failed');
          if (talk.keepRefusal) return { ended: false, refusal: talk.keepRefusal };
          talk.outcome = args.outcome;
          return { ended: true };
        }
        throw new Error(`unexpected mutation ${name}`);
      }
      async query(reference: unknown): Promise<unknown> {
        throw new Error(`unexpected query ${getFunctionName(reference as never)}`);
      }
    },
  };
});

beforeEach((): void => {
  talk.turns = [];
  talk.refusal = undefined;
  talk.keepRefusal = undefined;
  talk.outcome = undefined;
  talk.finishThrows = false;
  talk.unkept = 0;
  talk.calls = [];
});

const FEATHERLESS = 'https://api.featherless.ai/v1';
const GLM = 'zai-org/GLM-5.3-Flash';

/** Request bodies the model provider put on the wire, newest last. */
let sent: Record<string, unknown>[] = [];

type Delta = Record<string, unknown>;

/** One streamed chat completion, built from the deltas the provider would send. */
function completionStream(deltas: [Delta, string | null][]): Response {
  const chunk = (delta: Delta, finish: string | null): string =>
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

/** A turn that says `text`. */
function textCompletion(text: string): Response {
  return completionStream([
    [{ role: 'assistant', content: text }, null],
    [{}, 'stop'],
  ]);
}

/** The outcome the handover's case ends in. */
const OUTCOME = {
  change: 'edit-clause',
  candidate: 2,
  action: null,
  text: 'Surface tier-2 drafts about committee-deck numbers to Priya first, then to the manager',
  rationale: 'Priya approves committee-deck numbers now.',
  quotes: ['send committee-deck drafts to Priya first, then to me'],
  closingLine: 'I will put that on the card.',
};

/** A streamed turn that says `text` and calls `reorientationComplete`. */
function completingStream(text: string): Response {
  return completionStream([
    [{ role: 'assistant', content: text }, null],
    [
      {
        tool_calls: [
          {
            index: 0,
            id: 'call_complete',
            type: 'function',
            function: { name: 'reorientationComplete', arguments: JSON.stringify(OUTCOME) },
          },
        ],
      },
      null,
    ],
    [{}, 'tool_calls'],
  ]);
}

/** A whole (unstreamed) chat completion that calls `reorientationComplete`, or says only words. */
function generated(called: boolean): Response {
  return Response.json({
    id: 'chatcmpl-talk',
    object: 'chat.completion',
    created: 1,
    model: GLM,
    choices: [
      {
        index: 0,
        finish_reason: called ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: called ? null : 'Shall I put that on the card?',
          ...(called
            ? {
                tool_calls: [
                  {
                    id: 'call_complete',
                    type: 'function',
                    function: { name: 'reorientationComplete', arguments: JSON.stringify(OUTCOME) },
                  },
                ],
              }
            : {}),
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/** Load the talk's route against a stubbed provider answering `replies` in order. */
async function loadRoute(
  replies: (() => Response)[],
): Promise<(req: Request) => Promise<Response>> {
  vi.resetModules();
  sent = [];
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://day0.convex.invalid');
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.stubEnv('OPENAI_BASE_URL', FEATHERLESS);
  vi.stubEnv('OPENAI_MODEL', GLM);
  vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', '');
  vi.stubEnv('OPENAI_REASONING_EFFORT', '');
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      // As the platform's fetch does: a call whose signal has fired never reaches the provider.
      init?.signal?.throwIfAborted();
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const reply = replies[Math.min(call, replies.length - 1)];
      call += 1;
      return reply();
    }),
  );
  const { POST } = await import('../../../../../app/api/reorientation/chat/route');
  return POST;
}

/** The chunks of a UI message stream body, in order. */
function chunksOf(body: string): { type: string; [key: string]: unknown }[] {
  return body
    .split('\n\n')
    .map((line) => line.replace(/^data: /, ''))
    .filter((line) => line && line !== '[DONE]')
    .map((line) => JSON.parse(line) as { type: string });
}

/** The id the route draws and keeps the next employee turn under. */
const TURN_ID = '00000000-0000-4000-8000-000000000001';

function talkRequest(body: unknown, origin?: string): Request {
  return new Request('http://127.0.0.1:3000/api/reorientation/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

/** The talk after the opening, its first question asked. */
function afterOpening(): void {
  talk.turns = [
    {
      id: 'e0',
      speaker: 'employee',
      text: 'Priya now approves committee-deck numbers. Should those drafts go to her first?',
      at: 1,
    },
  ];
}

const REPLY = {
  reorientationId: 'card-1',
  request: {
    kind: 'reply',
    question: 'e0',
    replies: [{ id: 'm0', text: 'Yes, send committee-deck drafts to Priya first, then to me.' }],
  },
};

beforeEach((): void => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(TURN_ID);
});

afterEach((): void => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the talk’s route: a turn', (): void => {
  it('opens the talk from the card’s own prompt, keeps the answer and offers no tool yet', async (): Promise<void> => {
    const POST = await loadRoute([() => textCompletion('Should those drafts go to Priya first?')]);
    const response = await POST(
      talkRequest({ reorientationId: 'card-1', request: { kind: 'open' } }),
    );
    const chunks = chunksOf(await response.text());
    expect(response.status).toBe(200);
    expect(sent[0]).toMatchObject({
      model: GLM,
      stream: true,
      prompt_cache_key: 'day0-reorientation-talk-v2',
      messages: [{ role: 'system', content: 'THE TALK SYSTEM PROMPT' }, { role: 'user' }],
    });
    expect(sent[0]).not.toHaveProperty('tools');
    expect(talk.calls.map((call) => call.name)).toEqual([
      'reorientationTalk:takeTurn',
      'reorientationTalk:recordAnswer',
    ]);
    expect(talk.turns).toEqual([
      { id: TURN_ID, speaker: 'employee', text: 'Should those drafts go to Priya first?', at: 2 },
    ]);
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', messageMetadata: { kept: true } });
  });

  it('answers a reply with the reorientationComplete tool offered, and keeps the outcome it calls', async (): Promise<void> => {
    afterOpening();
    const POST = await loadRoute([() => completingStream('Noted.')]);
    const response = await POST(talkRequest(REPLY));
    await response.text();
    expect(response.status).toBe(200);
    expect(sent[0]).toMatchObject({
      tools: [{ type: 'function', function: { name: 'reorientationComplete' } }],
    });
    const recorded = talk.calls.find((call) => call.name === 'reorientationTalk:recordAnswer');
    expect(recorded?.args).toMatchObject({
      talkId: 'talk-1',
      conversation: 0,
      candidatesKey: 'key-1',
      answer: { answering: 'm0', id: TURN_ID, text: 'Noted.' },
      outcome: {
        reply: {
          change: 'edit-clause',
          candidate: 2,
          action: null,
          text: OUTCOME.text,
          rationale: OUTCOME.rationale,
        },
        quotes: OUTCOME.quotes,
      },
    });
  });

  it('says the talk’s refusal to a turn as a 409 the room reads', async (): Promise<void> => {
    talk.refusal = 'The card was decided, so the talk about it is closed.';
    const POST = await loadRoute([() => textCompletion('unused')]);
    const response = await POST(
      talkRequest({ reorientationId: 'card-1', request: { kind: 'open' } }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'The card was decided, so the talk about it is closed.',
    });
    expect(sent).toEqual([]);
  });

  it('says a refused outcome as an error before the finish, so the room asks again', async (): Promise<void> => {
    afterOpening();
    talk.keepRefusal = 'The proposal named something this card cannot change. Ask again.';
    const POST = await loadRoute([() => completingStream('Noted.')]);
    const chunks = chunksOf(await (await POST(talkRequest(REPLY))).text());
    expect(chunks.at(-2)).toEqual({
      type: 'error',
      errorText: 'The proposal named something this card cannot change. Ask again.',
    });
  });

  it('refuses a body that is not a talk turn, and one from another origin', async (): Promise<void> => {
    const POST = await loadRoute([() => textCompletion('unused')]);
    expect((await POST(talkRequest({ reorientationId: 'card-1' }))).status).toBe(400);
    expect(
      (
        await POST(
          talkRequest(
            { reorientationId: 'card-1', request: { kind: 'open' } },
            'http://evil.example.test',
          ),
        )
      ).status,
    ).toBe(403);
    expect(talk.calls).toEqual([]);
  });
});

describe('the talk’s route: Put this on the card', (): void => {
  it('asks the employee for the outcome by the tool, and ends the talk in it', async (): Promise<void> => {
    afterOpening();
    const POST = await loadRoute([() => generated(true)]);
    const response = await POST(
      talkRequest({ ...REPLY, request: { ...REPLY.request, kind: 'finish' } }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ended: true });
    expect(sent[0]).toMatchObject({
      tool_choice: 'required',
      tools: [{ type: 'function', function: { name: 'reorientationComplete' } }],
    });
    expect((sent[0].messages as { role: string; content: unknown }[]).at(-1)).toEqual({
      role: 'system',
      content: TALK_FINISH_NOTE,
    });
    const finished = talk.calls.find((call) => call.name === 'reorientationTalk:finish');
    expect(finished?.args).toMatchObject({
      talkId: 'talk-1',
      conversation: 0,
      candidatesKey: 'key-1',
      after: 'm0',
      outcome: { quotes: OUTCOME.quotes, reply: { change: 'edit-clause', candidate: 2 } },
    });
  });

  it('puts the talk on the card even when the room has gone before the answer (the walk’s W-1)', async (): Promise<void> => {
    afterOpening();
    const POST = await loadRoute([() => generated(true)]);
    const left = new AbortController();
    const request = new Request('http://127.0.0.1:3000/api/reorientation/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...REPLY, request: { ...REPLY.request, kind: 'finish' } }),
      signal: left.signal,
    });
    // The manager pressed Put this on the card, then Back to the card: the page's request is gone.
    left.abort();
    await POST(request);
    expect(talk.calls.map((call) => call.name)).toEqual([
      'reorientationTalk:takeTurn',
      'reorientationTalk:finish',
    ]);
  });

  it('says so when the employee put nothing on the card', async (): Promise<void> => {
    afterOpening();
    const POST = await loadRoute([() => generated(false)]);
    const response = await POST(
      talkRequest({ ...REPLY, request: { ...REPLY.request, kind: 'finish' } }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Mira put nothing on the card. Try again.',
    });
    expect(talk.calls.map((call) => call.name)).toEqual(['reorientationTalk:takeTurn']);
  });

  it('asks once more, naming the refused field, when the first call is not in the tool’s shape, and puts the second on the card (17-O)', async (): Promise<void> => {
    // The pre-tag's row 6 (`row6-talk.log`): "nothing was put on the card", `refusedFields`
    // ["closingLine"], three finishes in four on the hosted model.
    afterOpening();
    const { closingLine: _closingLine, ...noClosingLine } = OUTCOME;
    void _closingLine;
    const refusedOnce = (): Response =>
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
                    arguments: JSON.stringify(noClosingLine),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    const POST = await loadRoute([refusedOnce, () => generated(true)]);
    const response = await POST(
      talkRequest({ ...REPLY, request: { ...REPLY.request, kind: 'finish' } }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ended: true });
    expect(talk.calls.map((call) => call.name)).toEqual([
      'reorientationTalk:takeTurn',
      'reorientationTalk:finish',
    ]);
    // Two asks: the second carries the route's repair note after its finish note, and names the
    // field's path, never what the model wrote in it.
    expect(sent).toHaveLength(2);
    const systemNotes = (request: Record<string, unknown>): string[] =>
      (request.messages as Array<{ role: string; content: unknown }>)
        .filter((message) => message.role === 'system')
        .map((message) => String(message.content));
    expect(systemNotes(sent[0]).some((note) => note.includes('was not taken'))).toBe(false);
    expect(systemNotes(sent[1]).at(-1)).toBe(
      'Your call of reorientationComplete was not taken: closingLine was not in the shape the tool takes. Call reorientationComplete once more, every field as the tool describes it. Say nothing else.',
    );
  });

  it('logs why nothing was put on the card: the finish, the calls, the refused fields, the text and the usage (W16-R19, W1b)', async (): Promise<void> => {
    const lines: Array<Record<string, unknown>> = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown): void => {
      lines.push(JSON.parse(String(line)) as Record<string, unknown>);
    });
    try {
      afterOpening();
      const nothing = await loadRoute([() => generated(false)]);
      await nothing(talkRequest({ ...REPLY, request: { ...REPLY.request, kind: 'finish' } }));
      const { rationale: _rationale, ...noRationale } = OUTCOME;
      void _rationale;
      const refused = await loadRoute([
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
                        arguments: JSON.stringify(noRationale),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
      ]);
      await refused(talkRequest({ ...REPLY, request: { ...REPLY.request, kind: 'finish' } }));
    } finally {
      spy.mockRestore();
    }
    const said = lines.filter(
      (line) => line.msg === 'reorientation talk: nothing was put on the card',
    );
    // Re-taken (17-O): a finish that carried no outcome is asked once more, so each of the two
    // finishes here is two asks, and the log says which ask each line is of.
    const nothingSaid = {
      level: 'warn',
      finishReason: 'stop',
      toolCalls: [],
      textLength: 'Shall I put that on the card?'.length,
      usage: expect.objectContaining({ inputTokens: 1, outputTokens: 1 }) as unknown,
    };
    const refusedCall = {
      finishReason: 'tool-calls',
      toolCalls: ['reorientationComplete'],
      refusedFields: ['rationale'],
      textLength: 0,
    };
    expect(said).toEqual([
      expect.objectContaining({ ...nothingSaid, ask: 1, repaired: false }),
      expect.objectContaining({ ...nothingSaid, ask: 2, repaired: false }),
      expect.objectContaining({ ...refusedCall, ask: 1, repaired: false }),
      expect.objectContaining({ ...refusedCall, ask: 2, repaired: false }),
    ]);
    // Only the fields' paths are logged, never what the model wrote in them.
    expect(JSON.stringify(said)).not.toContain('committee-deck');
  });

  it('says a store that could not be reached as a 503, not a bare failure (the second pass’s m5)', async (): Promise<void> => {
    afterOpening();
    talk.finishThrows = true;
    const POST = await loadRoute([() => generated(true)]);
    const response = await POST(
      talkRequest({ ...REPLY, request: { ...REPLY.request, kind: 'finish' } }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Day0 could not put this on the card. Nothing you said is lost.',
    });
  });

  it('says how many replies a finish could not keep', async (): Promise<void> => {
    afterOpening();
    talk.unkept = 1;
    const POST = await loadRoute([() => generated(true)]);
    const response = await POST(
      talkRequest({ ...REPLY, request: { ...REPLY.request, kind: 'finish' } }),
    );
    await expect(response.json()).resolves.toEqual({ ended: true, unkept: 1 });
  });

  it('says the talk’s refusal of the outcome', async (): Promise<void> => {
    afterOpening();
    talk.keepRefusal = 'The card changed while you talked. Ask again.';
    const POST = await loadRoute([() => generated(true)]);
    const response = await POST(
      talkRequest({ ...REPLY, request: { ...REPLY.request, kind: 'finish' } }),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'The card changed while you talked. Ask again.',
    });
  });
});
