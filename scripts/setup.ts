/// <reference types="node" />
/**
 * One command that sets Day0 up on this machine.
 *
 *   pnpm setup:local                        ask, then do it
 *   pnpm setup:local --route key            you already have an OpenAI-compatible key
 *   pnpm setup:local --route local          no account at all: run the model here
 *   pnpm setup:local --mode real --route featherless   real mode on GLM via Featherless
 *   pnpm setup:local --mode real --route local         real mode on the bundled model
 *
 * The spelling is deliberate. Plain `pnpm setup` is pnpm's own installation
 * command, so the project script has to be called something else.
 *
 * Everything below already existed as a separate `pnpm` verb, and the README
 * prints them as a list of ten. This composes them rather than reimplementing
 * them: `dev:no-auth-key`, `convex:up`, `model:up`/`model:pull`, `sandbox:up`,
 * `redactor:up`, the admin-key generator inside the backend container,
 * `sync:env`, `npx convex dev --once`, `convex:restart` and `check:setup`, in
 * the order the README's "six things about that sequence are load-bearing"
 * requires. What it adds is the part a reader cannot get from a list: the
 * prerequisites checked before anything starts, the two model addresses written
 * as a pair so the afternoon-costing trap cannot be sprung, the generated admin
 * key written into the file instead of pasted, one explicit Compose project and
 * host ports used by every child process, and a refusal to point any of it at
 * a cloud deployment or at another checkout's data.
 *
 * Real mode (`--mode real`) is the same sequence with the real-mode values
 * written (`DAY0_SURFACE_MODE`, the documentation mount, the browser and
 * redaction component addresses), the three demo profiles and the two
 * components started, and two traps closed that the hand sequence sprang this
 * week: a hand-made env file with no `DAY0_DOCS_HOST_DIR` line, and a redactor
 * venv warmed on the CPU being emptied by a GPU start.
 *
 * It is local-only and it says so: it refuses to run inside a hosted build, it
 * refuses an inherited cloud selector or deploy key, and it never removes a
 * volume or resets anything as a way of recovering from a failed step. The one
 * removal it makes is the one asked for by name: `--reset`.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DOCS_HOST_DIR } from '../src/docs/host-dir';
import { FIRST_SUCCESS } from '../src/setup/quickstart';
import { composeArguments, PROFILES } from './compose';
import { writePrivateEnv } from './private-env';
import { PROTECTED_PROJECTS, PROTECTED_VOLUMES, upsertEnvText } from './demo-bed';
import {
  redactorGpuDecision,
  requirementsDigests,
  venvDevice,
  venvStampCommand,
  type GpuChoice,
  type RedactorGpuDecision,
  type VenvDevice,
} from './redactor-device';
import { pinnedNodeImage, redactorVolumeClone, REDACTOR_VOLUME_SUFFIXES } from './rehearsal/docker';

const ENV_FILE = '.env.local';
const ENV_EXAMPLE = '.env.example';

/** The port `pnpm dev` serves the app on unless `DAY0_APP_PORT` says otherwise. */
const APP_PORT = 3000;

/** The container ports the compose file publishes from, whatever the host uses. */
const CONTAINER_BACKEND_PORT = 3210;
const CONTAINER_MODEL_PORT = 11434;

/** Minimum tool versions, matching `engines` in package.json. */
export const REQUIRED_NODE_MAJOR = 22;
export const REQUIRED_PNPM_MAJOR = 9;
export const REQUIRED_COMPOSE_MAJOR = 2;

/** Mock is the seeded office; real is the reader's own documentation and systems. */
export type SetupMode = 'mock' | 'real';

/** Which of the four model setups this installation uses. */
export type SetupRoute = 'key' | 'local' | 'endpoint' | 'featherless';

/** What verifies an authored skill: the bundled networkless container, or Daytona. */
export type SandboxChoice = 'local' | 'daytona';

export type { GpuChoice } from './redactor-device';

/** Every host port this installation publishes, and the one `pnpm dev` serves on. */
export interface SetupPorts {
  backend: number;
  site: number;
  dashboard: number;
  model: number;
  app: number;
}

/** The ports `.env.example` ships, used when neither a flag nor the file says. */
export const DEFAULT_PORTS: SetupPorts = {
  backend: 3210,
  site: 3211,
  dashboard: 6791,
  model: 11434,
  app: APP_PORT,
};

/**
 * The GLM route through Featherless, as the 12 September probe settled it:
 * `json_object` comes back empty and `json_schema` "busy" there, so JSON mode
 * is pinned to prompt injection; the completion budget and low effort are what
 * the charter call needs to finish.
 */
export const FEATHERLESS_SETTINGS: Readonly<Record<string, string>> = {
  OPENAI_BASE_URL: 'https://api.featherless.ai/v1',
  OPENAI_MODEL: 'zai-org/GLM-5.3-Flash',
  OPENAI_JSON_MODE: 'prompt',
  OPENAI_MAX_OUTPUT_TOKENS: '32768',
  OPENAI_REASONING_EFFORT: 'low',
};

/** The optional components real mode starts on top of `real`, `sandbox` and `redactor`. */
export const REAL_MODE_PROFILES: readonly string[] = ['docs-notion', 'browser', 'demo'];

/** Where the backend reaches the two components real mode starts. */
export const BROWSER_MCP_URL = 'http://playwright-mcp:8931/mcp';
export const REDACTOR_URL = 'http://redactor:8000';

export interface SetupOptions {
  /** Mock (the seeded office) or real (the reader's own systems). */
  mode: SetupMode;
  /** Chosen route, or undefined to ask. */
  route?: SetupRoute;
  /** Compose project name, or undefined to take the file's, then the directory's. */
  project?: string;
  /** Host ports named on the command line; the rest come from the file. */
  ports: Partial<SetupPorts>;
  /** Model id for the bundled route, or undefined to choose from free VRAM. */
  model?: string;
  /** An OpenAI-compatible endpoint for the advanced route. */
  endpoint?: string;
  /** Documentation directory for the read-only mount, real mode only. */
  docs?: string;
  /** The GPU question for the bundled model and the redactor. */
  gpu: GpuChoice;
  /** A compose project whose redactor volumes are copied into this one. */
  warmFrom?: string;
  /** What verifies authored skills in real mode. */
  sandbox: SandboxChoice;
  /** The manager's address, stored on the agent at deploy in real mode. */
  bossEmail?: string;
  /** Print the plan of commands and write nothing. */
  dryRun: boolean;
  /** Take the project down, volumes included, before setting it up. */
  reset: boolean;
  /** Take the default answer to every question that has one. */
  assumeYes: boolean;
  /** Print usage and do nothing. */
  help: boolean;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Values layered on top of this process's environment for the child. */
  env?: Record<string, string>;
  /** Stream the child's output rather than capturing it. */
  inherit?: boolean;
  timeoutMs?: number;
}

/**
 * Everything the helper does to the machine, in one injectable place.
 *
 * The tests hand it a fake, which is what lets the whole sequence be exercised
 * in a temporary directory without a container, a port or a pull.
 */
export interface SetupIo {
  /** Repository root the helper runs in. */
  readonly cwd: string;
  /** The process environment, read for inherited cloud settings. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  run(command: string, args: readonly string[], options?: RunOptions): RunResult;
  ask(question: string, options?: { hidden?: boolean }): Promise<string>;
  log(line: string): void;
  portFree(port: number): Promise<boolean>;
  waitForBackend(port: number, timeoutMs?: number): Promise<string | undefined>;
  /** Pause between polls; a test hands in one that returns at once. */
  sleep?(ms: number): Promise<void>;
  /** The clock the polls are measured against; a test hands in its own. */
  now?(): number;
}

/** The reader stopped at a prompt. Nothing is undone; nothing was reset. */
export class SetupCancelled extends Error {}

const USAGE = `Usage: pnpm setup:local [options]

  --mode <mock|real>            the seeded office (default), or your own systems
  --route <key|local|featherless|endpoint>
                                how this installation reaches a model:
                                  key          an OpenAI-compatible key you have
                                  local        the bundled model, no account
                                  featherless  GLM 5.3 Flash through Featherless
                                  endpoint     an endpoint you already run
  --project <name>              Compose project name for this installation
  --port <n>                    host port for the backend (default ${DEFAULT_PORTS.backend})
  --site-port <n>               host port for HTTP actions (default ${DEFAULT_PORTS.site})
  --dashboard-port <n>          host port for the Convex dashboard (default ${DEFAULT_PORTS.dashboard})
  --model-port <n>              host port for the bundled model (default ${DEFAULT_PORTS.model})
  --app-port <n>                port \`pnpm dev\` serves on (default ${DEFAULT_PORTS.app})
  --model <id>                  model to pull on the bundled route
  --endpoint <url>              OpenAI-compatible endpoint for the advanced route
  --docs <dir>                  real mode: your documentation folder (default ${DEFAULT_DOCS_HOST_DIR})
  --gpu <auto|on|off>           the bundled model and the redactor on the GPU (default auto)
  --warm-from <project>         real mode: copy that project's redactor volumes, no download
  --sandbox <local|daytona>     real mode: what verifies authored skills (default local)
  --boss-email <address>        real mode: the manager's address, stored on the agent at deploy
  --dry-run                     print the plan of commands and write nothing
  --reset                       take this project down, volumes included, first
  --yes                         take the default answer wherever there is one
  --help                        print this

Real mode, one command:
  ./setup-real.sh --route featherless     GLM through Featherless; the key is asked for
  ./setup-real.sh --route local           the bundled model, on the GPU where there is one

The Convex-cloud-plus-Clerk route is not automated here; it needs accounts and
a dashboard task. README.md has it, linked from the end of a successful run.`;

/**
 * Read the command line.
 *
 * Args:
 *   argv: Arguments after the script name.
 *
 * Returns:
 *   The chosen options; every field the reader did not choose is undefined.
 *
 * Raises:
 *   Error: If a flag is unknown, or its value is not one this helper has.
 */
export function parseSetupArguments(argv: readonly string[]): SetupOptions {
  const options: SetupOptions = {
    mode: 'mock',
    ports: {},
    gpu: 'auto',
    sandbox: 'local',
    dryRun: false,
    reset: false,
    assumeYes: false,
    help: false,
  };
  const portFlags: Readonly<Record<string, keyof SetupPorts>> = {
    '--port': 'backend',
    '--site-port': 'site',
    '--dashboard-port': 'dashboard',
    '--model-port': 'model',
    '--app-port': 'app',
  };
  const oneOf = <T extends string>(flag: string, value: string, allowed: readonly T[]): T => {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new Error(`${flag} "${value}" is not one of: ${allowed.join(', ')}.`);
    }
    return value as T;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const take = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${argument} needs a value.`);
      }
      index += 1;
      return value;
    };
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--yes' || argument === '-y') {
      options.assumeYes = true;
    } else if (argument === '--dry-run') {
      options.dryRun = true;
    } else if (argument === '--reset') {
      options.reset = true;
    } else if (argument === '--mode') {
      options.mode = oneOf('--mode', take(), ['mock', 'real'] as const);
    } else if (argument === '--route') {
      options.route = oneOf('--route', take(), ['key', 'local', 'featherless', 'endpoint'] as const);
    } else if (argument === '--gpu') {
      options.gpu = oneOf('--gpu', take(), ['auto', 'on', 'off'] as const);
    } else if (argument === '--sandbox') {
      options.sandbox = oneOf('--sandbox', take(), ['local', 'daytona'] as const);
    } else if (argument === '--project') {
      options.project = take();
    } else if (argument === '--model') {
      options.model = take();
    } else if (argument === '--endpoint') {
      options.endpoint = take();
    } else if (argument === '--docs') {
      options.docs = take();
    } else if (argument === '--warm-from') {
      options.warmFrom = take();
    } else if (argument === '--boss-email') {
      options.bossEmail = take();
    } else if (argument in portFlags) {
      const value = take();
      const port = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`${argument} "${value}" is not a host port.`);
      }
      options.ports[portFlags[argument]] = port;
    } else if (argument === '--') {
      continue;
    } else {
      throw new Error(`Unknown option "${argument}". Run \`pnpm setup:local --help\`.`);
    }
  }
  return options;
}

