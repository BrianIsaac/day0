/// <reference types="node" />
/**
 * Where an authored skill goes to be checked, and how the backend is chosen.
 *
 * A skill nothing ran is not a verified skill, so this is what stands between
 * a body the model wrote and a row the executor may call. Two backends can
 * provide that:
 *
 *   - Daytona, a hosted sandbox service, when `DAYTONA_API_KEY` is set.
 *   - The bundled local sandbox (`pnpm sandbox:up`), when it is running.
 *
 * Selection is deliberately dull: Daytona if its key is present, the local
 * sandbox if it answers, and otherwise an honest skip. A key in the
 * environment is a deliberate act and the older of the two configurations, so
 * it wins; the local sandbox is what makes the account-free route able to
 * finish the loop at all, so it is what runs when there is no key. Nothing
 * falls back from one to the other mid-run: a backend that was chosen and then
 * failed is a verification failure, not a reason to go and ask a second
 * opinion.
 */
import { authorAndVerifySkillOnDaytona, isDaytonaConfigured } from './daytona';
import { localSandboxSocketPath, runSmokeTestLocally, probeLocalSandbox } from './local-sandbox';

/** Which sandbox produced a run, or that none did. */
export type SkillSandboxBackend = 'daytona' | 'local' | 'none';

export interface SkillSandboxRun {
  /** Which backend ran it, for the caller's record and the event feed. */
  backend: SkillSandboxBackend;
  /** Names the run: a Daytona sandbox id, or `local:<run id>`. */
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

/** What a backend reports, before the shared rule decides what it means. */
export interface SmokeTestOutcome {
  sandboxId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The run hit the wall-clock cap rather than finishing. */
  timedOut?: boolean;
}

/**
 * The one place that decides whether a smoke test verified anything.
 *
 * Exit 0 with nothing on stdout used to count, and it was a real defect: a
 * smoke test that ran no assertions and printed nothing registered a skill.
 * Both backends come through here so the two can never drift apart on it.
 *
 * A run that hit the wall-clock cap is not a verification whatever else it
 * reports. The local sandbox kills such a run, so its exit code carries the
 * fact too; a backend that stops a run more gently need not, and the rule
 * should not depend on which of the two is answering.
 */
export function verdictFor(backend: SkillSandboxBackend, run: SmokeTestOutcome): SkillSandboxRun {
  const printedSomething = run.stdout.trim().length > 0;
  const ok = run.exitCode === 0 && printedSomething && !run.timedOut;
  return {
    backend,
    sandboxId: run.sandboxId,
    stdout: run.stdout,
    stderr: run.stderr,
    ok,
    ...(ok
      ? {}
      : {
          failureReason: run.timedOut
            ? `smoke test did not finish within the sandbox time limit`
            : run.exitCode !== 0
              ? `smoke test exited ${run.exitCode}`
              : 'smoke test exited 0 but printed nothing, so the run produced no verification signal',
        }),
    skipped: false,
  };
}

function skipped(reason: string): SkillSandboxRun {
  return {
    backend: 'none',
    sandboxId: '(skipped)',
    stdout: '',
    stderr: '',
    ok: false,
    skipped: true,
    skipReason: reason,
  };
}

/**
 * Run the authored skill's smoke test in whichever sandbox this machine has,
 * and report what happened.
 *
 * Voyager-style verification (per docs/03 §5 in the Protean repo) uses three
 * signals: execution success (no exception), environment success (the world
 * state we intended to change actually changed), and a critic (a model judges
 * whether the output looks right). Day0 implements signal 1 directly here
 * (sandbox exit 0 + non-empty stdout); signals 2 and 3 are surfaced by the
 * caller comparing the stdout against expected fixtures.
 *
 * Sandbox verification is an optional capability. With neither backend the run
 * is reported as skipped instead of throwing - the skill keeps its body, stays
 * visibly uncallable, and the caller records the skip in the event log.
 */
export async function authorAndVerifySkill(args: AuthorSkillArgs): Promise<SkillSandboxRun> {
  if (isDaytonaConfigured()) {
    return verdictFor('daytona', await authorAndVerifySkillOnDaytona(args));
  }

  const reachable = await probeLocalSandbox();
  if (!reachable.ok) {
    return skipped(
      `DAYTONA_API_KEY not set and the local sandbox is not running ` +
        `(${localSandboxSocketPath()}: ${reachable.reason}). ` +
        'Start it with `pnpm sandbox:up`.',
    );
  }
  return verdictFor('local', await runSmokeTestLocally(args));
}
