import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it.each([
  ['https://api.featherless.ai/v1', 'max_tokens'],
  ['', 'max_completion_tokens'],
  ['https://api.openai.com/v1', 'max_completion_tokens'],
])(
  'selects the raw chat budget field for %s and honours overrides',
  async (baseUrl, budgetField) => {
    vi.resetModules();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', baseUrl);
    vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', '32768');
    vi.stubEnv('OPENAI_REASONING_EFFORT', 'low');
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { jsonCompleteWithMode, textComplete } = await import('../../../src/lib/openai');
    await jsonCompleteWithMode({ system: 'JSON', user: 'Test', mode: 'prompt' });
    await textComplete({
      system: 'JSON',
      user: 'Test',
      maxTokens: 8192,
      reasoningEffort: 'medium',
    });
    expect(requests[0]).toMatchObject({ [budgetField]: 32768, reasoning_effort: 'low' });
    expect(requests[1]).toMatchObject({ [budgetField]: 8192, reasoning_effort: 'medium' });
    for (const body of requests) {
      expect(body).not.toHaveProperty(
        budgetField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens',
      );
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('chat_template_kwargs');
    }
  },
);

it('sends the configured budget and effort through real Mastra JSON and text calls to Featherless', async () => {
  vi.resetModules();
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.stubEnv('OPENAI_BASE_URL', 'https://api.featherless.ai/v1');
  vi.stubEnv('OPENAI_MODEL', 'zai-org/GLM-5.3-Flash');
  vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', '32768');
  vi.stubEnv('OPENAI_REASONING_EFFORT', 'low');
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          id: 'chat-test',
          created: 1,
          model: 'zai-org/GLM-5.3-Flash',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: '{"ok":true}' },
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  const { makeAgent, agentJson, agentText } = await import('../../../src/lib/mastra');
  const agent = makeAgent('budget-test', 'Return JSON.');
  await expect(
    agentJson({ agent, user: 'Test', schema: z.object({ ok: z.boolean() }), mode: 'prompt' }),
  ).resolves.toEqual({ ok: true });
  await expect(agentText({ agent, user: 'Test' })).resolves.toBe('{"ok":true}');
  expect(requests).toHaveLength(2);
  for (const body of requests) {
    expect(body).toMatchObject({ max_tokens: 32768, reasoning_effort: 'low', temperature: 0.4 });
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('chat_template_kwargs');
  }
});