/**
 * The major version out of whatever a tool prints for `--version`.
 *
 * Args:
 *   text: The tool's output.
 *
 * Returns:
 *   The major version, or undefined when the text carries no version at all.
 */
export function majorVersion(text: string | undefined): number | undefined {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? '');
  return match ? Number.parseInt(match[1], 10) : undefined;
}

export interface PrerequisiteResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  /** False for a state worth saying out loud that does not stop the setup. */
  blocking: boolean;
}

export interface PrerequisiteObservations {
  /** What `node --version` printed, or undefined when it could not be run. */
  node?: string;
  pnpm?: string;
  docker?: string;
  compose?: string;
  ports: readonly {
    name: string;
    port: number;
    free: boolean;
    blocking?: boolean;
    fix?: string;
  }[];
}

/**
 * Say whether this machine can run the stack, naming what is missing.
 *
 * Args:
 *   observed: What each probe found.
 *
 * Returns:
 *   One result per prerequisite, in the order to print them.
 */
export function prerequisiteReport(observed: PrerequisiteObservations): PrerequisiteResult[] {
  const results: PrerequisiteResult[] = [];
  const node = majorVersion(observed.node);
  results.push({
    blocking: true,
    name: 'Node',
    ok: node !== undefined && node >= REQUIRED_NODE_MAJOR,
    detail:
      node === undefined
        ? 'not on the path'
        : `${observed.node?.trim()} (this project needs ${REQUIRED_NODE_MAJOR} or newer)`,
    fix: 'Install Node 22 LTS from nodejs.org, or `nvm install 22 && nvm use 22`.',
  });
  const pnpm = majorVersion(observed.pnpm);
  results.push({
    blocking: true,
    name: 'pnpm',
    ok: pnpm !== undefined && pnpm >= REQUIRED_PNPM_MAJOR,
    detail:
      pnpm === undefined
        ? 'not on the path'
        : `${observed.pnpm?.trim()} (this project needs ${REQUIRED_PNPM_MAJOR} or newer)`,
    fix: 'Run `corepack enable && corepack prepare pnpm@9 --activate`.',
  });
  results.push({
    blocking: true,
    name: 'Docker',
    ok: observed.docker !== undefined,
    detail: observed.docker?.trim() ?? 'the daemon did not answer',
    fix: 'Start Docker Desktop, or the `docker` service, and try again.',
  });
  const compose = majorVersion(observed.compose);
  results.push({
    blocking: true,
    name: 'Compose v2',
    ok: compose !== undefined && compose >= REQUIRED_COMPOSE_MAJOR,
    detail: observed.compose?.trim() ?? '`docker compose version` did not answer',
    fix: 'Compose v2 ships with current Docker; `docker-compose` v1 is not enough.',
  });
  for (const port of observed.ports) {
    results.push({
      blocking: port.blocking ?? true,
      name: `${port.name} ${port.port}`,
      ok: port.free,
      detail: port.free ? 'free' : 'already in use on this machine',
      fix:
        port.fix ??
        `Move it: \`pnpm setup:local --port <n>\` (or --site-port, --dashboard-port, --model-port), or stop whatever holds ${port.port}.`,
    });
  }
  return results;
}

/**
 * Refuse to run as part of somebody's hosted build.
 *
 * Args:
 *   environment: The process environment.
 *
 * Returns:
 *   The refusal, or undefined when this is an ordinary machine.
 */
export function buildEnvironmentRefusal(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const marker = ['VERCEL', 'VERCEL_ENV', 'NOW_BUILDER'].find(
    (name: string): boolean => (environment[name] ?? '') !== '',
  );
  if (!marker) return undefined;
  return (
    `${marker} is set, so this looks like a Vercel build. This helper sets up a ` +
    'backend, a sandbox and a private env file on a developer machine; it is not ' +
    'part of building the app. Remove it from the build command.'
  );
}

export interface TargetRefusal {
  setting: string;
  reason: string;
  fix: string;
}

/** Loopback from the host is nothing at all from inside a container. */
function isLoopback(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);
}

/**
 * Refuse every target that is not a backend on this machine.
 *
 * Args:
 *   values: What `.env.local` declares today.
 *   environment: The process environment, which may carry an inherited selector.
 *
 * Returns:
 *   One refusal per offending setting; empty when the target is local.
 */
export function localTargetRefusals(
  values: Readonly<Record<string, string>>,
  environment: Readonly<Record<string, string | undefined>>,
): TargetRefusal[] {
  const refusals: TargetRefusal[] = [];
  const both = (name: string): string => (environment[name] ?? values[name] ?? '').trim();

  if (both('CONVEX_DEPLOYMENT') !== '') {
    refusals.push({
      setting: 'CONVEX_DEPLOYMENT',
      reason: `it selects the Convex cloud deployment "${both('CONVEX_DEPLOYMENT')}"`,
      fix: `Clear CONVEX_DEPLOYMENT in ${ENV_FILE} (and in your shell) before running this. A self-hosted backend uses CONVEX_SELF_HOSTED_URL instead, and setting both is refused by \`pnpm check:setup\` as well.`,
    });
  }
  for (const name of ['CONVEX_DEPLOY_KEY', 'CONVEX_ADMIN_KEY']) {
    if (both(name) !== '') {
      refusals.push({
        setting: name,
        reason: 'it is a deploy key for a deployment this helper did not start',
        fix: `Clear ${name} in ${ENV_FILE} and unset it in your shell. This helper writes the admin key of the backend it starts here, and nothing else.`,
      });
    }
  }
  for (const name of ['CONVEX_SELF_HOSTED_URL', 'NEXT_PUBLIC_CONVEX_URL', 'CONVEX_URL']) {
    const url = both(name);
    if (url !== '' && !isLoopback(url)) {
      refusals.push({
        setting: name,
        reason: `it points at ${url}, which is not a backend on this machine`,
        fix: `Point ${name} at http://127.0.0.1:<port> in ${ENV_FILE}, or clear it and let this helper write it. Nothing here is allowed to write to a remote backend.`,
      });
    }
  }
  return refusals;
}

/**
 * The two volumes a Compose project owns.
 *
 * Args:
 *   project: Compose project name.
 *
 * Returns:
 *   The data volume and the sandbox socket volume.
 */
export function projectVolumes(project: string): string[] {
  return [`${project}_convex_data`, `${project}_sandbox_socket`];
}

export interface CheckoutClaim {
  /** Whether this checkout is a git main worktree rather than a linked one or a copy. */
  mainWorktree: boolean;
  /** The project `.env.local` in this checkout names. */
  fileProject: string;
}

/**
 * Refuse a project or volume that holds a real run.
 *
 * The protected names are the operator's own stacks. The one checkout allowed
 * to set them up is the primary: the git main worktree whose own `.env.local`
 * already names the project. A linked worktree, a copy with a borrowed env file
 * or a fresh clone that merely sits in a directory called `day0` is refused,
 * and the ownership checks that follow (the volume, the containers' working
 * directory, `DAY0_SETUP_ROOT`) still apply to the primary.
 *
 * Args:
 *   project: Compose project name the reader asked for.
 *   claim: What this checkout is and what its env file names; omitted means
 *     no exception.
 *
 * Raises:
 *   Error: If the name, or either volume it implies, is protected and this is
 *     not the primary checkout.
 */
export function assertLocalProject(project: string, claim?: CheckoutClaim): void {
  const clash = [project, ...projectVolumes(project)].find(
    (name: string): boolean =>
      PROTECTED_PROJECTS.includes(name) || PROTECTED_VOLUMES.includes(name),
  );
  if (clash === undefined) return;
  if (claim?.mainWorktree === true && claim.fileProject.trim() === project) return;
  throw new Error(
    `"${project}" would use ${projectVolumes(project).join(' and ')}, and ${clash} is ` +
      'protected: it holds a real run. This helper never starts, writes to or removes it from anywhere but the ' +
      `primary checkout, whose own ${ENV_FILE} names it. Choose another name: ` +
      '`pnpm setup:local --project <name>`.',
  );
}

/**
 * Whether a checkout is a git main worktree.
 *
 * A linked worktree carries a `.git` *file* pointing at the main repository;
 * only the main worktree has the `.git` directory itself.
 *
 * Args:
 *   root: Checkout root.
 *
 * Returns:
 *   True for a main worktree, false for a linked one or no repository.
 */
export function isMainWorktree(root: string): boolean {
  try {
    return statSync(join(root, '.git')).isDirectory();
  } catch {
    return false;
  }
}

/** What to do about a Compose project that already has data. */
export type AttachmentDecision = 'fresh' | 'rerun' | 'refuse';

/**
 * Decide whether this is a new installation, a rerun, or somebody else's data.
 *
 * Args:
 *   args.project: Compose project name for this run.
 *   args.existingVolumes: Volumes Docker already has.
 *   args.fileProject: The project `.env.local` already names, if any.
 *
 * Returns:
 *   `fresh` for a new installation, `rerun` when this checkout already owns the
 *   volume, and `refuse` when the volume exists but this checkout never claimed
 *   it.
 */
export function attachmentDecision(args: {
  project: string;
  existingVolumes: readonly string[];
  fileProject: string;
}): AttachmentDecision {
  const owned = projectVolumes(args.project);
  const exists = owned.some((volume: string): boolean => args.existingVolumes.includes(volume));
  if (!exists) return 'fresh';
  return args.fileProject.trim() === args.project ? 'rerun' : 'refuse';
}

export interface ModelAddresses {
  OPENAI_BASE_URL: string;
  CONVEX_OPENAI_BASE_URL: string;
}

/**
 * The address Next dials and the address the backend container dials.
 *
 * The README calls getting this wrong "the one that costs an afternoon": the
 * Day-1 chat streams from Next on this machine, and the charter is synthesised
 * by a Convex Node action inside the backend container, where a loopback
 * address means the container itself. So they are written as a pair or not at
 * all. A loopback endpoint the reader gave us is rewritten to the same port on
 * `host.docker.internal`, never to the bundled model service: an arbitrary
 * server on 8080 is not Ollama on 11434.
 *
 * Args:
 *   route: The chosen route.
 *   options.modelPort: Host port the bundled model service publishes.
 *   options.endpoint: The reader's own endpoint, on the advanced route.
 *
 * Returns:
 *   Both addresses. Empty pairs mean api.openai.com, which both sides reach;
 *   Featherless is likewise one hosted address both sides reach.
 */
