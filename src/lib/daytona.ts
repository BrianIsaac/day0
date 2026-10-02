/// <reference types="node" />
/**
 * The hosted half of skill verification. `src/lib/skill-sandbox.ts` owns the
 * contract and decides which backend runs; this module knows only about
 * Daytona.
 */
import { Daytona, DaytonaTimeoutError, type Sandbox } from '@daytona/sdk';
import { env } from '../env';
import { log } from './logger';
import type { AuthorSkillArgs, SmokeTestOutcome } from './skill-sandbox';

let client: Daytona | null = null;

function daytona(): Daytona {
  if (!client) {
    client = new Daytona({
      apiKey: env.DAYTONA_API_KEY,
      apiUrl: env.DAYTONA_API_URL,
    });
  }
  return client;
}

/**
 * Whether a Daytona key is present. Trimmed, so a whitespace-only value is
 * "not configured" here exactly as the deployment reports it to the
 * evaluation preflight (`convex/config.ts`); otherwise the preflight would say
 * `local` while this process tried Daytona with a blank key.
 */
export function isDaytonaConfigured(): boolean {
  return Boolean(env.DAYTONA_API_KEY?.trim());
}

/** How long a smoke test may run. The local sandbox is held to the same cap. */
const TIMEOUT_SECONDS = 60;

/**
 * How long a sandbox may take to start. The SDK's own bound is 60 seconds, and a cold start, which
 * builds the image first, takes longer: the hosted demo's first approval failed at exactly 60
 * seconds while the build went on, and Retry then started in seconds (the v0.13.0 walk). One
 * longer wait covers that start with the one sandbox it asked for, inside the ten-minute authoring
 * claim (`AUTHORING_LEASE_MS`) and a Convex action's ten minutes.
 */
export const SANDBOX_START_TIMEOUT_SECONDS = 180;

/**
 * How long a verification sandbox may sit idle before Daytona stops it, in minutes; an ephemeral
 * sandbox is deleted when it stops. A smoke test is capped at a minute, so this only ever acts on
 * a sandbox the verification gave up on: one that started after the bound passed.
 */
export const SANDBOX_IDLE_STOP_MINUTES = 5;

/** What a verification on Daytona came to: the smoke test's outcome, or a start that never came. */
export type DaytonaRun =
  | { readonly started: true; readonly outcome: SmokeTestOutcome }
  | { readonly started: false; readonly waitedSeconds: number };

/**
 * Start a sandbox for one verification, waiting up to {@link SANDBOX_START_TIMEOUT_SECONDS}. A
 * start given up on is left to Daytona: the sandbox is ephemeral and stops when idle, so it
 * deletes itself, and the image build it waits on is not cut short for the next verification.
 *
 * @returns The sandbox, or null when it did not start within the bound.
 * @throws Whatever else the SDK throws, as it threw it.
 */
async function startSandbox(): Promise<Sandbox | null> {
  try {
    return await daytona().create(
      {
        image: 'python:3.12-slim',
        public: false,
        ephemeral: true,
        autoStopInterval: SANDBOX_IDLE_STOP_MINUTES,
      },
      { timeout: SANDBOX_START_TIMEOUT_SECONDS },
    );
  } catch (err: unknown) {
    if (!(err instanceof DaytonaTimeoutError)) throw err;
    log.warn('a Daytona sandbox did not start within the bound', {
      timeoutSeconds: SANDBOX_START_TIMEOUT_SECONDS,
      reason: err.message,
    });
    return null;
  }
}

/**
 * Spin a Daytona sandbox, drop the authored skill + a smoke test, execute the
 * smoke test, capture the output, and dispose the sandbox. A sandbox that does
 * not start within the bound is reported as never started, not thrown.
 */
export async function authorAndVerifySkillOnDaytona(args: AuthorSkillArgs): Promise<DaytonaRun> {
  const sandbox = await startSandbox();
  if (sandbox === null) return { started: false, waitedSeconds: SANDBOX_START_TIMEOUT_SECONDS };
  try {
    const fs = sandbox.fs;
    await fs.uploadFile(Buffer.from(args.skillBody, 'utf8'), 'SKILL.md');
    await fs.uploadFile(Buffer.from(args.smokeTest, 'utf8'), 'smoke.py');
    const result = await sandbox.process.executeCommand(
      'python smoke.py',
      undefined,
      undefined,
      TIMEOUT_SECONDS,
    );
    return {
      started: true,
      outcome: {
        sandboxId: sandbox.id,
        exitCode: result.exitCode ?? 1,
        stdout: result.result ?? '',
        stderr: '',
      },
    };
  } finally {
    // The verdict is already decided; a failed teardown must not replace it with an error the
    // caller cannot act on, and the ephemeral sandbox deletes itself once it stops idling.
    await sandbox.delete().catch((err: unknown) => {
      log.warn('a Daytona verification sandbox could not be deleted', {
        sandboxId: sandbox.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
