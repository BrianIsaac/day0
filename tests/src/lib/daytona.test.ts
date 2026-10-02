import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Daytona half of skill verification, against a fake of the SDK at the provider seam: a
 * sandbox that takes a given number of seconds to start, and the SDK's own timeout rule (its
 * default bound is 60 seconds, and a start past the bound throws its `DaytonaTimeoutError`).
 */
const daytona = vi.hoisted(() => ({
  startSeconds: 10,
  createError: undefined as Error | undefined,
  created: [] as Array<{ name?: string; timeout?: number }>,
  deleted: [] as string[],
  findError: undefined as Error | undefined,
}));

vi.mock('@daytona/sdk', () => {
  class DaytonaError extends Error {}
  class DaytonaTimeoutError extends DaytonaError {}
  const sandbox = (name: string) => ({
    id: `sandbox-${name}`,
    fs: { uploadFile: async (): Promise<void> => undefined },
    process: {
      executeCommand: async (): Promise<{ exitCode: number; result: string }> => ({
        exitCode: 0,
        result: 'ok OPS-3\nok OPS-9\n',
      }),
    },
    delete: async (): Promise<void> => {
      daytona.deleted.push(name);
    },
  });
  class Daytona {
    async create(
      params: { name?: string },
      options?: { timeout?: number },
    ): Promise<ReturnType<typeof sandbox>> {
      daytona.created.push({ name: params.name, timeout: options?.timeout });
      if (daytona.createError) throw daytona.createError;
      const bound = options?.timeout ?? 60;
      if (daytona.startSeconds > bound) {
        throw new DaytonaTimeoutError(
          `Failed to create and start sandbox within ${bound} seconds. Operation timed out.`,
        );
      }
      return sandbox(params.name ?? 'unnamed');
    }

    async get(name: string): Promise<ReturnType<typeof sandbox>> {
      if (daytona.findError) throw daytona.findError;
      return sandbox(name);
    }
  }
  return { Daytona, DaytonaError, DaytonaTimeoutError };
});

const ARGS = { skillName: 'kanban-comment-and-close', skillBody: '# Body', smokeTest: 'print(1)' };

describe('authorAndVerifySkillOnDaytona', (): void => {
  beforeEach((): void => {
    vi.stubEnv('DAYTONA_API_KEY', 'dtn_key');
    daytona.startSeconds = 10;
    daytona.createError = undefined;
    daytona.findError = undefined;
    daytona.created.length = 0;
    daytona.deleted.length = 0;
  });

  afterEach((): void => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('waits out a cold start longer than the SDK’s 60-second default and runs the smoke test (the v0.13.0 walk)', async (): Promise<void> => {
    daytona.startSeconds = 90;
    const { authorAndVerifySkillOnDaytona } = await import('../../../src/lib/daytona');

    const run = await authorAndVerifySkillOnDaytona(ARGS);

    expect(run).toMatchObject({
      started: true,
      outcome: { exitCode: 0, stdout: 'ok OPS-3\nok OPS-9\n' },
    });
    expect(daytona.created).toHaveLength(1);
  });

  it('reports a start that does not come within the bound as never started, and deletes the half-started sandbox by its name', async (): Promise<void> => {
    daytona.startSeconds = 600;
    const { authorAndVerifySkillOnDaytona, SANDBOX_START_TIMEOUT_SECONDS } =
      await import('../../../src/lib/daytona');

    const run = await authorAndVerifySkillOnDaytona(ARGS);

    expect(run).toEqual({ started: false, waitedSeconds: SANDBOX_START_TIMEOUT_SECONDS });
    expect(daytona.created).toHaveLength(1);
    const [{ name }] = daytona.created;
    expect(name).toMatch(/^day0-verify-/);
    expect(daytona.deleted).toEqual([name]);
  });

  it('still reports the start as never started when the half-started sandbox cannot be found to delete', async (): Promise<void> => {
    daytona.startSeconds = 600;
    daytona.findError = new Error('Sandbox not found');
    const { authorAndVerifySkillOnDaytona } = await import('../../../src/lib/daytona');

    await expect(authorAndVerifySkillOnDaytona(ARGS)).resolves.toMatchObject({ started: false });
    expect(daytona.deleted).toEqual([]);
  });

  it('lets any other failure to create a sandbox through as it was', async (): Promise<void> => {
    daytona.createError = new Error('Request failed with status code 401');
    const { authorAndVerifySkillOnDaytona } = await import('../../../src/lib/daytona');

    await expect(authorAndVerifySkillOnDaytona(ARGS)).rejects.toThrow(
      'Request failed with status code 401',
    );
    expect(daytona.deleted).toEqual([]);
  });
});