export function modelAddresses(
  route: SetupRoute,
  options: { modelPort: number; endpoint?: string },
): ModelAddresses {
  if (route === 'key') return { OPENAI_BASE_URL: '', CONVEX_OPENAI_BASE_URL: '' };
  if (route === 'featherless') {
    return {
      OPENAI_BASE_URL: FEATHERLESS_SETTINGS.OPENAI_BASE_URL,
      CONVEX_OPENAI_BASE_URL: FEATHERLESS_SETTINGS.OPENAI_BASE_URL,
    };
  }
  if (route === 'local') {
    return {
      OPENAI_BASE_URL: `http://127.0.0.1:${options.modelPort}/v1`,
      CONVEX_OPENAI_BASE_URL: `http://model:${CONTAINER_MODEL_PORT}/v1`,
    };
  }
  const endpoint = (options.endpoint ?? '').trim();
  if (endpoint === '') throw new Error('The advanced route needs --endpoint <url>.');
  if (!isLoopback(endpoint)) {
    return { OPENAI_BASE_URL: endpoint, CONVEX_OPENAI_BASE_URL: endpoint };
  }
  const parsed = new URL(endpoint);
  const port = parsed.port === '' ? '' : `:${parsed.port}`;
  return {
    OPENAI_BASE_URL: endpoint,
    CONVEX_OPENAI_BASE_URL: `${parsed.protocol}//host.docker.internal${port}${parsed.pathname.replace(/\/$/, '')}`,
  };
}

/**
 * Free VRAM in MiB, from `nvidia-smi --query-gpu=memory.free`.
 *
 * `scripts/model-up.ts:107` asks `nvidia-smi -L` whether a driver exists at
 * all; it reads no memory figure, so the query is made here rather than reused.
 * The largest card is what matters: the model loads onto one of them.
 *
 * Args:
 *   stdout: What the query printed, one card per line.
 *
 * Returns:
 *   Free MiB on the roomiest card, or undefined when there is no answer.
 */
export function parseFreeVram(stdout: string): number | undefined {
  const values = stdout
    .split('\n')
    .map((line: string): number => Number.parseInt(line.trim(), 10))
    .filter((value: number): boolean => Number.isSafeInteger(value) && value >= 0);
  return values.length === 0 ? undefined : Math.max(...values);
}

export interface LocalModelChoice {
  model: string;
  downloadLabel: string;
  residentLabel: string;
  reason: string;
}

/** Free VRAM, in MiB, below which the smaller model is the right default. */
export const SMALLER_MODEL_BELOW_MIB = 8192;

/**
 * Pick a bundled model that fits what is free on this machine right now.
 *
 * Spilling is a question of free VRAM rather than the model's size on paper,
 * and the symptom is the same one the two-addresses mistake gives: a 1:1 that
 * runs perfectly and a charter that never arrives.
 *
 * Args:
 *   freeVramMiB: Free VRAM on the roomiest card, or undefined for no GPU.
 *
 * Returns:
 *   The model to pull, its download size and why it was chosen.
 */
export function chooseLocalModel(freeVramMiB: number | undefined): LocalModelChoice {
  if (freeVramMiB === undefined) {
    return {
      model: 'qwen3:4b',
      downloadLabel: 'about 2.5 GB',
      residentLabel: 'about 3 GB resident',
      reason:
        'no NVIDIA driver answered, so this will run on the CPU. The loop finishes; ' +
        'it answers in minutes rather than seconds.',
    };
  }
  if (freeVramMiB < SMALLER_MODEL_BELOW_MIB) {
    return {
      model: 'qwen3:4b',
      downloadLabel: 'about 2.5 GB',
      residentLabel: 'about 3 GB resident',
      reason: `${freeVramMiB} MiB free on the GPU. qwen3:8b needs about 6 GB resident and would land half on the CPU.`,
    };
  }
  return {
    model: 'qwen3:8b',
    downloadLabel: 'about 5 GB',
    residentLabel: 'about 6 GB resident',
    reason: `${freeVramMiB} MiB free on the GPU, which fits it whole.`,
  };
}

export interface EnvPlanInput {
  route: SetupRoute;
  project: string;
  ports: SetupPorts;
  existing: Readonly<Record<string, string>>;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  /** Mock unless said otherwise, so the mock path writes exactly what it always did. */
  mode?: SetupMode;
  /** Written only when the reader named the app port, or the file already has one. */
  appPortSelected?: boolean;
  /** Real mode: the documentation directory, as the reader gave it. */
  docsHostDir?: string;
  /** Real mode: what verifies authored skills. */
  sandbox?: SandboxChoice;
  /** Real mode: the manager's address, when known. */
  bossEmail?: string;
  /** An explicit GPU choice is written; `auto` leaves the file's own value. */
  gpu?: GpuChoice;
}

/**
 * The values this installation needs, and only those.
 *
 * Settings that describe this installation (its project, its ports, its two
 * model addresses, and in real mode the surface mode, the documentation mount
 * and the two component addresses) are written every time, because they are
 * what the reader selected. Everything else is written only when the file has
 * nothing to say, so a rerun preserves what the reader changed by hand.
 *
 * The Featherless route writes its five settings every time: the key came in
 * through a hidden prompt or the environment and belongs to that base URL, and
 * a model, JSON mode, budget and effort left over from another route are what
 * the 12 September probe found returning nothing.
 *
 * Args:
 *   input: Route, project, ports, the file as it stands and any answers given.
 *
 * Returns:
 *   Names and values to write; an already-correct value is left out entirely.
 */
export function setupEnvUpdates(input: EnvPlanInput): Record<string, string> {
  const { backend, site, dashboard, model, app } = input.ports;
  const mode = input.mode ?? 'mock';
  const addresses = modelAddresses(input.route, { modelPort: model, endpoint: input.endpoint });
  const selected: Record<string, string> = {
    COMPOSE_PROJECT_NAME: input.project,
    CONVEX_PORT: String(backend),
    CONVEX_SITE_PROXY_PORT: String(site),
    CONVEX_DASHBOARD_PORT: String(dashboard),
    NEXT_PUBLIC_CONVEX_URL: `http://127.0.0.1:${backend}`,
    NEXT_PUBLIC_CONVEX_SITE_URL: `http://127.0.0.1:${site}`,
    CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${backend}`,
    NEXT_PUBLIC_DEV_NO_AUTH: 'true',
    OPENAI_BASE_URL: addresses.OPENAI_BASE_URL,
    CONVEX_OPENAI_BASE_URL: addresses.CONVEX_OPENAI_BASE_URL,
  };
  if (input.route === 'local') selected.MODEL_PORT = String(model);
  if (input.appPortSelected || (input.existing.DAY0_APP_PORT ?? '') !== '') {
    selected.DAY0_APP_PORT = String(app);
  }

  const whenMissing: Record<string, string> = {
    CONVEX_BIND_ADDR: '127.0.0.1',
    DAY0_SURFACE_MODE: 'mock',
  };
  if (input.route === 'featherless') {
    Object.assign(selected, FEATHERLESS_SETTINGS);
    if (input.apiKey) selected.OPENAI_API_KEY = input.apiKey;
  } else if (input.apiKey) {
    whenMissing.OPENAI_API_KEY = input.apiKey;
  }
  if (input.model) selected.OPENAI_MODEL = input.model;
  if (input.gpu !== undefined && input.gpu !== 'auto') selected.MODEL_GPU = input.gpu;

  if (mode === 'real') {
    selected.DAY0_SURFACE_MODE = 'real';
    selected.DAY0_DOCS_HOST_DIR = input.docsHostDir ?? DEFAULT_DOCS_HOST_DIR;
    selected.DAY0_BROWSER_MCP_URL = BROWSER_MCP_URL;
    selected.DAY0_REDACTOR_URL = REDACTOR_URL;
    whenMissing.DAY0_DOCS_ROOT = '/docs';
    if ((input.sandbox ?? 'local') === 'local') selected.DAYTONA_API_KEY = '';
    if (input.bossEmail) selected.NEXT_PUBLIC_DEMO_BOSS_EMAIL = input.bossEmail;
  }

  const updates: Record<string, string> = { ...selected };
  for (const [name, value] of Object.entries(whenMissing)) {
    if (!(name in selected) && (input.existing[name] ?? '') === '') updates[name] = value;
  }
  for (const name of Object.keys(updates)) {
    if (input.existing[name] === updates[name]) delete updates[name];
  }
  return updates;
}

export interface SequenceInput {
  mode?: SetupMode;
  /** Real mode: whether a warm project's redactor volumes are copied first. */
  warm?: boolean;
  /** Real mode: Daytona verifies skills, so the bundled sandbox is not started. */
  sandbox?: SandboxChoice;
  /** Whether the project is taken down first. */
  reset?: boolean;
}

/**
 * The helpers this route runs, in the order the README calls load-bearing.
 *
 * Real mode adds the redactor after the sandbox, the warm volume copy before
 * the first `up` (a volume compose has already created is empty, and the
 * component's first start would fill it by downloading), and `reset` before
 * everything when asked for.
 *
 * Args:
 *   route: The chosen route.
 *   input: Mode and the real-mode choices; mock when omitted.
 *
 * Returns:
 *   Step names, in order.
 */
export function sequenceSteps(route: SetupRoute, input: SequenceInput = {}): string[] {
  const real = (input.mode ?? 'mock') === 'real';
  return [
    ...(input.reset ? ['reset'] : []),
    'dev:no-auth-key',
    ...(real && input.warm ? ['warm-redactor'] : []),
    'convex:up',
    ...(route === 'local' ? ['model:up', 'model:pull'] : []),
    ...(real && input.sandbox === 'daytona' ? [] : ['sandbox:up']),
    ...(real ? ['redactor:up'] : []),
    'admin-key',
    'sync:env',
    'convex dev --once',
    'convex:restart',
    'check:setup',
  ];
}

/** The profiles `pnpm convex:up` is handed, as arguments. */
export function profileArguments(profiles: readonly string[]): string[] {
  return profiles.flatMap((profile: string): string[] => ['--profile', profile]);
}

/**
 * `docker compose` arguments that take a whole project down, volumes included.
 *
 * Every profile the compose file defines is named, so the network can be
 * removed: compose refuses while a container from an unnamed profile is still
 * attached to it.
 *
 * Args:
 *   envFile: The env file compose reads.
 *
 * Returns:
 *   Arguments to pass to `docker`.
 */
export function resetArguments(envFile: string = ENV_FILE): string[] {
  const profiles = Object.keys(PROFILES).filter((name: string): boolean => name !== 'real');
  return composeArguments([...profileArguments(profiles), 'down', '-v', '--remove-orphans'], envFile);
}

/**
 * The admin key out of what the backend's generator printed.
 *
 * Args:
 *   stdout: The generator's output.
 *
 * Returns:
 *   The key, or undefined when the generator printed none.
 */
export function parseAdminKey(stdout: string): string | undefined {
  return stdout
    .split('\n')
    .map((line: string): string => line.trim())
    .filter((line: string): boolean => line.includes('|'))
    .pop();
}

/**
 * Whether a new admin key has to be taken from the backend container.
 *
 * `generate_admin_key.sh` mints a *new* key every time it is called, and every
 * key it has ever minted for that volume keeps working. Calling it on a rerun
 * therefore rotates the line in `.env.local` for no reason, which is exactly
 * what this helper promises not to do. So the key already in the file is kept
 * whenever the backend still accepts it.
 *
 * Args:
 *   existing: The key `.env.local` already holds.
 *   accepted: Whether the backend answered an admin call made with it.
 *
 * Returns:
 *   True when the generator has to be run.
 */
export function shouldCaptureAdminKey(existing: string, accepted: boolean): boolean {
  return !existing.includes('|') || !accepted;
}

/** The half of an admin key that is safe to print: its instance name. */
export function adminKeyPrefix(key: string): string {
  return `${key.split('|')[0]}|...`;
}

/**
 * Prove the URL, the admin key and the Compose service are one backend.
 *
 * `pnpm sync:env` and `npx convex dev --once` both write to whatever the URL
 * and key resolve to, so this runs before either of them. A key belongs to a
 * data volume rather than to a project, and a URL is just a port, so the check
 * that matters is that Compose publishes this project's backend on exactly the
 * port the file names.
 *
 * Args:
 *   args.url: CONVEX_SELF_HOSTED_URL as the file now holds it.
 *   args.adminKey: The key captured from the container.
 *   args.publishedAddress: What `docker compose port backend` answered.
 *   args.services: Services Docker reports for this project.
 *
 * Returns:
 *   The refusal, or undefined when all three agree.
 */
export function backendIdentityRefusal(args: {
  url: string;
  adminKey: string;
  publishedAddress: string | undefined;
  services: readonly string[] | undefined;
}): string | undefined {
  if (args.services === undefined) {
    return 'Docker did not answer when asked which services this project is running, so the backend about to be written to cannot be identified.';
  }
  if (!args.services.includes('backend')) {
    return 'this Compose project is not running a backend service, so there is nothing local for the URL and admin key to refer to.';
  }
  if (args.url === '' || !isLoopback(args.url)) {
    return `CONVEX_SELF_HOSTED_URL is "${args.url}", which is not a backend on this machine.`;
  }
  if (!args.adminKey.includes('|')) {
    return 'the admin key captured from the backend container is not a key, so nothing can be pushed with it.';
  }
  if (args.publishedAddress === undefined) {
    return 'Compose could not say which host port this project publishes the backend on, so the URL cannot be matched to it.';
  }
  const published = args.publishedAddress.trim().split(':').pop();
  const wanted = new URL(args.url).port || String(CONTAINER_BACKEND_PORT);
  if (published !== wanted) {
    return `CONVEX_SELF_HOSTED_URL names port ${wanted} and this Compose project publishes the backend on ${published}. Those are two different backends.`;
  }
  return undefined;
}

/**
 * Put back the host addresses the Convex CLI replaced during a push.
 *
 * `npx convex dev --once` writes its own `NEXT_PUBLIC_CONVEX_URL` and
 * `NEXT_PUBLIC_CONVEX_SITE_URL` lines, and a self-hosted backend answers with
 * its *container* ports, so a stack published on 46210/46211 ends the push
 * declaring 3211. Nothing in day0 reads the site URL, which is why this is
 * silent rather than broken, but the file is what a reader believes.
 *
 * Args:
 *   values: The env file after the push.
 *   ports: The host ports this installation publishes.
 *
 * Returns:
 *   The addresses to put back; empty when the CLI left them alone.
 */
export function publicUrlCorrections(
  values: Readonly<Record<string, string>>,
  ports: SetupPorts,
): Record<string, string> {
  const wanted: Record<string, string> = {
    NEXT_PUBLIC_CONVEX_URL: `http://127.0.0.1:${ports.backend}`,
    NEXT_PUBLIC_CONVEX_SITE_URL: `http://127.0.0.1:${ports.site}`,
  };
  const corrections: Record<string, string> = {};
  for (const [name, value] of Object.entries(wanted)) {
    if ((values[name] ?? '') !== value) corrections[name] = value;
  }
  return corrections;
}

