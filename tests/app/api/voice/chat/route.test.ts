import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OneToOneTurn } from '../../../../../src/agent/one-to-one-conversation';
import { dayOneTurnNote } from '../../../../../src/agent/day-one-system-prompt';

vi.mock('../../../../../src/lib/dev-auth-server', () => ({
  establishCaller: async () => ({ ok: true, userId: 'dev-no-auth-subject' }),
}));
vi.mock('@clerk/nextjs/server', () => ({
  auth: async (): Promise<{ getToken: () => Promise<string> }> => ({
    getToken: async (): Promise<string> => 'convex-token',
  }),
}));

/**
 * The session the route keeps the one-to-one on, behind the Convex transport: the turns it holds
 * and the decisions it makes, which are the session's own (`decideTurn`, `decideAnswer`).
 */
const session = vi.hoisted(() => ({
  turns: [] as OneToOneTurn[],
  /** Whether the last answer kept closed the one-to-one. */
  closed: false,
  /** A refusal `takeTurn` throws as the session's `ConvexError`, when set. */
  refusal: undefined as string | undefined,
  /** What `recordAnswer` answers instead of keeping, when set. */
  keepRefusal: undefined as string | undefined,
  /** What `recordAnswer` throws instead of answering, when set. */
  keepThrows: undefined as Error | undefined,
  /** The employee's row as `agents.get` answers it; null once it is gone. */
  employee: { name: 'Ada' } as { name: string } | null,
  calls: [] as { name: string; args: Record<string, unknown> }[],
}));

vi.mock('convex/browser', async () => {
  const { getFunctionName } = await import('convex/server');
  const { ConvexError } = await import('convex/values');
  const { decideAnswer, decideTurn } =
    await import('../../../../../src/agent/one-to-one-conversation');
  return {
    ConvexHttpClient: class {
      setAuth(): void {}
      async mutation(reference: unknown, args: Record<string, unknown>): Promise<unknown> {
        const name = getFunctionName(reference as never);
        session.calls.push({ name, args });
        if (name === 'oneToOne:takeTurn') {
          if (session.refusal) throw new ConvexError(session.refusal);
          const decision = decideTurn(session.turns, args.request as never, 1);
          if (!decision.ok) throw new ConvexError(decision.refusal);
          session.turns = [...decision.turns];
          return {
            sessionId: 'session-1',
            conversation: 3,
            turns: session.turns,
            answering: decision.answering,
          };
        }
        if (name === 'oneToOne:recordAnswer') {
          if (session.keepThrows) throw session.keepThrows;
          if (session.keepRefusal) return { kept: false, refusal: session.keepRefusal };
          const decision = decideAnswer(session.turns, args.answer as never, 2);
          if (!decision.ok) return { kept: false, refusal: decision.refusal };
          session.turns = [...decision.turns];
          session.closed = decision.closed;
          return { kept: true, closed: decision.closed };
        }
        throw new Error(`unexpected mutation ${name}`);
      }
      async query(reference: unknown, args: Record<string, unknown>): Promise<unknown> {
        const name = getFunctionName(reference as never);
        session.calls.push({ name, args });
        if (name === 'agents:get') return session.employee;
        throw new Error(`unexpected query ${name}`);
      }
    },
  };
});

beforeEach((): void => {
  session.turns = [];
  session.closed = false;
  session.refusal = undefined;
  session.keepRefusal = undefined;
  session.keepThrows = undefined;
  session.employee = { name: 'Ada' };
  session.calls = [];
});

const FEATHERLESS = 'https://api.featherless.ai/v1';
const GLM = 'zai-org/GLM-5.3-Flash';

/** Request bodies the model provider put on the wire, newest last. */
let sent: Record<string, unknown>[] = [];

/**
 * Load the Day-1 chat route against a stubbed provider endpoint.
 *
 * Args:
 *   settings: Base URL, model id and the two optional model knobs. An empty
 *     string means the variable is absent, which is how `.env.local` spells it.
 *
 * Returns:
 *   The route's POST handler, bound to a `fetch` that records what it is sent.
 */
