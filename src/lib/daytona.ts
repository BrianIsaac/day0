/// <reference types="node" />
import { Daytona } from '@daytona/sdk';
import { env } from '../env';

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

export interface SkillSandboxRun {
  sandboxId: string;
  /** Stdout from the smoke-test execution Voyager-style. */
  stdout: string;
  /** Stderr from the smoke-test execution. */
  stderr: string;
  /**
   * Whether the run produced a verification signal: exit 0 **and** something on
   * stdout. Exit code alone would pass a program that ran nothing observable,
   * and "the sandbox printed what we asked it to print" is the whole of the
   * signal this helper contributes.
   */
  ok: boolean;
  /** Why `ok` is false, for the caller's failure record. */
  failureReason?: string;
  /** True when no sandbox ran at all; `ok` carries no verification weight. */
  skipped: boolean;
  skipReason?: string;
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
 *
 * Daytona is an optional capability. With no key the run is reported as
 * skipped instead of throwing — the skill-authoring loop continues
 * unverified and the caller records the skip in the event log.
 */
export async function authorAndVerifySkill(args: AuthorSkillArgs): Promise<SkillSandboxRun> {
  if (!env.DAYTONA_API_KEY) {
    return {
      sandboxId: '(skipped)',
      stdout: '',
      stderr: '',
      ok: false,
      skipped: true,
      skipReason: 'DAYTONA_API_KEY not set',
    };
  }
  const sandbox = await daytona().create({
    image: 'python:3.12-slim',
    public: false,
  });
  try {
    const fs = sandbox.fs;
    await fs.uploadFile(Buffer.from(args.skillBody, 'utf8'), 'SKILL.md');
    await fs.uploadFile(Buffer.from(args.smokeTest, 'utf8'), 'smoke.py');
    const result = await sandbox.process.executeCommand('python smoke.py', undefined, undefined, 60);
    const stdout = result.result ?? '';
    const exitCode = result.exitCode ?? 1;
    const printedSomething = stdout.trim().length > 0;
    return {
      sandboxId: sandbox.id,
      stdout,
      stderr: '',
      ok: exitCode === 0 && printedSomething,
      ...(exitCode !== 0
        ? { failureReason: `smoke test exited ${exitCode}` }
        : printedSomething
          ? {}
          : {
              failureReason:
                'smoke test exited 0 but printed nothing, so the run produced no verification signal',
            }),
      skipped: false,
    };
  } finally {
    await sandbox.delete().catch(() => {
      /* The verification verdict is already decided; a failed teardown must
         not replace it with an error the caller cannot act on. */
    });
  }
}
