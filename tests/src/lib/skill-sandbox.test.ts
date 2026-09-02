import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function configuredBackend(): Promise<'daytona' | 'local'> {
  vi.resetModules();
  const { configuredSkillSandboxBackend } = await import('../../../src/lib/skill-sandbox');
  return configuredSkillSandboxBackend();
}

describe('skill sandbox backend selection', (): void => {
  it('selects Daytona only for a non-blank key, matching the deployment preflight', async (): Promise<void> => {
    vi.stubEnv('OPENAI_API_KEY', 'test-key');

    vi.stubEnv('DAYTONA_API_KEY', 'dtn_key');
    expect(await configuredBackend()).toBe('daytona');

    vi.stubEnv('DAYTONA_API_KEY', '   ');
    expect(await configuredBackend()).toBe('local');

    vi.stubEnv('DAYTONA_API_KEY', '');
    expect(await configuredBackend()).toBe('local');
  });
});
