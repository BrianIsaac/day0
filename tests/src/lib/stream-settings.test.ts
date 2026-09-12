import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadStreamSettings(
  knobs: { budget?: string; effort?: string } = {},
): Promise<typeof import('../../../src/lib/stream-settings')> {
  vi.resetModules();
  vi.stubEnv('OPENAI_API_KEY', 'test-key');
  vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', knobs.budget ?? '');
  vi.stubEnv('OPENAI_REASONING_EFFORT', knobs.effort ?? '');
  return await import('../../../src/lib/stream-settings');
}

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('streaming call settings', (): void => {
  it("keeps the route's own budget and provider options when neither knob is set", async (): Promise<void> => {
    const { streamCallOptions } = await loadStreamSettings();

    expect(
      streamCallOptions({ maxOutputTokens: 2000, openai: { promptCacheKey: 'day0-day1' } }),
    ).toEqual({
      maxOutputTokens: 2000,
      providerOptions: { openai: { promptCacheKey: 'day0-day1' } },
    });
  });

  it('prefers the configured budget over the route default', async (): Promise<void> => {
    const { streamCallOptions } = await loadStreamSettings({ budget: '32768' });

    expect(streamCallOptions({ maxOutputTokens: 2000 }).maxOutputTokens).toBe(32768);
  });

  it('adds the configured effort beside the options the route already sends', async (): Promise<void> => {
    const { streamCallOptions } = await loadStreamSettings({ budget: '32768', effort: 'low' });

    expect(
      streamCallOptions({ maxOutputTokens: 2000, openai: { promptCacheKey: 'day0-day1' } }),
    ).toEqual({
      maxOutputTokens: 32768,
      providerOptions: { openai: { promptCacheKey: 'day0-day1', reasoningEffort: 'low' } },
    });
  });

  it('sends no effort field at all when the knob is unset', async (): Promise<void> => {
    const { streamCallOptions } = await loadStreamSettings({ budget: '32768' });

    const options = streamCallOptions({ maxOutputTokens: 2000 });
    expect(options.providerOptions.openai).not.toHaveProperty('reasoningEffort');
  });

  it('carries no credential material into the request settings', async (): Promise<void> => {
    const { streamCallOptions } = await loadStreamSettings({ budget: '32768', effort: 'low' });

    const serialised = JSON.stringify(
      streamCallOptions({ maxOutputTokens: 2000, openai: { promptCacheKey: 'day0-day1' } }),
    );
    expect(serialised).not.toContain('test-key');
    expect(serialised).not.toMatch(/apiKey|authorization/i);
  });
});
