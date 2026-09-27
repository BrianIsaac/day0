import { describe, expect, it } from 'vitest';
import { isLoopback, setupRoute } from '../../scripts/setup-route';

describe('a loopback address', (): void => {
  it('is any of the host-only names, with or without a port or path', (): void => {
    for (const url of [
      'http://127.0.0.1:11434/v1',
      'http://localhost',
      'https://[::1]/v1',
      'http://0.0.0.0:8080',
    ]) {
      expect(isLoopback(url), url).toBe(true);
    }
    expect(isLoopback('http://model:11434/v1')).toBe(false);
    expect(isLoopback('http://localhost.example.com/v1')).toBe(false);
  });
});

describe('the model route an env file describes', (): void => {
  it('names each route setup writes, and no key value', (): void => {
    expect(setupRoute({})).toEqual({
      route: 'none',
      detail: 'no model: neither OPENAI_API_KEY nor OPENAI_BASE_URL is set',
    });
    expect(setupRoute({ OPENAI_API_KEY: 'sk-synthetic', OPENAI_MODEL: 'gpt-x' })).toEqual({
      route: 'key',
      detail: 'api.openai.com with OPENAI_API_KEY, model gpt-x',
    });
    expect(
      setupRoute({ OPENAI_BASE_URL: 'https://api.featherless.ai/v1', OPENAI_MODEL: 'glm' }),
    ).toEqual({
      route: 'featherless',
      detail: 'GLM through Featherless, model glm, no key',
    });
    expect(
      setupRoute({
        OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1',
        CONVEX_OPENAI_BASE_URL: 'http://model:11434/v1',
        OPENAI_MODEL: 'qwen3:8b',
      }),
    ).toEqual({ route: 'local', detail: 'the bundled model service, model qwen3:8b' });
    const endpoint = setupRoute({
      OPENAI_BASE_URL: 'https://gateway.example/v1',
      OPENAI_API_KEY: 'sk-synthetic',
    });
    expect(endpoint).toEqual({
      route: 'endpoint',
      detail: 'https://gateway.example/v1, model gpt-5.6-terra (default)',
    });
    expect(JSON.stringify(endpoint)).not.toContain('sk-synthetic');
  });

  it("calls a loopback address with no bundled model service behind it an endpoint of the reader's own", (): void => {
    expect(setupRoute({ OPENAI_BASE_URL: 'http://127.0.0.1:11434/v1' }).route).toBe('endpoint');
  });
});
