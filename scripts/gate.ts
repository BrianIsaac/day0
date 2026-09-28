/**
 * Run the gate as the runner runs it.
 *
 *   pnpm gate
 *
 * The steps are the workflow's own (`.github/workflows/gate.yml`, every `run`
 * after the install), with the job's and each step's environment, so the
 * local gate cannot drift from CI. Each step starts from a clean environment
 * holding only what locates the machine's tools: a coding agent's variables
 * (`CLAUDECODE`, `AI_AGENT` and the rest vitest reads to turn colour off) and
 * a shell's exported deployment keys never reach it, so an output-sensitive
 * test sees what the runner sees (the wave 2 red run was one that did not).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/** One command the gate runs, with the environment the workflow gives it. */
export interface GateStep {
  readonly name: string;
  readonly run: string;
  readonly env: Readonly<Record<string, string>>;
}

/** The host variables a step keeps: where the tools and the temporary directory are. */
const HOST_KEYS = ['HOME', 'PATH', 'TMPDIR'] as const;

/** The workflow's shape, as far as the gate reads it. */
interface Workflow {
  readonly jobs: {
    readonly gate: {
      readonly env?: Readonly<Record<string, string>>;
      readonly steps: readonly {
        readonly name?: string;
        readonly run?: string;
        readonly env?: Readonly<Record<string, string>>;
      }[];
    };
  };
}

/**
 * The steps the runner takes after installing dependencies.
 *
 * @throws Error when the workflow has no `pnpm install` step to start after.
 */
export function gateSteps(workflow: string): GateStep[] {
  const job = (parse(workflow) as Workflow).jobs.gate;
  const commands = job.steps.filter(
    (step): step is typeof step & { run: string } => step.run !== undefined,
  );
  const install = commands.findIndex((step) => step.run.trim().startsWith('pnpm install'));
  if (install === -1) {
    throw new Error('.github/workflows/gate.yml has no pnpm install step to run the gate after');
  }
  return commands.slice(install + 1).map((step) => ({
    name: step.name ?? step.run.trim(),
    run: step.run.trim(),
    env: { ...job.env, ...step.env },
  }));
}

/** The environment one step runs in: the host's tool locations, CI's flag and the step's own. */
export function gateEnvironment(
  host: Readonly<Record<string, string | undefined>>,
  step: GateStep,
): Record<string, string> {
  const kept = HOST_KEYS.flatMap((key) => {
    const value = host[key];
    return value === undefined ? [] : [[key, value] as const];
  });
  return { ...Object.fromEntries(kept), CI: 'true', ...step.env };
}

/** Run every step in order, stopping at the first that fails. */
function main(): number {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pinned = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  if (process.version !== `v${pinned}`) {
    console.error(
      `Node ${process.version} is not the runner's v${pinned} (.nvmrc); a difference may be the version.`,
    );
  }
  for (const step of gateSteps(readFileSync(join(root, '.github/workflows/gate.yml'), 'utf8'))) {
    console.log(`\n== ${step.name}: ${step.run}`);
    const result = spawnSync('sh', ['-c', step.run], {
      cwd: root,
      // Next declares NODE_ENV on every ProcessEnv; the runner's steps start
      // without it and each tool sets its own, so the clean one does too.
      env: gateEnvironment(process.env, step) as NodeJS.ProcessEnv,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      console.error(`gate failed at ${step.name}`);
      return result.status ?? 1;
    }
  }
  console.log('\ngate green');
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
