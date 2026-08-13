/// <reference types="node" />
/**
 * The hosted half of skill verification. `src/lib/skill-sandbox.ts` owns the
 * contract and decides which backend runs; this module knows only about
 * Daytona.
 */
import { Daytona } from '@daytona/sdk';
import { env } from '../env';
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

export function isDaytonaConfigured(): boolean {
  return !!env.DAYTONA_API_KEY;
}

/** How long a smoke test may run. The local sandbox is held to the same cap. */
const TIMEOUT_SECONDS = 60;

/**
 * Spin a Daytona sandbox, drop the authored skill + a smoke test, execute the
 * smoke test, capture the output, and dispose the sandbox.
 */
export async function authorAndVerifySkillOnDaytona(
  args: AuthorSkillArgs,
): Promise<SmokeTestOutcome> {
  const sandbox = await daytona().create({
    image: 'python:3.12-slim',
    public: false,
  });
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
      sandboxId: sandbox.id,
      exitCode: result.exitCode ?? 1,
      stdout: result.result ?? '',
      stderr: '',
    };
  } finally {
    await sandbox.delete().catch(() => {
      /* The verification verdict is already decided; a failed teardown must
         not replace it with an error the caller cannot act on. */
    });
  }
}