async function loadChatRoute(settings: {
  baseUrl?: string;
  model?: string;
  budget?: string;
  effort?: string;
}): Promise<(req: Request) => Promise<Response>> {
  vi.resetModules();
  sent = [];
  vi.stubEnv('NEXT_PUBLIC_CONVEX_URL', 'https://day0.convex.invalid');
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.stubEnv('OPENAI_BASE_URL', settings.baseUrl ?? '');
  vi.stubEnv('OPENAI_MODEL', settings.model ?? GLM);
  vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', settings.budget ?? '');
  vi.stubEnv('OPENAI_REASONING_EFFORT', settings.effort ?? '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return chatCompletionStream();
    }),
  );
  const { POST } = await import('../../../../../app/api/voice/chat/route');
  return POST;
}

type Delta = Record<string, unknown>;

/** One streamed chat completion, built from the deltas the provider would send. */
function completionStream(deltas: [Delta, string | null][]): Response {
  const chunk = (delta: Delta, finish: string | null): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-day1',
      object: 'chat.completion.chunk',
      created: 1,
      model: GLM,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return new Response(deltas.map(([d, f]) => chunk(d, f)).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** The smallest streamed chat completion the AI SDK will accept as a reply. */
function chatCompletionStream(): Response {
  return textCompletion('Welcome aboard. First topic: why this hire?');
}

function textCompletion(text: string): Response {
  return completionStream([
    [{ role: 'assistant', content: text }, null],
    [{}, 'stop'],
  ]);
}

/**
 * The turn the 19 Sep run recorded twice (`findings/priya-chat-open-1-response.txt`,
 * 19.5 s, and `-turn-4-`, 17.6 s): a 200 whose stream carried `start`,
 * `start-step`, `finish-step`, `finish (stop)` and nothing else. Only the
 * headers were saved, so the body is rebuilt from the provider side: a
 * completion that stops without content or a tool call.
 */
function emptyCompletion(): Response {
  return completionStream([
    [{ role: 'assistant', content: '' }, null],
    [{}, 'stop'],
  ]);
}

/** A turn that says `text` (or nothing) and calls `dayOneComplete` with it. */
function closingCompletion(text: string, closingLine: string): Response {
  return completionStream([
    [{ role: 'assistant', content: text }, null],
    [
      {
        tool_calls: [
          {
            index: 0,
            id: 'call_close',
            type: 'function',
            function: { name: 'dayOneComplete', arguments: JSON.stringify({ closingLine }) },
          },
        ],
      },
      null,
    ],
    [{}, 'tool_calls'],
  ]);
}

/** Answer the provider calls in order with `replies`, repeating the last one. */
function stubProvider(replies: (() => Response)[]): void {
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const reply = replies[Math.min(call, replies.length - 1)];
      call += 1;
      return reply();
    }),
  );
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

/**
 * The turn the chat room posts after `exchanges` question-and-answer pairs, with the session
 * holding the conversation up to it: the employee's questions and the manager's replies, the last
 * reply the one this turn sends. No exchanges is the opening.
 */
function turnAfter(exchanges: number): Request {
  const turns: OneToOneTurn[] = [];
  for (let i = 1; i <= exchanges; i += 1) {
    turns.push({
      id: `a${i}`,
      speaker: 'employee',
      text: `Topic ${i}: what should I know?`,
      topicIndex: Math.min(i - 1, 6),
      at: i,
    });
    if (i < exchanges) turns.push({ id: `u${i}`, speaker: 'manager', text: `Answer ${i}.`, at: i });
  }
  session.turns = turns;
  return day1Request({
    agentId: 'agent-1',
    bossLabel: 'Sam',
    request:
      exchanges === 0
        ? { kind: 'open' }
        : {
            kind: 'reply',
            question: `a${exchanges}`,
            replies: [{ id: `u${exchanges}`, text: `Answer ${exchanges}.` }],
          },
  });
}

function day1Request(body: unknown): Request {
  return new Request('http://127.0.0.1:3000/api/voice/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach((): void => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValue(TURN_ID);
});

