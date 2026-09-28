import { afterEach, describe, expect, it, vi } from 'vitest';

/** A chat completion as an OpenAI-compatible server answers one. */
function completion(choices: unknown[]): Response {
  return new Response(
    JSON.stringify({
      id: 'c1',
      object: 'chat.completion',
      created: 1,
      model: 'qwen3:8b',
      choices,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** The module under a custom endpoint, with the server answering each request in turn. */
async function loadWith(
  ...responses: Response[]
): Promise<typeof import('../../../src/lib/openai')> {
  vi.resetModules();
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.stubEnv('OPENAI_BASE_URL', 'http://model:11434/v1');
  vi.stubEnv('OPENAI_JSON_MODE', 'prompt');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (): Promise<Response> => responses.shift()!),
  );
  return await import('../../../src/lib/openai');
}

const ARGS = { system: 'Answer in JSON.', user: 'Name the tile.' } as const;

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('an empty structured reply, by its cause (E-79)', (): void => {
  it('reads a reply cut at the output limit as cut, not as the model breaking the contract', async (): Promise<void> => {
    const openai = await loadWith(
      completion([
        { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' },
      ]),
    );
    const { ModelReplyCutError } = await import('../../../src/lib/structured-fallback');
    await expect(openai.jsonCompleteWithMode(ARGS)).rejects.toBeInstanceOf(ModelReplyCutError);
  });

  it('reads a content filter or a refusal as the provider refusing', async (): Promise<void> => {
    const filtered = await loadWith(
      completion([
        {
          index: 0,
          message: { role: 'assistant', content: null },
          finish_reason: 'content_filter',
        },
      ]),
    );
    await expect(filtered.jsonCompleteWithMode(ARGS)).rejects.toThrow('refused the request');
    const refused = await loadWith(
      completion([
        {
          index: 0,
          message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' },
          finish_reason: 'stop',
        },
      ]),
    );
    const { ModelRefusalError } = await import('../../../src/lib/structured-fallback');
    const error: unknown = await refused.jsonCompleteWithMode(ARGS).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ModelRefusalError);
    expect(error).toMatchObject({ refusal: 'I cannot help with that.' });
  });

  it('reads a reply with no choice as a provider failure, never a contract failure', async (): Promise<void> => {
    const openai = await loadWith(completion([]));
    const { StructuredContractError } = await import('../../../src/lib/structured-fallback');
    const error = await openai.jsonCompleteWithMode(ARGS).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StructuredContractError);
    expect((error as Error).message).toContain('no choices');
  });

  it('keeps an empty reply the model finished as a parse failure', async (): Promise<void> => {
    const openai = await loadWith(
      completion([
        { index: 0, message: { role: 'assistant', content: '  ' }, finish_reason: 'stop' },
      ]),
    );
    await expect(openai.jsonCompleteWithMode(ARGS)).rejects.toBeInstanceOf(openai.JsonParseError);
  });

  it('refuses a cut plain-text reply too, rather than returning half of it', async (): Promise<void> => {
    const openai = await loadWith(
      completion([
        {
          index: 0,
          message: { role: 'assistant', content: 'The tile shows' },
          finish_reason: 'length',
        },
      ]),
    );
    await expect(openai.textComplete(ARGS)).rejects.toThrow('cut off at the output limit');
  });
});
