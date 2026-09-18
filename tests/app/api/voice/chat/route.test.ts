import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../src/lib/dev-auth-server', () => ({
  establishCaller: async () => ({ ok: true, userId: 'dev-no-auth-subject' }),
}));

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

function turn(role: 'user' | 'assistant', text: string, id: string): unknown {
  return { id, role, parts: [{ type: 'text', text }] };
}

/**
 * The chat room's history after `exchanges` question-and-answer pairs: the
 * priming turn, then the agent's question and the manager's reply for each.
 */
function historyOf(exchanges: number): unknown[] {
  const history: unknown[] = [turn('user', '__init__', 'm0')];
  for (let i = 1; i <= exchanges; i += 1) {
    history.push(turn('assistant', `Topic ${i}: what should I know?`, `a${i}`));
    history.push(turn('user', `Answer ${i}.`, `u${i}`));
  }
  return history;
}

function day1Request(body: unknown): Request {
  return new Request('http://127.0.0.1:3000/api/voice/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the Day-1 chat route', (): void => {
  it('sends the configured budget and effort to a compatible endpoint', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS, budget: '32768', effort: 'low' });

    const response = await POST(day1Request({ messages: [], bossLabel: 'Brian' }));
    await response.text();

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      model: GLM,
      stream: true,
      max_tokens: 32768,
      reasoning_effort: 'low',
      prompt_cache_key: 'day0-day1-system-v1',
    });
  });

  it("keeps the route's own 2,000-token budget and sends no effort when neither knob is set", async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });

    await (await POST(day1Request({ messages: [] }))).text();

    expect(sent[0]).toMatchObject({ max_tokens: 2000 });
    expect(sent[0]).not.toHaveProperty('reasoning_effort');
  });

  it('keeps the hosted Responses route on its existing budget', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: '', model: 'gpt-5.6-terra' });

    await (await POST(day1Request({ messages: [] }))).text();

    expect(sent[0]).toMatchObject({ model: 'gpt-5.6-terra', max_output_tokens: 2000 });
    expect(sent[0]).not.toHaveProperty('reasoning');
  });

  it('carries the configured effort onto the hosted Responses route too', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: '', model: 'gpt-5.6-terra', effort: 'low' });

    await (await POST(day1Request({ messages: [] }))).text();

    expect(sent[0]).toMatchObject({ reasoning: { effort: 'low' } });
  });

  it('never puts the provider key in the request body', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS, budget: '32768', effort: 'low' });

    await (await POST(day1Request({ messages: [] }))).text();

    expect(JSON.stringify(sent[0])).not.toContain('test-key');
  });

  it('still opens the seven-topic 1:1 and offers the completion tool', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS, budget: '32768', effort: 'low' });

    await (await POST(day1Request({ messages: [], bossLabel: 'Brian' }))).text();

    const body = sent[0] as {
      messages: { role: string; content: string }[];
      tools: { function: { name: string } }[];
    };
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('SEVEN topics');
    expect(body.messages[1].content).toContain('Begin the Day-1 1:1');
    expect(body.tools.map((t) => t.function.name)).toContain('dayOneComplete');
  });

  it('answers 503 before any stream opens when no model is configured', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: '' });
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.resetModules();
    const { POST: unconfigured } = await import('../../../../../app/api/voice/chat/route');

    const response = await unconfigured(day1Request({ messages: [] }));

    expect(POST).toBeDefined();
    expect(response.status).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it('refuses a body with no messages array before calling the model', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS, budget: '32768', effort: 'low' });

    const response = await POST(day1Request({ bossLabel: 'Brian' }));

    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
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
  vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: RequestInit) => {
    providerSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true });
    });
  }));
  try {
    const response = await POST(day1Request({ messages: [] }));
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
  it('reaches the chat room byte for byte as the SDK streams it', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });

    const response = await POST(day1Request({ messages: historyOf(0) }));

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(await response.text()).toMatchInlineSnapshot(`
      "data: {"type":"start"}

      data: {"type":"start-step"}

      data: {"type":"text-start","id":"0"}

      data: {"type":"text-delta","id":"0","delta":"Welcome aboard. First topic: why this hire?"}

      data: {"type":"text-end","id":"0"}

      data: {"type":"finish-step"}

      data: {"type":"finish","finishReason":"stop"}

      data: [DONE]

      "
    `);
    expect(sent).toHaveLength(1);
  });

  it('passes the close through untouched once topic 7 has its answer', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([() => closingCompletion('Thanks, Aiko.', 'I will draft the charter now.')]);

    const response = await POST(day1Request({ messages: historyOf(7) }));

    expect(await response.text()).toMatchInlineSnapshot(`
      "data: {"type":"start"}

      data: {"type":"start-step"}

      data: {"type":"text-start","id":"0"}

      data: {"type":"text-delta","id":"0","delta":"Thanks, Aiko."}

      data: {"type":"tool-input-start","toolCallId":"call_close","toolName":"dayOneComplete"}

      data: {"type":"tool-input-delta","toolCallId":"call_close","inputTextDelta":"{\\"closingLine\\":\\"I will draft the charter now.\\"}"}

      data: {"type":"tool-input-available","toolCallId":"call_close","toolName":"dayOneComplete","input":{"closingLine":"I will draft the charter now."}}

      data: {"type":"text-end","id":"0"}

      data: {"type":"finish-step"}

      data: {"type":"finish","finishReason":"tool-calls"}

      data: [DONE]

      "
    `);
  });
});

