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

describe('the smoke test verdict', (): void => {
  const run = (stdout: string, exitCode = 0, timedOut = false) => ({
    sandboxId: 'local:run-1',
    exitCode,
    stdout,
    stderr: '',
    timedOut,
  });

  it('passes exit 0 with one distinct line per representative input set', async (): Promise<void> => {
    const { verdictFor, SMOKE_TEST_INPUT_SETS } = await import('../../../src/lib/skill-sandbox');
    expect(SMOKE_TEST_INPUT_SETS).toBe(2);
    expect(verdictFor('local', run('ok OPS-3 61%\nok OPS-9 58%\n'))).toMatchObject({
      ok: true,
      backend: 'local',
    });
  });

  it('refuses a run that printed nothing, one line, or the same line twice', async (): Promise<void> => {
    const { verdictFor } = await import('../../../src/lib/skill-sandbox');
    expect(verdictFor('daytona', run('\n  \n'))).toMatchObject({
      ok: false,
      failureReason: 'smoke test exited 0 but printed nothing, so the run produced no verification signal',
    });
    for (const stdout of ['ok OPS-3 61%\n', 'ok OPS-3 61%\nok OPS-3 61%\n']) {
      expect(verdictFor('local', run(stdout))).toMatchObject({
        ok: false,
        failureReason:
          'smoke test exited 0 but printed 1 distinct line for 2 representative input sets, so the run does not show the actions following the inputs',
      });
    }
  });

  it('keeps the exit code and the time limit ahead of the output rule', async (): Promise<void> => {
    const { verdictFor } = await import('../../../src/lib/skill-sandbox');
    expect(verdictFor('local', run('a\nb\n', 1))).toMatchObject({
      ok: false,
      failureReason: 'smoke test exited 1',
    });
    expect(verdictFor('local', run('a\nb\n', 137, true))).toMatchObject({
      ok: false,
      failureReason: 'smoke test did not finish within the sandbox time limit',
    });
  });
});
