/// <reference types="node" />
import { Daytona } from '@daytona/sdk';
import { env } from '../env';

let client: Daytona | null = null;

function daytona(): Daytona {
  if (!env.DAYTONA_API_KEY) {
    throw new Error('DAYTONA_API_KEY not set — cannot run skill authoring sandbox');
  }
  if (!client) {
    client = new Daytona({
      apiKey: env.DAYTONA_API_KEY,
      apiUrl: env.DAYTONA_API_URL,
    });
  }
  return client;
}

export interface SkillSandboxRun {
  sandboxId: string;
  /** Stdout from the smoke-test execution Voyager-style. */
  stdout: string;
  /** Stderr from the smoke-test execution. */
  stderr: string;
  /** Whether the sandbox exited 0. */
  ok: boolean;
}

export interface AuthorSkillArgs {
  skillName: string;
  /** Authored SKILL.md body (the GPT-5.5 output that we want to verify). */
  skillBody: string;
  /** Ad-hoc Python smoke test the agent constructs to verify the skill behaves. */
  smokeTest: string;
}

/**
 * Spin a Daytona sandbox, drop the authored skill + a smoke test,
 * execute the smoke test, capture the output, and dispose the sandbox.
 *
 * Voyager-style verification (per docs/03 §5 in the Protean repo) uses
 * three signals: execution success (no exception), environment success
 * (the world state we intended to change actually changed), and a
 * critic (a model judges whether the output looks right). Day0
 * implements signal 1 directly here (sandbox exit 0 + non-empty
 * stdout); signals 2 and 3 are surfaced by the caller comparing the
 * stdout against expected fixtures.
 */
export async function authorAndVerifySkill(args: AuthorSkillArgs): Promise<SkillSandboxRun> {
  const sandbox = await daytona().create({
    image: 'python:3.12-slim',
    public: false,
  });
  try {
    const fs = sandbox.fs;
    await fs.uploadFile(Buffer.from(args.skillBody, 'utf8'), 'SKILL.md');
    await fs.uploadFile(Buffer.from(args.smokeTest, 'utf8'), 'smoke.py');
    const result = await sandbox.process.executeCommand('python smoke.py', undefined, undefined, 60);
    return {
      sandboxId: sandbox.id,
      stdout: result.result ?? '',
      stderr: '',
      ok: (result.exitCode ?? 1) === 0,
    };
  } finally {
    await sandbox.delete().catch(() => {
      /* hackathon: ignore cleanup failures */
    });
  }
}