afterEach((): void => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the Day-1 chat route', (): void => {
  it('sends the configured budget and effort to a compatible endpoint', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS, budget: '32768', effort: 'low' });

    const response = await POST(turnAfter(0));
    await response.text();

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      model: GLM,
      stream: true,
      max_tokens: 32768,
      reasoning_effort: 'low',
      // Re-pinned from v1: the prompt now carries the employee's name and the topics' titles;
      // from v2: it asks only the question each turn's note names (the v0.11.0 walk).
      prompt_cache_key: 'day0-day1-system-v3',
    });
  });

  it("keeps the route's own 2,000-token budget and sends no effort when neither knob is set", async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });

    await (await POST(turnAfter(0))).text();

    expect(sent[0]).toMatchObject({ max_tokens: 2000 });
    expect(sent[0]).not.toHaveProperty('reasoning_effort');
  });

  it('keeps the hosted Responses route on its existing budget', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: '', model: 'gpt-5.6-terra' });

    await (await POST(turnAfter(0))).text();

    expect(sent[0]).toMatchObject({ model: 'gpt-5.6-terra', max_output_tokens: 2000 });
    expect(sent[0]).not.toHaveProperty('reasoning');
  });

  it('carries the configured effort onto the hosted Responses route too', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: '', model: 'gpt-5.6-terra', effort: 'low' });

    await (await POST(turnAfter(0))).text();

    expect(sent[0]).toMatchObject({ reasoning: { effort: 'low' } });
  });

  it('never puts the provider key in the request body', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS, budget: '32768', effort: 'low' });

    await (await POST(turnAfter(0))).text();

    expect(JSON.stringify(sent[0])).not.toContain('test-key');
  });

  it('still opens the seven-topic 1:1 from the priming turn the room always sent, and offers the completion tool (re-pinned)', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS, budget: '32768', effort: 'low' });

    await (await POST(turnAfter(0))).text();

    const body = sent[0] as {
      messages: { role: string; content: string }[];
      tools: { function: { name: string } }[];
    };
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('SEVEN topics');
    expect(body.messages.slice(1)).toEqual([
      { role: 'user', content: '__init__' },
      { role: 'system', content: dayOneTurnNote(0) },
    ]);
    expect(body.tools.map((t) => t.function.name)).toContain('dayOneComplete');
  });

  it("tells the model the employee's own name and the topics' plain titles, never Day0, a slug or an em dash (walk m5)", async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });

    await (await POST(turnAfter(0))).text();

    const system = (sent[0] as { messages: { content: string }[] }).messages[0].content;
    expect(system).toContain('You are Ada,');
    expect(system).toContain('introduces you as Ada');
    expect(system).toContain('  1. Why this hire: What triggered the decision to bring me on?');
    expect(system).toContain('  3. Who to talk to: ');
    expect(system).not.toContain('Day0');
    expect(system).not.toMatch(/why-this-hire|role-and-goals|open-questions/);
    expect(system).not.toContain('\u2014');
  });

  it("answers 404 without keeping the reply or asking the model when the employee's row is gone", async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    session.employee = null;

    const response = await POST(turnAfter(1));

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe(
      'this employee no longer exists',
    );
    expect(sent).toHaveLength(0);
    // Nothing was taken for an employee that is gone: the session holds only what it held.
    expect(session.turns.map((turn) => turn.id)).toEqual(['a1']);
  });

  it('answers 503 before any stream opens when no model is configured', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: '' });
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.resetModules();
    const { POST: unconfigured } = await import('../../../../../app/api/voice/chat/route');

    const response = await unconfigured(turnAfter(0));

    expect(POST).toBeDefined();
    expect(response.status).toBe(503);
    // The chat room says the route's `error` to the manager as it stands (N29).
    expect(((await response.json()) as { error: string }).error).toBe('employee unavailable');
    expect(sent).toHaveLength(0);
  });

  it('refuses a body with no employee or no turn before calling the model (re-pinned)', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS, budget: '32768', effort: 'low' });

    for (const body of [
      { bossLabel: 'Sam' },
      { agentId: 'agent-1' },
      'open',
      { request: { kind: 'open' } },
      { agentId: 'agent-1', request: { kind: 'bogus' } },
    ]) {
      expect((await POST(day1Request(body))).status).toBe(400);
    }
    expect(sent).toHaveLength(0);
    expect(session.calls).toHaveLength(0);
  });

  it('tells a room older than the route to reload, not to ask again (review m10)', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });

    for (const body of [
      // A room from before the session kept the conversation posted its whole history.
      { id: 'one-to-one-agent-1', messages: [], trigger: 'submit-message', bossLabel: 'Sam' },
      { agentId: 'agent-1', request: { kind: 'reply', id: 'u1', text: 'An older shape.' } },
      { agentId: 'agent-1', request: { kind: 'ask-again', reply: null, discarding: null } },
    ]) {
      const response = await POST(day1Request(body));
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toMatch(/Reload to carry on/);
    }
    expect(sent).toHaveLength(0);
    expect(session.calls).toHaveLength(0);
  });

  it("refuses another origin's page before reading the body", async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    const request = turnAfter(0);
    request.headers.set('origin', 'http://localhost:4000');

    expect((await POST(request)).status).toBe(403);
    expect(session.calls).toHaveLength(0);
  });
});

