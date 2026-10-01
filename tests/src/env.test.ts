import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Evaluate `src/env.ts` afresh under the current stubbed environment.
 *
 * Returns:
 *   The parsed environment contract.
 */
async function loadEnv(): Promise<typeof import('../../src/env').env> {
  vi.resetModules();
  return (await import('../../src/env')).env;
}

describe('environment contract', (): void => {
  it('parses an explicit output budget and optional effort, rejecting invalid settings', async () => {
    vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', '32768');
    vi.stubEnv('OPENAI_REASONING_EFFORT', 'low');
    expect(await loadEnv()).toMatchObject({
      OPENAI_MAX_OUTPUT_TOKENS: 32768,
      OPENAI_REASONING_EFFORT: 'low',
    });
    for (const value of ['0', '-1', '1.5', 'unlimited']) {
      vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', value);
      await expect(loadEnv()).rejects.toThrow();
    }
    vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', '32768');
    vi.stubEnv('OPENAI_REASONING_EFFORT', 'disabled');
    await expect(loadEnv()).rejects.toThrow();
  });

  it('parses no key nothing in the tree reads: the image model and the Gemini pair are gone', async (): Promise<void> => {
    vi.stubEnv('OPENAI_IMAGE_MODEL', 'gpt-image-2');
    vi.stubEnv('GOOGLE_API_KEY', 'g');
    vi.stubEnv('GEMINI_LIVE_MODEL', 'gemini');
    const env = await loadEnv();
    expect(env).not.toHaveProperty('OPENAI_IMAGE_MODEL');
    expect(env).not.toHaveProperty('GOOGLE_API_KEY');
    expect(env).not.toHaveProperty('GEMINI_LIVE_MODEL');
  });

  it('applies defaults so module loading never needs deployment values', async (): Promise<void> => {
    vi.stubEnv('OPENAI_MAX_OUTPUT_TOKENS', '');
    vi.stubEnv('OPENAI_REASONING_EFFORT', '');
    vi.stubEnv('DAY0_SURFACE_MODE', '');
    vi.stubEnv('DAY0_DOCS_ROOT', '');
    vi.stubEnv('OPENAI_MODEL', '');
    const env = await loadEnv();
    expect(env.DAY0_SURFACE_MODE).toBe('mock');
    expect(env.DAY0_DOCS_ROOT).toBe('/docs');
    expect(env.OPENAI_MODEL).toBe('gpt-5.6-terra');
    expect(env.OPENAI_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(env.OPENAI_REASONING_EFFORT).toBeUndefined();
    expect(process.env.OPENAI_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(process.env.OPENAI_REASONING_EFFORT).toBeUndefined();
    expect(env.SKILL_SANDBOX_SOCKET).toBe('/run/day0-sandbox/skill-sandbox.sock');
  });

  it('reads an empty optional value as absent and drops it from process.env', async (): Promise<void> => {
    vi.stubEnv('OPENAI_BASE_URL', '');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', '');
    vi.stubEnv('DAY0_NOTION_MCP_AUTH_TOKEN', '');
    const env = await loadEnv();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.DAY0_CREDENTIAL_KEY).toBeUndefined();
    expect(env.DAY0_NOTION_MCP_AUTH_TOKEN).toBeUndefined();
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.DAY0_CREDENTIAL_KEY).toBeUndefined();
    expect(process.env.DAY0_NOTION_MCP_AUTH_TOKEN).toBeUndefined();
  });

  it('keeps a configured value and refuses an unknown surface mode', async (): Promise<void> => {
    vi.stubEnv('DAY0_DOCS_ROOT', '/mnt/team-docs');
    vi.stubEnv('DAY0_SURFACE_MODE', 'mock');
    const env = await loadEnv();
    expect(env.DAY0_DOCS_ROOT).toBe('/mnt/team-docs');
    vi.stubEnv('DAY0_SURFACE_MODE', 'staging');
    await expect(loadEnv()).rejects.toThrow();
  });
});

describe('the customer-local block of the environment contract', (): void => {
  it('carries the profile, its browser copy and the sign-in settings, empty as absent', async (): Promise<void> => {
    vi.stubEnv('DAY0_PROFILE', 'customer-local');
    vi.stubEnv('NEXT_PUBLIC_DAY0_PROFILE', 'customer-local');
    vi.stubEnv('DAY0_OIDC_ISSUER', 'https://issuer.acme.test');
    vi.stubEnv('DAY0_OIDC_AUDIENCE', 'day0-app');
    vi.stubEnv('DAY0_OIDC_CLIENT_SECRET', 'day0-test-client-secret');
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'acme.test');
    vi.stubEnv('DAY0_SESSION_SECRET', '');
    const env = await loadEnv();
    expect(env).toMatchObject({
      DAY0_PROFILE: 'customer-local',
      NEXT_PUBLIC_DAY0_PROFILE: 'customer-local',
      DAY0_OIDC_ISSUER: 'https://issuer.acme.test',
      DAY0_OIDC_AUDIENCE: 'day0-app',
      DAY0_OIDC_CLIENT_SECRET: 'day0-test-client-secret',
      DAY0_OIDC_ALLOWED_DOMAINS: 'acme.test',
    });
    expect(env.DAY0_SESSION_SECRET).toBeUndefined();
    expect(process.env.DAY0_SESSION_SECRET).toBeUndefined();
  });

  it('refuses a profile, or a browser copy of one, that names none', async (): Promise<void> => {
    vi.stubEnv('NEXT_PUBLIC_DAY0_PROFILE', 'customer-lcoal');
    await expect(loadEnv()).rejects.toThrow();
    vi.stubEnv('NEXT_PUBLIC_DAY0_PROFILE', '');
    vi.stubEnv('DAY0_PROFILE', 'hosted');
    await expect(loadEnv()).rejects.toThrow();
  });
});
