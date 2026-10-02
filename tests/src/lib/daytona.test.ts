import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Daytona half of skill verification, against a fake of the SDK at the provider seam: a
 * sandbox that takes a given number of seconds to start, and the SDK's own timeout rule (its
 * default bound is 60 seconds, and a start past the bound throws its `DaytonaTimeoutError`).
 */
const daytona = vi.hoisted(() => ({
  startSeconds: 10,
  createError: undefined as Error | undefined,
  created: [] as Array<{
    ephemeral?: boolean;
    autoStopInterval?: number;
    timeout?: number;
  }>,
  deleted: [] as string[],
  deleteError: undefined as Error | undefined,
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
      if (daytona.deleteError) throw daytona.deleteError;
      daytona.deleted.push(name);
    },
  });
  class Daytona {
    async create(
      params: { ephemeral?: boolean; autoStopInterval?: number },
      options?: { timeout?: number },
    ): Promise<ReturnType<typeof sandbox>> {
      daytona.created.push({
        ephemeral: params.ephemeral,
        autoStopInterval: params.autoStopInterval,
        timeout: options?.timeout,
      });
      if (daytona.createError) throw daytona.createError;
      const bound = options?.timeout ?? 60;
      if (daytona.startSeconds > bound) {
        throw new DaytonaTimeoutError(
          `Failed to create and start sandbox within ${bound} seconds. Operation timed out.`,
        );
      }
      return sandbox(`started-${daytona.created.length}`);
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
    daytona.deleteError = undefined;
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

  it('reports a start that does not come within the bound as never started, and leaves the sandbox to delete itself so its build goes on', async (): Promise<void> => {
    daytona.startSeconds = 600;
    const {
      authorAndVerifySkillOnDaytona,
      SANDBOX_START_TIMEOUT_SECONDS,
      SANDBOX_IDLE_STOP_MINUTES,
    } = await import('../../../src/lib/daytona');

    const run = await authorAndVerifySkillOnDaytona(ARGS);

    expect(run).toEqual({ started: false, waitedSeconds: SANDBOX_START_TIMEOUT_SECONDS });
    // Daytona was asked for a sandbox that deletes itself once it stops idling, and nothing was
    // deleted under the build the next verification waits on.
    expect(daytona.created).toEqual([
      {
        ephemeral: true,
        autoStopInterval: SANDBOX_IDLE_STOP_MINUTES,
        timeout: SANDBOX_START_TIMEOUT_SECONDS,
      },
    ]);
    expect(daytona.deleted).toEqual([]);
  });

  it('deletes the sandbox after the smoke test, and keeps the verdict when the teardown fails', async (): Promise<void> => {
    const { authorAndVerifySkillOnDaytona } = await import('../../../src/lib/daytona');

    await expect(authorAndVerifySkillOnDaytona(ARGS)).resolves.toMatchObject({ started: true });
    expect(daytona.deleted).toEqual(['started-1']);

    daytona.deleteError = new Error('Sandbox is in a transitional state');
    await expect(authorAndVerifySkillOnDaytona(ARGS)).resolves.toMatchObject({
      started: true,
      outcome: { exitCode: 0 },
    });
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