it('cancels a stalled provider at the 60-second route deadline', async () => {
  const POST = await loadChatRoute({ baseUrl: FEATHERLESS, budget: '32768', effort: 'low' });
  vi.useFakeTimers();
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    setTimeout(() => deadline.abort(new DOMException('Deadline', 'TimeoutError')), ms);
    return deadline.signal;
  });
  let providerSignal: AbortSignal | null | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: unknown, init?: RequestInit) => {
      providerSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), {
          once: true,
        });
      });
    }),
  );
  try {
    const response = await POST(turnAfter(0));
    const body = response.text();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(providerSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(providerSignal?.aborted).toBe(true);
    expect(timeout).toHaveBeenCalledWith(60_000);
    await body;
    // A turn the deadline emptied is not asked again: there is no time left.
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    deadline.abort();
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

describe('a turn the model answers normally', (): void => {
  it('names the one question the turn asks as the last thing the model reads, by the count the progress line shows (the v0.11.0 walk)', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });

    const body = await (await POST(turnAfter(3))).text();

    const messages = (sent[0] as { messages: { role: string; content: unknown }[] }).messages;
    expect(messages.at(-1)).toEqual({ role: 'system', content: dayOneTurnNote(3) });
    expect(messages.at(-1)?.content).toContain('ask question 4 (What to read)');
    expect(messages.at(-2)).toMatchObject({ role: 'user' });
    const start = body.split('\n').find((line) => line.includes('"type":"start"'));
    expect(JSON.parse(start!.slice('data: '.length))).toMatchObject({
      messageMetadata: { topicIndex: 3 },
    });
  });

  it("says on its start which of the seven questions the turn is on, by the close gate's count", async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    const topicOf = async (exchanges: number): Promise<unknown> => {
      const body = await (await POST(turnAfter(exchanges))).text();
      const start = body.split('\n').find((line) => line.includes('"type":"start"'));
      return (JSON.parse(start!.slice('data: '.length)) as { messageMetadata?: unknown })
        .messageMetadata;
    };
    expect(await topicOf(0)).toEqual({ topicIndex: 0 });
    expect(await topicOf(3)).toEqual({ topicIndex: 3 });
    expect(await topicOf(9)).toEqual({ topicIndex: 6 });
  });

  it('reaches the chat room as the SDK streams it, the question on its start', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });

    const response = await POST(turnAfter(0));

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(await response.text()).toMatchInlineSnapshot(`
      "data: {"type":"start","messageMetadata":{"topicIndex":0},"messageId":"00000000-0000-4000-8000-000000000001"}

      data: {"type":"start-step"}

      data: {"type":"text-start","id":"0"}

      data: {"type":"text-delta","id":"0","delta":"Welcome aboard. First topic: why this hire?"}

      data: {"type":"text-end","id":"0"}

      data: {"type":"finish-step"}

      data: {"type":"finish","finishReason":"stop","messageMetadata":{"kept":true}}

      data: [DONE]

      "
    `);
    expect(sent).toHaveLength(1);
  });

  it('passes the close through untouched once topic 7 has its answer', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([() => closingCompletion('Thanks, Aiko.', 'I will draft the charter now.')]);

    const response = await POST(turnAfter(7));

    expect(await response.text()).toMatchInlineSnapshot(`
      "data: {"type":"start","messageMetadata":{"topicIndex":6},"messageId":"00000000-0000-4000-8000-000000000001"}

      data: {"type":"start-step"}

      data: {"type":"text-start","id":"0"}

      data: {"type":"text-delta","id":"0","delta":"Thanks, Aiko."}

      data: {"type":"tool-input-start","toolCallId":"call_close","toolName":"dayOneComplete"}

      data: {"type":"tool-input-delta","toolCallId":"call_close","inputTextDelta":"{\\"closingLine\\":\\"I will draft the charter now.\\"}"}

      data: {"type":"tool-input-available","toolCallId":"call_close","toolName":"dayOneComplete","input":{"closingLine":"I will draft the charter now."}}

      data: {"type":"text-end","id":"0"}

      data: {"type":"finish-step"}

      data: {"type":"finish","finishReason":"tool-calls","messageMetadata":{"kept":true}}

      data: [DONE]

      "
    `);
  });
});

