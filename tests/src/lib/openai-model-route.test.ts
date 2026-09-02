import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadModelRoute(baseUrl: string | undefined): Promise<{
  languageModel: typeof import('../../../src/lib/openai').languageModel;
  modelProviderClient: typeof import('../../../src/lib/openai').modelProviderClient;
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
});