/**
 * Every `KEY=value` an env file declares.
 *
 * Args:
 *   path: Env file path.
 *
 * Returns:
 *   The declared values; empty when the file does not exist.
 */
export function readEnvValues(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return values;
}

/**
 * Write values into an env file without disturbing anything else in it.
 *
 * The file holds a provider key, a credential key and an admin key, so it is
 * written through a temporary file in the same directory and renamed over the
 * original: a reader who interrupts this never ends up with half a file. The
 * mode is set before the rename, so the key is never briefly world-readable.
 *
 * Args:
 *   path: Env file path, which must already exist.
 *   updates: Names and values to replace or append.
 */
export function writeEnvValues(path: string, updates: Readonly<Record<string, string>>): void {
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writePrivateEnv(path, upsertEnvText(text, updates));
}

/**
 * Wrap prose under a numbered step, so a long sentence stays readable in a
 * terminal without being hard-wrapped at the place it is written.
 *
 * Args:
 *   text: The sentence to wrap.
 *   indent: What every line starts with.
 *   width: The column to break before.
 *
 * Returns:
 *   One string per line, each already indented.
 */
export function wrapIndented(text: string, indent: string, width = 92): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (current === '') current = word;
    else if (indent.length + current.length + 1 + word.length > width) {
      lines.push(indent + current);
      current = word;
    } else current = `${current} ${word}`;
  }
  if (current !== '') lines.push(indent + current);
  return lines;
}

/**
 * What a first success looks like in real mode: the README's "The
 * documentation is yours" steps, in order, because the mock steps' second line
 * ("the office it works in is seeded and synthetic") is untrue here.
 */
export const REAL_FIRST_SUCCESS: readonly { action: string; detail: string }[] = [
  {
    action: 'Open the unlock URL that pnpm dev prints.',
    detail:
      'It carries the key once; after that it is a cookie. Opening http://localhost:3000 directly answers 403, and that is the boundary working rather than a fault.',
  },
  {
    action: 'Link your documentation first, on the documentation page.',
    detail:
      'A folder source takes a path relative to the mount, and `.` is the whole of DAY0_DOCS_HOST_DIR. A Notion source takes http://docs-notion-mcp:3000/mcp and your own integration token. Each source shows synced and a page count once read.',
  },
  {
    action: 'Deploy an agent with those sources ticked, hold the Day-1 1:1 in chat, and approve the charter.',
    detail:
      'Use the tickets\' own words in the 1:1; the charter records what you said, and the systems the documentation names are the systems that exist.',
  },
  {
    action: 'Approve the connection cards on the Surfaces tab.',
    detail:
      'Each card needs both the manager and the IT approval; a Slack card with no DAY0_PUBLIC_URL takes a shared bot token before approval. A system with no approved path stays absent, and work that needs it defers.',
  },
];

/**
 * What a first success looks like, printed after the checker's own report.
 *
 * The mock steps are `src/setup/quickstart.ts`'s, which is also what the
 * `/setup` page renders: a reader who follows the page and a reader who
 * follows this terminal are told the same four things. Real mode has its own
 * four. The app's origin in a detail follows the unlock URL, so a stack on
 * another port is not told about 3000.
 *
 * Args:
 *   unlockUrl: The URL the run resolved, or undefined when it could not.
 *   mode: Mock unless said otherwise.
 *
 * Returns:
 *   Lines to print.
 */
export function firstSuccessLines(unlockUrl: string | undefined, mode: SetupMode = 'mock'): string[] {
  const lines = ['What a first success looks like:'];
  const origin = unlockUrl === undefined ? undefined : new URL(unlockUrl).origin;
  const steps = mode === 'real' ? REAL_FIRST_SUCCESS : FIRST_SUCCESS;
  steps.forEach((step, index): void => {
    const action = index === 0 && unlockUrl !== undefined ? `Open ${unlockUrl}.` : step.action;
    const detail =
      origin === undefined ? step.detail : step.detail.replaceAll('http://localhost:3000', origin);
    lines.push(`  ${index + 1}  ${action}`);
    lines.push(...wrapIndented(detail, '     '));
  });
  return lines;
}

export interface FeatherlessKey {
  /** Where the key comes from; `file` means the file's own value is kept as it is. */
  source: 'environment' | 'file' | 'prompt';
  /** The variable it was read from, for the terminal; never the value. */
  variable?: string;
  /** The value to write, when it is not already the file's own. */
  key?: string;
}

/**
 * Where the Featherless key comes from, without printing it.
 *
 * The environment wins (`FEATHERLESS_API_KEY`, then `OPENAI_API_KEY`), so a
 * venue script can hand the key in without a prompt. A file already on the
 * Featherless route keeps its own key. The probe script's `FEATHERLESS_API_KEY`
 * line in the file is taken next, and only then is the reader asked.
 *
 * Args:
 *   environment: The process environment.
 *   existing: What `.env.local` declares today.
 *
 * Returns:
 *   The source, and the value when one has to be written.
 */
export function featherlessKeySource(
  environment: Readonly<Record<string, string | undefined>>,
  existing: Readonly<Record<string, string>>,
): FeatherlessKey {
  for (const variable of ['FEATHERLESS_API_KEY', 'OPENAI_API_KEY']) {
    const key = (environment[variable] ?? '').trim();
    if (key !== '') return { source: 'environment', variable, key };
  }
  if (
    (existing.OPENAI_API_KEY ?? '').trim() !== '' &&
    (existing.OPENAI_BASE_URL ?? '').trim() === FEATHERLESS_SETTINGS.OPENAI_BASE_URL
  ) {
    return { source: 'file', variable: 'OPENAI_API_KEY' };
  }
  const probeKey = (existing.FEATHERLESS_API_KEY ?? '').trim();
  if (probeKey !== '') return { source: 'file', variable: 'FEATHERLESS_API_KEY', key: probeKey };
  return { source: 'prompt' };
}

/** Env names whose values are never shown, in a plan or anywhere else. */
export const SECRET_NAMES: readonly string[] = [
  'OPENAI_API_KEY',
  'FEATHERLESS_API_KEY',
  'CONVEX_SELF_HOSTED_ADMIN_KEY',
  'DAYTONA_API_KEY',
  'EXA_API_KEY',
  'DEV_NO_AUTH_SECRET',
  'DEV_NO_AUTH_SIGNING_KEY',
  'DAY0_CREDENTIAL_KEY',
  'DAY0_NOTION_MCP_AUTH_TOKEN',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_WEBHOOK_SECRET',
  'CLERK_SECRET_KEY',
];

/**
 * An env update as it may be printed: a secret's value is replaced.
 *
 * Args:
 *   name: The variable.
 *   value: Its value.
 *
 * Returns:
 *   `NAME=value`, or `NAME=<hidden>` for a secret; an emptied secret says so.
 */
export function printableUpdate(name: string, value: string): string {
  if (!SECRET_NAMES.includes(name)) return `${name}=${value}`;
  return value === '' ? `${name}= (emptied)` : `${name}=<hidden>`;
}

export interface StepContext {
  mode: SetupMode;
  route: SetupRoute;
  /** The optional profiles handed to `convex:up`; empty in mock mode. */
  profiles: readonly string[];
  /** The model to pull on the bundled route. */
  model?: string;
  /** Real mode: the project whose redactor volumes are copied. */
  warmFrom?: string;
  project: string;
  /** The pinned node image the volume copy runs in. */
  image?: string;
}

export interface PlannedCommand {
  command: string;
  args: string[];
  /** Env values the command is given on top of the shared child environment. */
  env?: Record<string, string>;
}

/**
 * The exact command lines one step runs, shared by the plan and the run.
 *
 * Args:
 *   step: A step name from `sequenceSteps`.
 *   context: What the step needs to know.
 *
 * Returns:
 *   One or more commands; the admin key step names the generator it may run.
 */