describe('an empty model turn', (): void => {
  it('is asked again once, and the manager sees only the second answer', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([emptyCompletion, () => textCompletion('Welcome aboard. Why this hire?')]);

    const body = await (await POST(turnAfter(0))).text();

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    const chunks = chunksOf(body);
    expect(chunks.filter((c) => c.type === 'start')).toHaveLength(1);
    expect(chunks.filter((c) => c.type === 'finish')).toHaveLength(1);
    expect(
      chunks
        .filter((c) => c.type === 'text-delta')
        .map((c) => c.delta)
        .join(''),
    ).toBe('Welcome aboard. Why this hire?');
  });

  it('counts a turn of whitespace as empty', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([() => textCompletion('\n\n'), () => textCompletion('Noted. Who should I meet?')]);

    const body = await (await POST(turnAfter(2))).text();

    expect(sent).toHaveLength(2);
    expect(
      chunksOf(body)
        .filter((c) => c.type === 'text-delta')
        .map((c) => c.delta)
        .join(''),
    ).toBe('Noted. Who should I meet?');
  });

  it('is asked again once only: a second empty turn is what the chat room gets', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([emptyCompletion]);

    const body = await (await POST(turnAfter(0))).text();

    expect(sent).toHaveLength(2);
    const types = chunksOf(body).map((c) => c.type);
    expect(types.filter((t) => t === 'start')).toHaveLength(1);
    expect(types).not.toContain('text-delta');
    expect(types.at(-1)).toBe('finish');
  });

  it('does not ask again for a turn that only closes the 1:1', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([() => closingCompletion('', 'I will draft the charter now.')]);

    const body = await (await POST(turnAfter(7))).text();

    expect(sent).toHaveLength(1);
    expect(chunksOf(body).map((c) => c.type)).toContain('tool-input-available');
  });
});