describe('an empty model turn', (): void => {
  it('is asked again once, and the manager sees only the second answer', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([emptyCompletion, () => textCompletion('Welcome aboard. Why this hire?')]);

    const body = await (await POST(day1Request({ messages: historyOf(0) }))).text();

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    const chunks = chunksOf(body);
    expect(chunks.filter((c) => c.type === 'start')).toHaveLength(1);
    expect(chunks.filter((c) => c.type === 'finish')).toHaveLength(1);
    expect(chunks.filter((c) => c.type === 'text-delta').map((c) => c.delta).join('')).toBe(
      'Welcome aboard. Why this hire?',
    );
  });

  it('counts a turn of whitespace as empty', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([() => textCompletion('\n\n'), () => textCompletion('Noted. Who should I meet?')]);

    const body = await (await POST(day1Request({ messages: historyOf(2) }))).text();

    expect(sent).toHaveLength(2);
    expect(chunksOf(body).filter((c) => c.type === 'text-delta').map((c) => c.delta).join('')).toBe(
      'Noted. Who should I meet?',
    );
  });

  it('is asked again once only: a second empty turn is what the chat room gets', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([emptyCompletion]);

    const body = await (await POST(day1Request({ messages: historyOf(0) }))).text();

    expect(sent).toHaveLength(2);
    const types = chunksOf(body).map((c) => c.type);
    expect(types.filter((t) => t === 'start')).toHaveLength(1);
    expect(types).not.toContain('text-delta');
    expect(types.at(-1)).toBe('finish');
  });

  it('does not ask again for a turn that only closes the 1:1', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([() => closingCompletion('', 'I will draft the charter now.')]);

    const body = await (await POST(day1Request({ messages: historyOf(7) }))).text();

    expect(sent).toHaveLength(1);
    expect(chunksOf(body).map((c) => c.type)).toContain('tool-input-available');
  });
});

describe('closing the 1:1', (): void => {
  const closed = (body: string): boolean =>
    chunksOf(body).some((c) => c.type.startsWith('tool-'));
  const said = (body: string): string =>
    chunksOf(body)
      .filter((c) => c.type === 'text-delta')
      .map((c) => c.delta)
      .join('');

  it('drops a close that arrives in the turn that asks topic 7', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    const question = 'Last one: anything you are unsure about, or want me to circle back on?';
    stubProvider([() => closingCompletion(question, 'Thanks Aiko, drafting the charter.')]);

    const body = await (await POST(day1Request({ messages: historyOf(6) }))).text();

    expect(closed(body)).toBe(false);
    expect(said(body)).toBe(question);
    expect(chunksOf(body).at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' });
    expect(sent).toHaveLength(1);
  });

  it('drops a close whose own turn still asks something, however long the 1:1 has run', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    const question = 'One more: who owns the Looker tile?';
    stubProvider([() => closingCompletion(question, 'Thanks, drafting the charter.')]);

    const body = await (await POST(day1Request({ messages: historyOf(8) }))).text();

    expect(closed(body)).toBe(false);
    expect(said(body)).toBe(question);
  });

  it('puts the next scripted question when an early close leaves the turn with none', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([() => closingCompletion('', 'All set, drafting the charter.')]);

    const body = await (await POST(day1Request({ messages: historyOf(6) }))).text();

    expect(closed(body)).toBe(false);
    expect(said(body)).toContain('7/7');
    expect(said(body)).toContain('open questions on the charter');
    expect(sent).toHaveLength(1);
  });

  it('adds the scripted question to words that asked nothing', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([() => closingCompletion('Understood, week one is the tracker.', 'Drafting.')]);

    const body = await (await POST(day1Request({ messages: historyOf(6) }))).text();

    expect(closed(body)).toBe(false);
    expect(said(body)).toMatch(/^Understood, week one is the tracker\.\n\n7\/7/);
    const types = chunksOf(body).map((c) => c.type);
    expect(types.filter((t) => t === 'text-start')).toHaveLength(1);
    expect(types.indexOf('text-end')).toBeGreaterThan(types.lastIndexOf('text-delta'));
  });

  it('honours a close that only quotes a question back', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([
      () => closingCompletion('Noted "who owns the Looker tile?" as open.', 'Drafting the charter.'),
    ]);

    const body = await (await POST(day1Request({ messages: historyOf(7) }))).text();

    expect(closed(body)).toBe(true);
  });

  it('does not count the priming turn or a second message in a row as a reply', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([() => closingCompletion('Thanks.', 'Drafting the charter.')]);
    const history = [...historyOf(6), turn('user', 'And one more thing on that.', 'u6b')];

    const body = await (await POST(day1Request({ messages: history }))).text();

    expect(closed(body)).toBe(false);
  });

  it('honours the close once the manager has replied after topic 7', async (): Promise<void> => {
    const POST = await loadChatRoute({ baseUrl: FEATHERLESS });
    stubProvider([() => closingCompletion('Thanks, Aiko.', 'I will draft the charter now.')]);

    const body = await (await POST(day1Request({ messages: historyOf(7) }))).text();

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
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
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
  }));
  try {
    const response = await POST(day1Request({ messages: historyOf(3) }));
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