export function stepCommands(step: string, context: StepContext): PlannedCommand[] {
  switch (step) {
    case 'reset':
      return [{ command: 'docker', args: resetArguments() }];
    case 'dev:no-auth-key':
      return [{ command: 'pnpm', args: ['run', 'dev:no-auth-key'] }];
    case 'warm-redactor': {
      if (!context.warmFrom || !context.image) return [];
      return redactorVolumeClone(context.warmFrom, context.project, context.image).flatMap(
        (clone): PlannedCommand[] => [
          { command: 'docker', args: clone.create },
          { command: 'docker', args: clone.copy },
        ],
      );
    }
    case 'convex:up':
      return [{ command: 'pnpm', args: ['run', 'convex:up', ...profileArguments(context.profiles)] }];
    case 'model:up':
      return [{ command: 'pnpm', args: ['run', 'model:up'] }];
    case 'model:pull':
      return [{ command: 'pnpm', args: ['run', 'model:pull', context.model ?? ''] }];
    case 'sandbox:up':
      return [{ command: 'pnpm', args: ['run', 'sandbox:up'] }];
    case 'redactor:up':
      return [{ command: 'pnpm', args: ['run', 'redactor:up'] }];
    case 'admin-key':
      return [
        {
          command: 'docker',
          args: composeArguments(['exec', '-T', 'backend', './generate_admin_key.sh']),
        },
      ];
    case 'sync:env':
      return [{ command: 'pnpm', args: ['run', 'sync:env'] }];
    case 'convex dev --once':
      return [{ command: 'npx', args: ['convex', 'dev', '--once'] }];
    case 'convex:restart':
      return [{ command: 'pnpm', args: ['run', 'convex:restart'] }];
    case 'check:setup':
      return [{ command: 'pnpm', args: ['run', 'check:setup'] }];
    default:
      throw new Error(`no command for step "${step}"`);
  }
}

export interface PlanInput {
  mode: SetupMode;
  route: SetupRoute;
  project: string;
  ports: SetupPorts;
  steps: readonly string[];
  context: StepContext;
  /** What would be written to the env file. */
  updates: Readonly<Record<string, string>>;
  /** Real mode: the redactor decision, when the venv could be read. */
  redactor?: RedactorGpuDecision;
  /** Whether the env file would be created from the example first. */
  createsEnv: boolean;
  /** Real mode: whether the manager's address is still to be asked. */
  asksBossEmail?: boolean;
  /** Whether the provider key is still to be asked for. */
  asksKey?: boolean;
}

/**
 * The plan `--dry-run` prints: what would be written, and every command.
 *
 * Args:
 *   input: The resolved choices.
 *
 * Returns:
 *   Lines to print; no secret value appears in any of them.
 */
export function planLines(input: PlanInput): string[] {
  const lines: string[] = [];
  lines.push(
    `Dry run: ${input.mode} mode on the ${input.route} route, Compose project ${input.project}, ` +
      `backend ${input.ports.backend}, site ${input.ports.site}, dashboard ${input.ports.dashboard}, app ${input.ports.app}.`,
  );
  lines.push('');
  lines.push(`Would write to ${ENV_FILE}${input.createsEnv ? ` (created from ${ENV_EXAMPLE} first)` : ''}:`);
  const names = Object.keys(input.updates);
  if (names.length === 0) lines.push('  nothing; the file already says all of this');
  for (const name of names) lines.push(`  ${printableUpdate(name, input.updates[name])}`);
  if (input.asksKey) lines.push('  OPENAI_API_KEY=<asked in a hidden prompt, or taken from the environment>');
  if (input.asksBossEmail) lines.push('  NEXT_PUBLIC_DEMO_BOSS_EMAIL=<asked>');
  lines.push('');
  lines.push('Would run, in this order:');
  input.steps.forEach((step: string, index: number): void => {
    const commands = stepCommands(step, input.context);
    const prefix = step === 'redactor:up' && input.redactor && input.redactor.mode !== 'auto'
      ? `MODEL_GPU=${input.redactor.mode} `
      : '';
    if (commands.length === 0) {
      lines.push(`  ${index + 1}  ${step}: nothing to run`);
      return;
    }
    commands.forEach((planned: PlannedCommand, position: number): void => {
      const label = position === 0 ? `${index + 1}  ` : '   ';
      lines.push(`  ${label}${prefix}${[planned.command, ...planned.args].join(' ')}`);
    });
    if (step === 'admin-key') {
      lines.push('     (only when the file has no key or the backend refuses the one it has)');
    }
    if (step === 'redactor:up' && input.redactor) lines.push(`     ${input.redactor.reason}`);
  });
  lines.push('');
  lines.push('Nothing was written and nothing was started.');
  return lines;
}

/** What `docker compose ps --format json <service>` says about one service. */
export type ServiceHealth = 'healthy' | 'starting' | 'unhealthy' | 'exited' | 'absent';

/**
 * Read a service's health out of a compose `ps` listing.
 *
 * Args:
 *   stdout: The listing, one JSON object per line (or one array).
 *
 * Returns:
 *   The health, `absent` when the listing has no container.
 */
export function serviceHealth(stdout: string): ServiceHealth {
  const rows: { State?: string; Health?: string }[] = [];
  const text = stdout.trim();
  if (text.startsWith('[')) {
    try {
      rows.push(...(JSON.parse(text) as { State?: string; Health?: string }[]));
    } catch {
      return 'absent';
    }
  } else {
    for (const line of text.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        rows.push(JSON.parse(line) as { State?: string; Health?: string });
      } catch {
        // A partial line; the next poll reads a whole one.
      }
    }
  }
  const row = rows[0];
  if (!row) return 'absent';
  if (row.State !== 'running') return 'exited';
  if (row.Health === 'healthy') return 'healthy';
  if (row.Health === 'unhealthy') return 'unhealthy';
  return 'starting';
}

/** The placeholder page written into a documentation folder this helper created. */
export const DOCS_STUB = [
  '# Your documentation goes here',
  '',
  'This folder is mounted read-only into the backend as its documentation. Put',
  'the runbooks, onboarding pages and systems list your team actually uses here',
  'as Markdown, then link the folder `.` on the documentation page. Day0 reads',
  'what it finds, redacts credential values before storing anything, and treats',
  'the systems these pages name as the systems that exist.',
  '',
  'Replace this file; it is only here so the folder is not empty.',
  '',
].join('\n');

/* Everything below this line talks to the machine: child processes, ports and
   the env file. The tests drive it through the `SetupIo` above rather than
   through Docker. */

/** The env values every child process inherits, so none of them guesses. */
function childEnvironment(project: string, ports: SetupPorts, cwd: string): Record<string, string> {
  return {
    COMPOSE_PROJECT_NAME: project,
    COMPOSE_FILE: join(cwd, 'docker-compose.yml'),
    COMPOSE_PROFILES: '',
    CONVEX_SELF_HOSTED_URL: `http://127.0.0.1:${ports.backend}`,
    CONVEX_SELF_HOSTED_ADMIN_KEY: readEnvValues(join(cwd, ENV_FILE)).CONVEX_SELF_HOSTED_ADMIN_KEY ?? '',
    CONVEX_DEPLOYMENT: '',
    CONVEX_DEPLOY_KEY: '',
    CONVEX_ADMIN_KEY: '',
    CONVEX_URL: `http://127.0.0.1:${ports.backend}`,
    NEXT_PUBLIC_CONVEX_URL: `http://127.0.0.1:${ports.backend}`,
    CONVEX_PORT: String(ports.backend),
    CONVEX_SITE_PROXY_PORT: String(ports.site),
    CONVEX_DASHBOARD_PORT: String(ports.dashboard),
    MODEL_PORT: String(ports.model),
  };
}

/**
 * Ask Docker which of this project's services are running.
 *
 * Args:
 *   io: The setup environment.
 *   project: Compose project name.
 *
 * Returns:
 *   Running service names, or undefined when Docker did not answer.
 */
function runningServices(io: SetupIo, project: string): string[] | undefined {
  const probe = io.run('docker', [
    'ps',
    '--filter',
    `label=com.docker.compose.project=${project}`,
    '--format',
    '{{.Label "com.docker.compose.service"}}',
  ]);
  if (probe.status !== 0) return undefined;
  return probe.stdout
    .split('\n')
    .map((service: string): string => service.trim())
    .filter(Boolean);
}

/**
 * Run one step of the sequence, reporting it as it goes.
 *
 * Args:
 *   io: The setup environment.
 *   label: What to print before running it.
 *   command: Executable.
 *   args: Its arguments.
 *   options: Child-process options.
 *
 * Returns:
 *   The result, whether or not it succeeded.
 */
function step(
  io: SetupIo,
  steps: readonly string[],
  name: string,
  label: string,
  command: string,
  args: readonly string[],
  options: RunOptions,
): RunResult {
  io.log(`[${steps.indexOf(name) + 1}/${steps.length}] ${label}`);
  return io.run(command, args, options);
}

/** One failed step, printed with the state it leaves behind and how to resume. */
function reportFailure(io: SetupIo, what: string, result: RunResult, project: string): void {
  io.log('');
  io.log(`error: ${what} failed (status ${result.status}).`);
  const detail = `${result.stdout}${result.stderr}`.trim();
  if (detail !== '') {
    for (const line of detail.split('\n').slice(-12)) io.log(`  ${line}`);
  } else {
    io.log('  Its own output is above.');
  }
  io.log('');
  io.log(
    'Nothing was removed and nothing was reset. Fix the reason above and run the same ' +
      'command again: `pnpm setup:local`. It picks up where this stopped, keeps the ' +
      `settings and keys already in ${ENV_FILE}, and keeps the ${project} data volume.`,
  );
}

/**
 * Set Day0 up on this machine.
 *
 * Args:
 *   options: What the reader chose on the command line.
 *   io: Child processes, prompts, ports and printing.
 *
 * Returns:
 *   0 when the checker agrees nothing is half-done, 130 when the reader
 *   cancelled, 1 otherwise.
 */