describe('closing the 1:1', (): void => {
  const closed = (body: string): boolean => chunksOf(body).some((c) => c.type.startsWith('tool-'));
  const said = (body: string): string =>
    chunksOf(body)
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.delta)
      .join('');

  it('drops a close that arrives in the turn that asks topic 7', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    const question = 'Last one: anything you are unsure about, or want me to circle back on?';
    stubProvider([() => closingCompletion(question, 'Thanks Aiko, drafting the charter.')]);

    const body = await (await POST(turnAfter(6))).text();

    expect(closed(body)).toBe(false);
    expect(said(body)).toBe(question);
    expect(chunksOf(body).at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' });
    expect(sent).toHaveLength(1);
  });

  it('drops a close whose own turn still asks something, however long the 1:1 has run', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    const question = 'One more: who owns the Looker tile?';
    stubProvider([() => closingCompletion(question, 'Thanks, drafting the charter.')]);

    const body = await (await POST(turnAfter(8))).text();

    expect(closed(body)).toBe(false);
    expect(said(body)).toBe(question);
  });

  it('puts the next scripted question when an early close leaves the turn with none', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([() => closingCompletion('', 'All set, drafting the charter.')]);

    const body = await (await POST(turnAfter(6))).text();

    expect(closed(body)).toBe(false);
    // The question's own words, never its "7/7" headline, which counts replies (review r2).
    expect(said(body)).toBe(
      "Anything you're unsure about, or things you'd like me to circle back on later? I'll capture them as open questions on the charter.",
    );
    expect(said(body)).not.toMatch(/\d\/7/);
    expect(sent).toHaveLength(1);
  });

  it('adds the scripted question to words that asked nothing', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([() => closingCompletion('Understood, week one is the tracker.', 'Drafting.')]);

    const body = await (await POST(turnAfter(6))).text();

    expect(closed(body)).toBe(false);
    expect(said(body)).toMatch(
      /^Understood, week one is the tracker\.\n\nAnything you're unsure about/,
    );
    const types = chunksOf(body).map((c) => c.type);
    expect(types.filter((t) => t === 'text-start')).toHaveLength(1);
    expect(types.indexOf('text-end')).toBeGreaterThan(types.lastIndexOf('text-delta'));
  });

  it('puts the scripted question after words that came behind the close', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    const call = {
      index: 0,
      id: 'call_close',
      type: 'function',
      function: { name: 'dayOneComplete', arguments: JSON.stringify({ closingLine: 'Drafting.' }) },
    };
    stubProvider([
      () =>
        completionStream([
          [{ role: 'assistant', tool_calls: [call] }, null],
          [{ content: 'Week one is the tracker, then.' }, null],
          [{}, 'tool_calls'],
        ]),
    ]);

    const body = await (await POST(turnAfter(6))).text();

    expect(closed(body)).toBe(false);
    expect(said(body)).toMatch(/^Week one is the tracker, then\.\s*Anything you're unsure about/);
    expect(
      chunksOf(body)
        .map((c) => c.type)
        .slice(-2),
    ).toEqual(['finish-step', 'finish']);
  });

  it('honours a close that only quotes a question back', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([
      () =>
        closingCompletion('Noted "who owns the Looker tile?" as open.', 'Drafting the charter.'),
    ]);

    const body = await (await POST(turnAfter(7))).text();

    expect(closed(body)).toBe(true);
  });

  it('does not count the priming turn or a second message in a row as a reply (re-pinned: the session keeps both)', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    turnAfter(6);
    session.turns = [...session.turns, { id: 'u6', speaker: 'manager', text: 'Answer 6.', at: 6 }];
    stubProvider([() => closingCompletion('Thanks.', 'Drafting the charter.')]);

    const body = await (
      await POST(
        day1Request({
          agentId: 'agent-1',
          request: {
            kind: 'reply',
            question: 'a6',
            replies: [
              { id: 'u6', text: 'Answer 6.' },
              { id: 'u6b', text: 'And one more thing on that.' },
            ],
          },
        }),
      )
    ).text();

    expect(closed(body)).toBe(false);
    expect(session.turns.slice(-3).map((turn) => turn.id)).toEqual(['u6', 'u6b', TURN_ID]);
  });

  it('honours the close once the manager has replied after topic 7', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([() => closingCompletion('Thanks, Aiko.', 'I will draft the charter now.')]);

    const body = await (await POST(turnAfter(7))).text();

    expect(closed(body)).toBe(true);
    expect(chunksOf(body).find((c) => c.type === 'tool-input-available')).toMatchObject({
      toolName: 'dayOneComplete',
      input: { closingLine: 'I will draft the charter now.' },
    });
  });
});

