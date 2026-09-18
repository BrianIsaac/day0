import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadModelRoute(baseUrl: string | undefined): Promise<{
  languageModel: typeof import('../../../src/lib/openai').languageModel;
  modelProviderClient: typeof import('../../../src/lib/openai').modelProviderClient;
  openai: typeof import('../../../src/lib/openai').openai;
}> {
  vi.resetModules();
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.stubEnv('OPENAI_BASE_URL', baseUrl ?? '');
  return await import('../../../src/lib/openai');
}

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('model provider capability route', (): void => {
  it('binds hosted OpenAI to the Responses API', async (): Promise<void> => {
    const { languageModel, modelProviderClient } = await loadModelRoute(undefined);

    expect(modelProviderClient()).toBe('openai.responses');
    expect(languageModel('gpt-5.6-terra').provider).toBe('openai.responses');
  });

  it('binds a custom OpenAI-compatible base URL to chat completions', async (): Promise<void> => {
    const { languageModel, modelProviderClient } = await loadModelRoute('http://model:11434/v1');

    expect(modelProviderClient()).toBe('openai.chat');
    expect(languageModel('qwen3:8b').provider).toBe('openai.chat');
  });

  it('counts every request it sends against the model call in progress', async (): Promise<void> => {
    const { languageModel } = await loadModelRoute('http://model:11434/v1');
    const { countingProviderRequests } = await import('../../../src/lib/model-call-telemetry');
    const responses = [
      new Response('{"error":{"message":"overloaded"}}', { status: 503 }),
      new Response(
        JSON.stringify({
          id: 'one',
          object: 'chat.completion',
          created: 1,
          model: 'qwen3:8b',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ];
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => responses.shift()!));

    const counter = { count: 0 };
    await countingProviderRequests(counter, async (): Promise<void> => {
      const model = languageModel('qwen3:8b');
      const prompt = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }];
      // The first request is refused, as the provider does when it is hot;
      // whoever retries - the SDK inside one of our attempts, or the wrapper
      // around them - sends a second request, and both are counted against
      // the one model call.
      await expect(model.doGenerate({ prompt })).rejects.toThrow();
      await model.doGenerate({ prompt });
    });

    expect(counter.count).toBe(2);
  });
});
