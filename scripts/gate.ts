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
 * The build still reads the local env files from disk, as Next always does;
 * the gate names the keys it takes from them that the runner never has.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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

/**
 * The env files `next build` loads, highest precedence first; the runner has
 * none of them.
 */
export const BUILD_ENV_FILES = [
  '.env.production.local',
  '.env.local',
  '.env.production',
  '.env',
] as const;

/** One key a local env file gives the build, and the file it comes from. */
export interface EnvFileKey {
  readonly key: string;
  readonly file: string;
}

/** The names an env file assigns, `export` or not. */
function assignedKeys(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1] ?? []);
}

/** The names a command assigns inline before its program (`NAME= pnpm build`). */
function inlineKeys(run: string): string[] {
  const prefix = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/.exec(run)?.[0] ?? '';
  return [...prefix.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)].map((match) => match[1]!);
}

/**
 * What the local env files give a build step that the runner's build never
 * sees: every key they assign that neither the step's environment nor its
 * command sets, since Next never overrides a variable the process has. A
 * step that does not build reads no env file.
 *
 * @param files - Each env file's text, by name, for those that exist.
 */
export function buildEnvFileReach(
  step: GateStep,
  environment: Readonly<Record<string, string>>,
  files: Readonly<Partial<Record<string, string>>>,
): EnvFileKey[] {
  if (!/\b(?:pnpm|next) build\b/.test(step.run)) return [];
  const set = new Set([...Object.keys(environment), ...inlineKeys(step.run)]);
  const reach = new Map<string, string>();
  for (const file of BUILD_ENV_FILES) {
    const text = files[file];
    if (text === undefined) continue;
    for (const key of assignedKeys(text)) {
      if (!set.has(key) && !reach.has(key)) reach.set(key, file);
    }
  }
  return [...reach.entries()]
    .map(([key, file]) => ({ key, file }))
    .sort((a, b) => a.key.localeCompare(b.key, 'en'));
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
    const environment = gateEnvironment(process.env, step);
    const files = Object.fromEntries(
      BUILD_ENV_FILES.filter((file) => existsSync(join(root, file))).map((file) => [
        file,
        readFileSync(join(root, file), 'utf8'),
      ]),
    );
    const reach = buildEnvFileReach(step, environment, files);
    if (reach.length > 0) {
      console.error(
        `This build also reads ${reach.map(({ key, file }) => `${key} (${file})`).join(', ')}, ` +
          'which the runner never has; a build green here and red there may be one of them.',
      );
    }
    const result = spawnSync('sh', ['-c', step.run], {
      cwd: root,
      // Next declares NODE_ENV on every ProcessEnv; the runner's steps start
      // without it and each tool sets its own, so the clean one does too.
      env: environment as NodeJS.ProcessEnv,
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