it('does not ask again once the 60-second deadline has cut a reply', async () => {
  const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
  vi.useFakeTimers();
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    setTimeout(() => deadline.abort(new DOMException('Deadline', 'TimeoutError')), ms);
    return deadline.signal;
  });
  // The reply the run saw cut at "Under": the provider sends the first word and stalls.
  const first = `data: ${JSON.stringify({
    id: 'chatcmpl-day1',
    object: 'chat.completion.chunk',
    created: 1,
    model: GLM,
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Under' }, finish_reason: null }],
  })}\n\n`;
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      const stalled = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(first));
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      });
      return new Response(stalled, { headers: { 'content-type': 'text/event-stream' } });
    }),
  );
  try {
    const response = await POST(turnAfter(3));
    const body = response.text();
    await vi.advanceTimersByTimeAsync(60_000);
    const types = chunksOf(await body).map((c) => c.type);
    expect(types).toContain('text-delta');
    expect(types).not.toContain('finish');
    expect(calls).toBe(1);
  } finally {
    deadline.abort();
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

describe('the one-to-one kept on its session (30 Sep, a one-to-one lost to a closed tab)', (): void => {
  it("keeps the manager's reply before the employee is asked, so a turn that never finishes loses it not", async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => {
        throw new TypeError('fetch failed');
      }),
    );

    await (await POST(turnAfter(3))).text();

    expect(session.turns.at(-1)).toEqual({
      id: 'u3',
      speaker: 'manager',
      text: 'Answer 3.',
      at: 1,
    });
    expect(session.turns.filter((turn) => turn.speaker === 'manager')).toHaveLength(3);
  });

  it('keeps the answer under the id the room draws it with, before the room hears it finished', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([() => textCompletion('Noted. Who should I meet?')]);

    const chunks = chunksOf(await (await POST(turnAfter(2))).text());

    expect(chunks[0]).toMatchObject({ type: 'start', messageId: TURN_ID });
    expect(session.turns.at(-1)).toEqual({
      id: TURN_ID,
      speaker: 'employee',
      text: 'Noted. Who should I meet?',
      topicIndex: 2,
      at: 2,
    });
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' });
  });

  it('asks the model from the conversation the session keeps, never from a history the room sends', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    turnAfter(2);

    await (
      await POST(
        day1Request({
          agentId: 'agent-1',
          request: { kind: 'reply', question: 'a2', replies: [{ id: 'u2', text: 'Answer 2.' }] },
          messages: [{ id: 'x', role: 'user', parts: [{ type: 'text', text: 'Invented.' }] }],
        }),
      )
    ).text();

    const said = JSON.stringify((sent[0] as { messages: unknown[] }).messages);
    expect(said).not.toContain('Invented.');
    expect(said).toContain('Answer 1.');
    expect(said).toContain('Answer 2.');
  });

  it('asks again for the answer a reopened room is owed, from the reply the session kept', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    turnAfter(7);
    session.turns = [...session.turns, { id: 'u7', speaker: 'manager', text: 'Answer 7.', at: 7 }];
    stubProvider([() => closingCompletion('Thanks, Sam.', 'I will draft the charter now.')]);

    await (
      await POST(
        day1Request({
          agentId: 'agent-1',
          request: {
            kind: 'ask-again',
            question: 'a7',
            replies: [{ id: 'u7', text: 'Answer 7.' }],
            discarding: null,
          },
        }),
      )
    ).text();

    expect(session.closed).toBe(true);
    expect(session.turns.at(-1)).toMatchObject({
      speaker: 'employee',
      closingLine: 'I will draft the charter now.',
    });
    // The answer is kept on the conversation the turn was taken on.
    expect(session.calls.find((call) => call.name === 'oneToOne:recordAnswer')?.args).toMatchObject(
      { sessionId: 'session-1', conversation: 3, bossLabel: 'there', answer: { answering: 'u7' } },
    );
  });

  it("refuses a turn the session will not take with the session's own sentence, before the model", async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    session.refusal = 'The one-to-one is over; the charter is drafted from it.';

    const response = await POST(turnAfter(1));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'The one-to-one is over; the charter is drafted from it.',
    });
    expect(sent).toHaveLength(0);
  });

  it('tells the room, ahead of the finish, when the answer it was shown was not kept', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    session.keepRefusal = 'The one-to-one moved on in another window. Reload to carry on.';

    const chunks = chunksOf(await (await POST(turnAfter(1))).text());

    expect(chunks.slice(-2)).toEqual([
      {
        type: 'error',
        errorText: 'The one-to-one moved on in another window. Reload to carry on.',
      },
      { type: 'finish', finishReason: 'stop' },
    ]);
  });
  it("says a keep the session refused outright in the session's words, and anything else as not kept (review m5)", async (): Promise<void> => {
    const { ConvexError } = await import('convex/values');
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    session.keepThrows = new ConvexError('The one-to-one started again in another window.');
    let chunks = chunksOf(await (await POST(turnAfter(1))).text());
    expect(chunks.at(-2)).toEqual({
      type: 'error',
      errorText: 'The one-to-one started again in another window.',
    });

    stubProvider([() => textCompletion('Noted.')]);
    session.keepThrows = new Error('[Request ID: 1a2b] Server Error');
    chunks = chunksOf(await (await POST(turnAfter(1))).text());
    expect(chunks.at(-2)).toEqual({ type: 'error', errorText: 'Day0 could not keep that answer' });
    expect(JSON.stringify(chunks)).not.toContain('Request ID');
  });
});
