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
  it('applies defaults so module loading never needs deployment values', async (): Promise<void> => {
    vi.stubEnv('DAY0_SURFACE_MODE', '');
    vi.stubEnv('DAY0_DOCS_ROOT', '');
    vi.stubEnv('OPENAI_MODEL', '');
    const env = await loadEnv();
    expect(env.DAY0_SURFACE_MODE).toBe('mock');
    expect(env.DAY0_DOCS_ROOT).toBe('/docs');
    expect(env.OPENAI_MODEL).toBe('gpt-5.5');
    expect(env.SKILL_SANDBOX_SOCKET).toBe('/run/day0-sandbox/skill-sandbox.sock');
  });

  it('reads an empty optional value as absent and drops it from process.env', async (): Promise<void> => {
    vi.stubEnv('OPENAI_BASE_URL', '');
    vi.stubEnv('EXA_API_KEY', '');
    const env = await loadEnv();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.EXA_API_KEY).toBeUndefined();
    expect(process.env.OPENAI_BASE_URL).toBeUndefined();
    expect(process.env.EXA_API_KEY).toBeUndefined();
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