export async function runSetup(options: SetupOptions, io: SetupIo): Promise<number> {
  const envPath = join(io.cwd, ENV_FILE);
  const examplePath = join(io.cwd, ENV_EXAMPLE);
  const real = options.mode === 'real';
  let wrote = false;
  let started = false;

  try {
    const hostedRefusal = buildEnvironmentRefusal(io.environment);
    if (hostedRefusal) {
      io.log(`error: ${hostedRefusal}`);
      return 1;
    }
    if (
      !existsSync(join(io.cwd, 'package.json')) ||
      !existsSync(join(io.cwd, 'docker-compose.yml'))
    ) {
      io.log(`error: run this from the repository root; ${io.cwd} is not a Day0 checkout.`);
      return 1;
    }

    const existing = readEnvValues(envPath);
    const refusals = localTargetRefusals(existing, io.environment);
    if (refusals.length > 0) {
      io.log('error: this helper only ever sets up a backend on this machine.');
      for (const refusal of refusals) {
        io.log(`  ${refusal.setting}: ${refusal.reason}`);
        io.log(`    ${refusal.fix}`);
      }
      return 1;
    }

    const project = options.project ?? existing.COMPOSE_PROJECT_NAME?.trim() ?? '';
    const resolvedProject = project !== '' ? project : basename(io.cwd);
    assertLocalProject(resolvedProject, {
      mainWorktree: isMainWorktree(io.cwd),
      fileProject: existing.COMPOSE_PROJECT_NAME ?? '',
    });
    if (options.warmFrom !== undefined && options.warmFrom.trim() === resolvedProject) {
      io.log(`error: --warm-from ${options.warmFrom} names this installation's own project.`);
      return 1;
    }

    const ports: SetupPorts = {
      backend: options.ports.backend ?? numberFrom(existing.CONVEX_PORT, DEFAULT_PORTS.backend),
      site: options.ports.site ?? numberFrom(existing.CONVEX_SITE_PROXY_PORT, DEFAULT_PORTS.site),
      dashboard:
        options.ports.dashboard ??
        numberFrom(existing.CONVEX_DASHBOARD_PORT, DEFAULT_PORTS.dashboard),
      model: options.ports.model ?? numberFrom(existing.MODEL_PORT, DEFAULT_PORTS.model),
      app: options.ports.app ?? numberFrom(existing.DAY0_APP_PORT, DEFAULT_PORTS.app),
    };
    const docsHostDir =
      options.docs?.trim() || existing.DAY0_DOCS_HOST_DIR?.trim() || DEFAULT_DOCS_HOST_DIR;

    const volumes = io.run('docker', ['volume', 'ls', '--format', '{{.Name}}']);
    if (volumes.status !== 0 && !options.dryRun) {
      io.log('error: Docker could not inventory volumes; no installation can be safely selected.');
      return 1;
    }
    let existingVolumes = volumes.stdout.split('\n').map((name) => name.trim());
    let decision = attachmentDecision({
      project: resolvedProject,
      existingVolumes,
      fileProject: existing.COMPOSE_PROJECT_NAME ?? '',
    });
    if (decision === 'refuse') {
      io.log(
        `error: ${projectVolumes(resolvedProject)[0]} already exists, and ${ENV_FILE} in this ` +
          'checkout does not claim it. That volume belongs to another installation, and ' +
          'attaching to it would put this setup on somebody else’s data.',
      );
      io.log(
        `       Start your own: \`pnpm setup:local --project ${resolvedProject}-2\`, or set ` +
          `COMPOSE_PROJECT_NAME=${resolvedProject} in ${ENV_FILE} if that volume really is this checkout’s.`,
      );
      return 1;
    }

    const checkoutRoot = realpathSync(io.cwd);
    if (existing.DAY0_SETUP_ROOT && existing.DAY0_SETUP_ROOT !== checkoutRoot) {
      io.log('error: this env file belongs to another checkout; choose a fresh project and env file.');
      return 1;
    }
    const containers = io.run('docker', ['ps', '-a', '--filter',
      `label=com.docker.compose.project=${resolvedProject}`, '--format', '{{.ID}}']);
    if (containers.status !== 0 && !options.dryRun) {
      io.log('error: Docker could not identify this project’s existing containers.');
      return 1;
    }
    const ids = containers.stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length) {
      const owners = io.run('docker', ['inspect', '--format',
        '{{index .Config.Labels "com.docker.compose.project.working_dir"}}', ...ids]);
      if (owners.status !== 0 || owners.stdout.trim().split('\n').some(root => root !== checkoutRoot)) {
        io.log('error: existing project containers belong to another checkout or have unknown ownership.');
        return 1;
      }
    } else if (decision === 'rerun' && existing.DAY0_SETUP_ROOT !== checkoutRoot) {
      io.log('error: existing volumes have no verifiable checkout ownership; choose a fresh project.');
      return 1;
    }

    const services = runningServices(io, resolvedProject);
    // A running stack of this project's own holds its ports itself, whether it
    // is being kept or about to be taken down by --reset; only the latter is
    // read as a fresh installation from the volume onwards.
    const ownStackRunning = decision === 'rerun' && services?.includes('backend') === true;
    const alreadyOurs = !options.reset && ownStackRunning;

    io.log(`Day0 local setup, ${options.mode} mode, Compose project ${resolvedProject}.`);
    io.log('');
    const portsToCheck = ownStackRunning
      ? []
      : [
          { name: 'CONVEX_PORT', port: ports.backend },
          { name: 'CONVEX_SITE_PROXY_PORT', port: ports.site },
          { name: 'CONVEX_DASHBOARD_PORT', port: ports.dashboard },
        ];
    const portResults = [];
    for (const candidate of portsToCheck) {
      portResults.push({ ...candidate, free: await io.portFree(candidate.port) });
    }
    // Not a port this helper publishes, and not a reason to stop: `pnpm dev`
    // serves there, and the unlock URL printed at the end names it.
    portResults.push({
      name: 'pnpm dev',
      port: ports.app,
      free: await io.portFree(ports.app),
      blocking: false,
      fix: `\`pnpm dev\` serves on ${ports.app} and the unlock URL names it. Free that port before you run it, or move it: \`--app-port <n>\`; the setup below is unaffected.`,
    });
    const prerequisites = prerequisiteReport({
      node: versionOf(io, 'node', ['--version']),
      pnpm: versionOf(io, 'pnpm', ['--version']),
      docker: versionOf(io, 'docker', ['--version']),
      compose: versionOf(io, 'docker', ['compose', 'version']),
      ports: portResults,
    });
    if (!printPrerequisites(io, prerequisites) && !options.dryRun) return 1;
    if (ownStackRunning) {
      io.log(
        `  ok    ${resolvedProject} is already running here, so its ports are its own` +
          `${options.reset ? '; --reset takes it down first' : ''}.`,
      );
      io.log('');
    }

    const route = await chooseRoute(options, io);
    let apiKey: string | undefined;
    let model = options.model;
    let endpoint = options.endpoint;
    let asksKey = false;

    if (route === 'key') {
      if ((existing.OPENAI_API_KEY ?? '') === '') {
        if (options.dryRun) {
          asksKey = true;
        } else {
          io.log('');
          io.log(
            `The key is read here and written to ${ENV_FILE} with owner-only permissions. It is ` +
              'never printed and never passed to another program as an argument.',
          );
          apiKey = (await io.ask('OPENAI_API_KEY (hidden): ', { hidden: true })).trim();
          if (apiKey === '') {
            io.log('');
            io.log(
              'error: OPENAI_API_KEY is empty, and every step of the loop is a model call, so ' +
                'nothing would finish.',
            );
            io.log(
              '       Run this again and paste one, or take the route that needs no account at ' +
                'all: `pnpm setup:local --route local`, which runs the model on this machine.',
            );
            return 1;
          }
        }
      }
    } else if (route === 'featherless') {
      const source = featherlessKeySource(io.environment, existing);
      io.log(
        `GLM 5.3 Flash through Featherless: ${FEATHERLESS_SETTINGS.OPENAI_MODEL} at ` +
          `${FEATHERLESS_SETTINGS.OPENAI_BASE_URL}, JSON by prompt, ${FEATHERLESS_SETTINGS.OPENAI_MAX_OUTPUT_TOKENS} ` +
          `output tokens, ${FEATHERLESS_SETTINGS.OPENAI_REASONING_EFFORT} effort.`,
      );
      if (source.source === 'environment') {
        apiKey = source.key;
        io.log(`  The key is taken from ${source.variable} in the environment and stored as OPENAI_API_KEY.`);
      } else if (source.source === 'file') {
        apiKey = source.key;
        io.log(
          source.key === undefined
            ? `  ${ENV_FILE} already carries a key for this route; it is kept.`
            : `  The key is taken from ${source.variable} in ${ENV_FILE} and stored as OPENAI_API_KEY.`,
        );
      } else if (options.dryRun) {
        asksKey = true;
      } else {
        io.log(
          `  The key is read here and written to ${ENV_FILE} with owner-only permissions. It is ` +
            'never printed and never passed to another program as an argument.',
        );
        apiKey = (await io.ask('Featherless API key (hidden): ', { hidden: true })).trim();
        if (apiKey === '') {
          io.log('');
          io.log('error: the Featherless key is empty, and every step of the loop is a model call.');
          io.log(
            '       Run this again and paste one (https://featherless.ai/account/api-keys), set ' +
              'FEATHERLESS_API_KEY in the environment, or take `--route local`.',
          );
          return 1;
        }
      }
    } else if (route === 'local') {
      const modelPortFree = ownStackRunning || (await io.portFree(ports.model));
      if (!modelPortFree && !options.dryRun) {
        io.log('');
        io.log(
          `error: host port ${ports.model} is already in use, and the bundled model service ` +
            'publishes there.',
        );
        io.log(
          `       Move it: \`pnpm setup:local --route local --model-port <n>\`. A native ` +
            '`ollama serve` on this machine is the usual reason.',
        );
        return 1;
      }
      const choice = chooseLocalModel(freeVram(io));
      model = model ?? (existing.OPENAI_BASE_URL?.includes('127.0.0.1:') ? existing.OPENAI_MODEL : undefined) ?? choice.model;
      io.log('');
      io.log('Running the model here is a hardware question, so it is asked before the pull.');
      io.log(`  ${choice.reason}`);
      io.log(`  Pulling ${model}: ${choice.downloadLabel} to download, ${choice.residentLabel}.`);
      io.log(
        '  A model that does not fit spills onto the CPU, and the symptom is a 1:1 that runs ' +
          'perfectly and a charter that never arrives.',
      );
      if (!options.assumeYes && !options.dryRun) {
        const answer = (await io.ask('  Pull it now? [Y/n] ')).trim().toLowerCase();
        if (answer === 'n' || answer === 'no') throw new SetupCancelled('the pull was declined');
      }
    } else {
      endpoint = endpoint ?? (options.dryRun ? '' : (await io.ask('OpenAI-compatible endpoint URL: ')).trim());
      if (endpoint === '') {
        io.log('error: the advanced route needs an endpoint. Pass `--endpoint <url>`.');
        return 1;
      }
      io.log('');
      io.log(
        'Advanced route. `pnpm probe:model` says whether an endpoint can drive the loop ' +
          '(chat, JSON and schema handling) before you wire it into anything.',
      );
      io.log(
        `Set OPENAI_MODEL to an id that endpoint serves, and OPENAI_API_KEY if it wants one; ` +
          `both live in ${ENV_FILE}.`,
      );
    }

    let bossEmail = options.bossEmail?.trim() || existing.NEXT_PUBLIC_DEMO_BOSS_EMAIL?.trim() || '';
    let asksBossEmail = false;
    if (real) {
      io.log('');
      io.log(`Real mode: day0 reads the documentation in ${docsHostDir} and, once you approve a card,`);
      io.log('  acts on the systems those pages record. Nothing is read until you link the folder.');
      if (options.sandbox === 'daytona' && (existing.DAYTONA_API_KEY ?? '').trim() === '') {
        io.log('');
        io.log(`error: --sandbox daytona needs DAYTONA_API_KEY in ${ENV_FILE}, and it is empty.`);
        io.log('       Put the key there, or take the bundled sandbox: `--sandbox local` (the default).');
        return 1;
      }
      if (bossEmail === '') {
        if (options.dryRun) {
          asksBossEmail = true;
        } else if (options.assumeYes) {
          io.log('');
          io.log(
            'note: NEXT_PUBLIC_DEMO_BOSS_EMAIL is unset. Real mode resolves your Slack DM from it at ' +
              'deploy and cannot correct a live agent; set it (or pass --boss-email) before you deploy.',
          );
        } else {
          io.log('');
          io.log('Real mode resolves your Slack DM from your address at deploy, so it is asked now.');
          bossEmail = (await io.ask('Your email address (NEXT_PUBLIC_DEMO_BOSS_EMAIL): ')).trim();
        }
      }
    } else {
      io.log('');
      io.log('The office is mock and seeded, on a backend that runs here. Nothing of yours is read.');
      io.log('  Real mode, on your own documentation and systems: `pnpm setup:local --mode real`,');
      io.log('  or README.md, "Run it in real mode".');
      io.log(
        '  Convex cloud plus Clerk, with a user per sign-in: README.md, "Convex cloud + Clerk".',
      );
      io.log('  That one is not automated here: it needs accounts and a dashboard task.');
    }

    const createsEnv = !existsSync(envPath);
    if (createsEnv && !existsSync(examplePath)) {
      io.log(
        `error: neither ${ENV_FILE} nor ${ENV_EXAMPLE} is here. Run this from the repository root.`,
      );
      return 1;
    }
    const exampleValues = createsEnv ? readEnvValues(examplePath) : existing;
    const updates = setupEnvUpdates({
      route,
      project: resolvedProject,
      ports,
      existing: exampleValues,
      apiKey,
      model,
      endpoint,
      mode: options.mode,
      appPortSelected: options.ports.app !== undefined,
      docsHostDir,
      sandbox: options.sandbox,
      bossEmail: bossEmail || undefined,
      gpu: options.gpu,
    });
    if (existing.DAY0_SETUP_ROOT !== checkoutRoot) updates.DAY0_SETUP_ROOT = checkoutRoot;

    const profiles = real ? REAL_MODE_PROFILES : [];
    const warm = real && options.warmFrom !== undefined;
    const steps = sequenceSteps(route, {
      mode: options.mode,
      warm,
      sandbox: options.sandbox,
      reset: options.reset,
    });
    const context: StepContext = {
      mode: options.mode,
      route,
      profiles,
      model,
      warmFrom: options.warmFrom,
      project: resolvedProject,
      image: warm ? pinnedNodeImage(readFileSync(join(io.cwd, 'docker-compose.yml'), 'utf8')) : undefined,
    };
    const venvVolume = `${resolvedProject}_${REDACTOR_VOLUME_SUFFIXES[0]}`;
    // The clone module refuses a protected project on either side; better
    // here, before anything is written, than at the step.
    if (warm) stepCommands('warm-redactor', context);

    if (options.dryRun) {
      const venv = existingVolumes.includes(venvVolume)
        ? readVenvDevice(io, venvVolume, context.image)
        : warm
          ? readVenvDevice(io, `${options.warmFrom}_${REDACTOR_VOLUME_SUFFIXES[0]}`, context.image)
          : 'none';
      io.log('');
      for (const line of planLines({
        mode: options.mode,
        route,
        project: resolvedProject,
        ports,
        steps,
        context,
        updates,
        redactor: real
          ? redactorGpuDecision({ gpu: options.gpu, driver: hasNvidiaDriver(io), venv })
          : undefined,
        createsEnv,
        asksBossEmail,
        asksKey,
      })) {
        io.log(line);
      }
      return 0;
    }

    if (createsEnv) {
      writePrivateEnv(envPath, readFileSync(examplePath, 'utf8'));
      wrote = true;
      io.log('');
      io.log(`Created ${ENV_FILE} from ${ENV_EXAMPLE}, readable only by you.`);
    }
    if (real) {
      const docs = ensureDocsDirectory(docsHostDir, io.cwd);
      if (docs.created) {
        io.log(`Created ${docs.path} with a placeholder page; put your team's Markdown there.`);
      }
    }
    if (Object.keys(updates).length > 0) {
      writeEnvValues(envPath, updates);
      wrote = true;
      const named = Object.keys(updates).filter(
        (name: string): boolean => !SECRET_NAMES.includes(name),
      );
      const secrets = Object.keys(updates).filter((name: string): boolean => SECRET_NAMES.includes(name));
      io.log(
        `Wrote ${named.join(', ')}${secrets.length > 0 ? ` and ${secrets.map((name) => printableUpdate(name, updates[name])).join(', ')}` : ''}.`,
      );
      if (real && options.sandbox === 'local' && (existing.DAYTONA_API_KEY ?? '') !== '') {
        io.log('    DAYTONA_API_KEY was emptied so the bundled sandbox verifies skills; `--sandbox daytona` keeps it.');
      }
    } else {
      io.log('');
      io.log(`${ENV_FILE} already says all of this; nothing was changed in it.`);
    }

    const environment = childEnvironment(resolvedProject, ports, checkoutRoot);
    const streamed: RunOptions = { env: environment, inherit: true, timeoutMs: 900_000 };
    io.log('');
    io.log(`Starting. Steps: ${steps.join(' → ')}`);
    io.log('');
    started = true;

    const runStep = (name: string, label: string, extra: RunOptions = {}): RunResult | undefined => {
      let last: RunResult | undefined;
      for (const planned of stepCommands(name, context)) {
        last = step(io, steps, name, label, planned.command, planned.args, {
          ...streamed,
          ...extra,
          env: { ...environment, ...(extra.env ?? {}), ...(planned.env ?? {}) },
        });
        if (last.status !== 0) {
          reportFailure(io, label, last, resolvedProject);
          return undefined;
        }
      }
      return last;
    };

    if (options.reset) {
      io.log(`[${steps.indexOf('reset') + 1}/${steps.length}] docker compose down -v, removing ${resolvedProject} and its volumes`);
      const down = io.run('docker', resetArguments(), {
        env: { ...environment, DAY0_DOCS_HOST_DIR: docsHostDir },
        inherit: true,
        timeoutMs: 600_000,
      });
      if (down.status !== 0) {
        reportFailure(io, 'docker compose down -v', down, resolvedProject);
        return 1;
      }
      const after = io.run('docker', ['volume', 'ls', '--format', '{{.Name}}']);
      existingVolumes = after.status === 0 ? after.stdout.split('\n').map((name) => name.trim()) : [];
      decision = 'fresh';
    }

    const keys = runStep('dev:no-auth-key', 'pnpm dev:no-auth-key', { inherit: false, timeoutMs: 120_000 });
    if (!keys) return 1;
    for (const line of keys.stdout.split('\n')) {
      if (line.startsWith('Wrote') || line.includes('already carries'))
        io.log(`    ${line.trim()}`);
    }

    if (warm) {
      io.log(`[${steps.indexOf('warm-redactor') + 1}/${steps.length}] redactor volumes from ${options.warmFrom}`);
      const present = REDACTOR_VOLUME_SUFFIXES.filter((suffix: string): boolean =>
        existingVolumes.includes(`${resolvedProject}_${suffix}`),
      );
      if (present.length === REDACTOR_VOLUME_SUFFIXES.length) {
        io.log('    already present in this project, so they are kept as they are');
      } else {
        for (const planned of stepCommands('warm-redactor', context)) {
          const result = io.run(planned.command, planned.args, { env: environment, timeoutMs: 900_000 });
          if (result.status !== 0) {
            reportFailure(io, `copying ${options.warmFrom}'s redactor volumes`, result, resolvedProject);
            return 1;
          }
        }
        io.log('    copied the installed wheels and the verified model; the redactor will not download');
      }
    }

    if (!runStep('convex:up', `pnpm convex:up${profiles.length > 0 ? ` ${profileArguments(profiles).join(' ')}` : ''}`)) {
      return 1;
    }

    if (route === 'local') {
      const modelGpu: Record<string, string> = options.gpu === 'auto' ? {} : { MODEL_GPU: options.gpu };
      if (!runStep('model:up', 'pnpm model:up', { env: modelGpu })) return 1;
      if (!runStep('model:pull', `pnpm model:pull ${model}`, { timeoutMs: 3_600_000 })) return 1;
    }

    if (steps.includes('sandbox:up') && !runStep('sandbox:up', 'pnpm sandbox:up')) return 1;

    let redactor: RedactorGpuDecision | undefined;
    if (real) {
      const inventory = io.run('docker', ['volume', 'ls', '--format', '{{.Name}}']);
      const nowVolumes = inventory.status === 0 ? inventory.stdout.split('\n').map((name) => name.trim()) : existingVolumes;
      const venv = nowVolumes.includes(venvVolume) ? readVenvDevice(io, venvVolume, context.image) : 'none';
      redactor = redactorGpuDecision({ gpu: options.gpu, driver: hasNvidiaDriver(io), venv });
      const [redactorCommand] = stepCommands('redactor:up', context);
      io.log(`[${steps.indexOf('redactor:up') + 1}/${steps.length}] pnpm redactor:up`);
      io.log(`    on the ${redactor.device === 'cuda' ? 'GPU' : 'CPU'}: ${redactor.reason}`);
      const redactorUp = io.run(redactorCommand.command, redactorCommand.args, {
        ...streamed,
        env: { ...environment, ...(redactor.mode === 'auto' ? {} : { MODEL_GPU: redactor.mode }) },
      });
      if (redactorUp.status !== 0) {
        reportFailure(io, 'pnpm redactor:up', redactorUp, resolvedProject);
        return 1;
      }
    }

    io.log(`    waiting for the backend on 127.0.0.1:${ports.backend}`);
    const version = await io.waitForBackend(ports.backend, 180_000);
    if (version === undefined) {
      reportFailure(
        io,
        `the backend did not answer on 127.0.0.1:${ports.backend}`,
        { status: null, stdout: '', stderr: '`docker compose logs backend` says why.' },
        resolvedProject,
      );
      return 1;
    }

    io.log(
      `[${steps.indexOf('admin-key') + 1}/${steps.length}] admin key, from the backend container`,
    );
    const heldKey = readEnvValues(envPath).CONVEX_SELF_HOSTED_ADMIN_KEY ?? '';
    const heldKeyWorks =
      heldKey.includes('|') &&
      io.run('npx', ['convex', 'env', 'list'], { env: environment, timeoutMs: 120_000 }).status ===
        0;
    let adminKey: string | undefined = heldKey;
    if (shouldCaptureAdminKey(heldKey, heldKeyWorks)) {
      const [generator] = stepCommands('admin-key', context);
      const generated = io.run(generator.command, generator.args, { env: environment, timeoutMs: 60_000 });
      adminKey = generated.status === 0 ? parseAdminKey(generated.stdout) : undefined;
      if (adminKey === undefined) {
        reportFailure(io, 'generate_admin_key.sh', generated, resolvedProject);
        return 1;
      }
      writeEnvValues(envPath, { CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey });
      io.log(`    wrote CONVEX_SELF_HOSTED_ADMIN_KEY (${adminKeyPrefix(adminKey)}) to ${ENV_FILE}`);
    } else {
      io.log(
        `    the key in ${ENV_FILE} (${adminKeyPrefix(heldKey)}) still authenticates against this ` +
          'volume, so it is kept',
      );
    }

    environment.CONVEX_SELF_HOSTED_ADMIN_KEY = adminKey;

    const published = io.run(
      'docker',
      composeArguments(['port', 'backend', String(CONTAINER_BACKEND_PORT)]),
      { env: environment, timeoutMs: 30_000 },
    );
    const identityRefusal = backendIdentityRefusal({
      url: readEnvValues(envPath).CONVEX_SELF_HOSTED_URL ?? '',
      adminKey,
      publishedAddress: published.status === 0 ? published.stdout.trim() : undefined,
      services: runningServices(io, resolvedProject),
    });
    if (identityRefusal !== undefined) {
      io.log('');
      io.log(`error: nothing was pushed, because ${identityRefusal}`);
      io.log(
        '       `pnpm sync:env` and `npx convex dev --once` both write to whatever the URL and ' +
          'admin key resolve to, so they are not run until those agree with the container.',
      );
      return 1;
    }
    io.log('    URL, admin key and Compose service are the same backend');

    if (!runStep('sync:env', 'pnpm sync:env')) return 1;
    if (!runStep('convex dev --once', 'npx convex dev --once')) return 1;
    const corrections = publicUrlCorrections(readEnvValues(envPath), ports);
    if (Object.keys(corrections).length > 0) {
      writeEnvValues(envPath, corrections);
      io.log(
        `    the Convex CLI rewrote ${Object.keys(corrections).join(' and ')} to the backend's ` +
          'own container ports; put back the host addresses this installation publishes',
      );
    }

    if (!runStep('convex:restart', 'pnpm convex:restart')) return 1;
    await io.waitForBackend(ports.backend, 180_000);

    if (real && redactor) {
      const health = await waitForRedactor(io, environment, redactor.rebuilds ? 1_800_000 : 300_000);
      if (health === 'healthy') {
        io.log('    the redactor is healthy: the model is loaded and verified');
      } else {
        io.log(
          `    note: the redactor is ${health}. Documentation sync waits for it; ` +
            '`docker compose logs redactor` shows the install, and `pnpm check:setup` reports it.',
        );
      }
    }

    io.log('');
    const [checkerCommand] = stepCommands('check:setup', context);
    const checker = step(
      io,
      steps,
      'check:setup',
      'pnpm check:setup',
      checkerCommand.command,
      checkerCommand.args,
      streamed,
    );

    const unlock = io.run('pnpm', ['exec', 'tsx', 'scripts/dev-no-auth-key.ts', 'url'], {
      env: { ...environment, PORT: String(ports.app) },
      timeoutMs: 60_000,
    });
    const unlockUrl = /https?:\/\/\S+/.exec(unlock.stdout)?.[0];

    io.log('');
    io.log('Next: `pnpm dev`. It prints the same unlock URL and serves the app.');
    if (unlockUrl) io.log(`  ${unlockUrl}`);
    io.log('');
    for (const line of firstSuccessLines(unlockUrl, options.mode)) io.log(line);
    io.log('');
    if (real) {
      io.log(
        `Stop it with \`pnpm sandbox:down && pnpm redactor:down && pnpm convex:down ${profileArguments(profiles).join(' ')}\`. ` +
          `Your data stays in the ${projectVolumes(resolvedProject)[0]} volume, and running this again keeps it; ` +
          '`--reset` is the one that throws it away.',
      );
    } else {
      io.log(
        `Stop it with \`pnpm sandbox:down && pnpm convex:down\`. Your data stays in the ` +
          `${projectVolumes(resolvedProject)[0]} volume, and running this again keeps it.`,
      );
    }
    if (checker.status !== 0) {
      io.log('');
      io.log(
        'The checker above lists something to fix. The setup itself completed, so the URL and ' +
          'the steps above still apply; run `pnpm check:setup` again once you have fixed it.',
      );
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof SetupCancelled) {
      io.log('');
      const state =
        wrote || started
          ? `Cancelled. ${ENV_FILE} keeps what was already written, and nothing was reset. Run \`pnpm setup:local\` again to carry on.`
          : 'Cancelled. Nothing was written and nothing was started.';
      io.log(state);
      return 130;
    }
    io.log(`error: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Make sure the documentation folder exists, writing a placeholder page into
 * one this helper created so the first sync has something to say.
 *
 * Args:
 *   configured: `DAY0_DOCS_HOST_DIR` as it will be written.
 *   cwd: Repository root.
 *
 * Returns:
 *   The absolute path and whether it was created now.
 *
 * Raises:
 *   Error: If a non-default path does not exist.
 */
function ensureDocsDirectory(configured: string, cwd: string): { path: string; created: boolean } {
  const path = resolve(cwd, configured);
  if (existsSync(path)) return { path, created: false };
  if (path !== resolve(cwd, DEFAULT_DOCS_HOST_DIR)) {
    throw new Error(
      `--docs ${configured} does not exist. Create it, or point it at the directory holding the ` +
        'Markdown the backend should read.',
    );
  }
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'README.md'), DOCS_STUB, 'utf8');
  return { path, created: true };
}

/** Whether `nvidia-smi -L` names a GPU, which is a reason to try rather than a promise. */
function hasNvidiaDriver(io: SetupIo): boolean {
  const probe = io.run('nvidia-smi', ['-L'], { timeoutMs: 30_000 });
  return probe.status === 0 && /^GPU \d+:/m.test(probe.stdout);
}

/**
 * Which device a redactor venv volume was built for, read through the pinned image.
 *
 * Args:
 *   io: The setup environment.
 *   volume: The venv volume.
 *   image: The pinned node image, or undefined to read it off the compose file.
 *
 * Returns:
 *   The device, `unknown` when the volume could not be read.
 */
function readVenvDevice(io: SetupIo, volume: string, image: string | undefined): VenvDevice {
  const nodeImage = image ?? pinnedNodeImage(readFileSync(join(io.cwd, 'docker-compose.yml'), 'utf8'));
  const stamp = io.run('docker', venvStampCommand(volume, nodeImage), { timeoutMs: 120_000 });
  if (stamp.status !== 0) return 'unknown';
  return venvDevice(stamp.stdout, requirementsDigests(io.cwd));
}

/**
 * Wait for the redactor to report healthy, polling compose.
 *
 * Args:
 *   io: The setup environment.
 *   environment: The child environment naming the project.
 *   timeoutMs: The ceiling; a first start that downloads gets the long one.
 *
 * Returns:
 *   The last health read.
 */
async function waitForRedactor(
  io: SetupIo,
  environment: Record<string, string>,
  timeoutMs: number,
): Promise<ServiceHealth> {
  const sleep =
    io.sleep ??
    ((ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
  const now = io.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let health: ServiceHealth = 'absent';
  let announced = false;
  for (;;) {
    const listing = io.run(
      'docker',
      composeArguments(['--profile', 'redactor', 'ps', '-a', '--format', 'json', 'redactor']),
      { env: environment, timeoutMs: 30_000 },
    );
    health = listing.status === 0 ? serviceHealth(listing.stdout) : 'absent';
    if (health === 'healthy' || health === 'exited' || health === 'absent') return health;
    if (now() >= deadline) return health;
    if (!announced) {
      io.log('    waiting for the redactor to load its model (seconds on a warm volume, minutes on a first start)');
      announced = true;
    }
    await sleep(5_000);
  }
}

/** A port from the env file, or the default when it does not say. */
function numberFrom(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** What a tool prints for its version, or undefined when it is not there. */
function versionOf(io: SetupIo, command: string, args: readonly string[]): string | undefined {
  const result = io.run(command, args, { timeoutMs: 30_000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Free VRAM on the roomiest card, or undefined when no driver answers. */
function freeVram(io: SetupIo): number | undefined {
  const probe = io.run('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits']);
  return probe.status === 0 ? parseFreeVram(probe.stdout) : undefined;
}

/** Print the prerequisite report; false when something must be fixed first. */
function printPrerequisites(io: SetupIo, results: readonly PrerequisiteResult[]): boolean {
  io.log('Before anything starts:');
  for (const result of results) {
    const marker = result.ok ? 'ok  ' : result.blocking ? 'GAP ' : 'note';
    io.log(`  ${marker}  ${result.name}: ${result.detail}`);
    if (!result.ok && !result.blocking && result.fix) io.log(`          ${result.fix}`);
  }
  const missing = results.filter(
    (result: PrerequisiteResult): boolean => !result.ok && result.blocking,
  );
  if (missing.length === 0) {
    io.log('');
    return true;
  }
  io.log('');
  io.log(`error: ${missing.length} thing(s) to fix before Day0 can start here.`);
  for (const result of missing) {
    io.log(`  ${result.name}: ${result.detail}`);
    if (result.fix) io.log(`    ${result.fix}`);
  }
  io.log('');
  io.log('Nothing was started and nothing was written.');
  return false;
}

/**
 * Settle which route this installation takes.
 *
 * Args:
 *   options: The command line.
 *   io: The setup environment.
 *
 * Returns:
 *   The chosen route.
 *
 * Raises:
 *   SetupCancelled: If the reader stops at the question.
 */
async function chooseRoute(options: SetupOptions, io: SetupIo): Promise<SetupRoute> {
  if (options.route) return options.route;
  if (options.assumeYes) return 'key';
  io.log('How will Day0 reach a model? Every step of the loop is a model call.');
  io.log('  1  A key you already have, for OpenAI or any OpenAI-compatible provider.');
  io.log('     Nothing to download, and no GPU question. You pay per token.');
  io.log('  2  No account at all: the model runs here, in Docker. One pull, and a');
  io.log('     hardware question this asks before it starts.');
  io.log('  3  An endpoint you already run (advanced).');
  io.log('  4  GLM 5.3 Flash through Featherless, with a Featherless key.');
  const answer = (await io.ask('Choose 1, 2, 3 or 4 [1]: ')).trim();
  if (answer === '' || answer === '1') return 'key';
  if (answer === '2') return 'local';
  if (answer === '3') return 'endpoint';
  if (answer === '4') return 'featherless';
  throw new SetupCancelled(`"${answer}" is not one of the four`);
}

let consoleReader: Interface | undefined;
let hidden = false;
let pipedAnswers: AsyncIterableIterator<string> | undefined;

/** Attach the pipe iterator before input flows so answers survive between prompts and EOF. */
function reader(): Interface {
  if (!consoleReader) {
    const output = new Writable({
      write(chunk: unknown, _encoding: unknown, callback: () => void): void {
        if (!hidden) process.stdout.write(chunk as Buffer);
        callback();
      },
    });
    consoleReader = createInterface({
      input: process.stdin,
      output,
      terminal: process.stdin.isTTY === true,
    });
    if (!process.stdin.isTTY) pipedAnswers = consoleReader[Symbol.asyncIterator]();
  }
  return consoleReader;
}

/** The setup environment that actually touches this machine. */
export function consoleIo(cwd: string = process.cwd()): SetupIo {
  return {
    cwd,
    environment: process.env,
    run: (command: string, args: readonly string[], options: RunOptions = {}): RunResult => {
      const result = spawnSync(command, [...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...(options.env ?? {}) },
        timeout: options.timeoutMs,
        stdio: options.inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
    ask: (question: string, options: { hidden?: boolean } = {}): Promise<string> =>
      new Promise<string>((resolvePromise, rejectPromise) => {
        const rl = reader();
        if (pipedAnswers) {
          process.stdout.write(question);
          void pipedAnswers.next().then(({ value, done }) => {
            if (done) rejectPromise(new SetupCancelled('the answer stream ended'));
            else {
              if (options.hidden === true) process.stdout.write('\n');
              resolvePromise(value);
            }
          }, rejectPromise);
          return;
        }
        let answered = false;
        const onClose = (): void => {
          if (!answered) rejectPromise(new SetupCancelled('the answer stream ended'));
        };
        rl.once('close', onClose);
        process.stdout.write(question);
        hidden = options.hidden === true;
        rl.question('', (answer: string): void => {
          answered = true;
          hidden = false;
          rl.off('close', onClose);
          if (options.hidden === true) process.stdout.write('\n');
          resolvePromise(answer);
        });
      }),
    log: (line: string): void => {
      console.log(line);
    },
    portFree: async (port: number): Promise<boolean> =>
      await new Promise<boolean>((resolvePromise) => {
        const socket = connect({ host: '127.0.0.1', port });
        const finish = (open: boolean): void => {
          socket.destroy();
          resolvePromise(!open);
        };
        socket.setTimeout(1_000, (): void => finish(false));
        socket.once('connect', (): void => finish(true));
        socket.once('error', (): void => finish(false));
      }),
    waitForBackend: async (
      port: number,
      timeoutMs: number = 180_000,
    ): Promise<string | undefined> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/version`, {
            signal: AbortSignal.timeout(3_000),
          });
          if (response.ok) return (await response.text()).trim();
        } catch {
          // Not up yet; the deadline is the only thing that ends this.
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
      }
      return undefined;
    },
  };
}

/** Run the helper from the command line. */
async function main(): Promise<number> {
  let options: SetupOptions;
  try {
    options = parseSetupArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    return await runSetup(options, consoleIo());
  } finally {
    consoleReader?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Handed back rather than passed to process.exit so a piped stdout drains.
  process.exitCode = await main();
}
