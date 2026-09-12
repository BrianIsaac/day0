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

/** The smallest streamed chat completion the AI SDK will accept as a reply. */
function chatCompletionStream(): Response {
  const chunk = (delta: unknown, finish: string | null): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-day1',
      object: 'chat.completion.chunk',
      created: 1,
      model: GLM,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return new Response(
    chunk({ role: 'assistant', content: 'Welcome aboard. First topic: why this hire?' }, null) +
      chunk({}, 'stop') +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
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
  } finally {
    deadline.abort();
    timeout.mockRestore();
    vi.useRealTimers();
  }
});
