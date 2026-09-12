/// <reference types="node" />
/**
 * One command that sets Day0 up on this machine.
 *
 *   pnpm setup:local                 ask, then do it
 *   pnpm setup:local --route key     you already have an OpenAI-compatible key
 *   pnpm setup:local --route local   no account at all: run the model here
 *
 * The spelling is deliberate. Plain `pnpm setup` is pnpm's own installation
 * command, so the project script has to be called something else.
 *
 * Everything below already existed as a separate `pnpm` verb, and the README
 * prints them as a list of ten. This composes them rather than reimplementing
 * them: `dev:no-auth-key`, `convex:up`, `model:up`/`model:pull`, `sandbox:up`,
 * the admin-key generator inside the backend container, `sync:env`,
 * `npx convex dev --once`, `convex:restart` and `check:setup`, in the order the
 * README's "six things about that sequence are load-bearing" requires. What it
 * adds is the part a reader cannot get from a list: the prerequisites checked
 * before anything starts, the two model addresses written as a pair so the
 * afternoon-costing trap cannot be sprung, the generated admin key written
 * into the file instead of pasted, one explicit Compose project and host ports
 * used by every child process, and a refusal to point any of it at a cloud
 * deployment or at another checkout's data.
 *
 * It is local-only and it says so: it refuses to run inside a hosted build, it
 * refuses an inherited cloud selector or deploy key, and it never removes a
 * volume or resets anything as a way of recovering from a failed step.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { basename, join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { composeArguments } from './compose';
import { PROTECTED_PROJECTS, PROTECTED_VOLUMES, upsertEnvText } from './demo-bed';

const ENV_FILE = '.env.local';
const ENV_EXAMPLE = '.env.example';

/** The container ports the compose file publishes from, whatever the host uses. */
const CONTAINER_BACKEND_PORT = 3210;
const CONTAINER_MODEL_PORT = 11434;

/** Minimum tool versions, matching `engines` in package.json. */
export const REQUIRED_NODE_MAJOR = 22;
export const REQUIRED_PNPM_MAJOR = 9;
export const REQUIRED_COMPOSE_MAJOR = 2;

/** Which of the three model setups this installation uses. */
export type SetupRoute = 'key' | 'local' | 'endpoint';

/** Every host port this installation publishes. */
export interface SetupPorts {
  backend: number;
  site: number;
  dashboard: number;
  model: number;
}

/** The ports `.env.example` ships, used when neither a flag nor the file says. */
export const DEFAULT_PORTS: SetupPorts = {
  backend: 3210,
  site: 3211,
  dashboard: 6791,
  model: 11434,
};

export interface SetupOptions {
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
}

/** The reader stopped at a prompt. Nothing is undone; nothing was reset. */
export class SetupCancelled extends Error {}

const USAGE = `Usage: pnpm setup:local [options]

  --route <key|local|endpoint>  how this installation reaches a model
  --project <name>              Compose project name for this installation
  --port <n>                    host port for the backend (default ${DEFAULT_PORTS.backend})
  --site-port <n>               host port for HTTP actions (default ${DEFAULT_PORTS.site})
  --dashboard-port <n>          host port for the Convex dashboard (default ${DEFAULT_PORTS.dashboard})
  --model-port <n>              host port for the bundled model (default ${DEFAULT_PORTS.model})
  --model <id>                  model to pull on the bundled route
  --endpoint <url>              OpenAI-compatible endpoint for the advanced route
  --yes                         take the default answer wherever there is one
  --help                        print this

Real mode and the Convex-cloud-plus-Clerk route are not automated here; they
need accounts and a dashboard task. README.md has both, linked from the end of
a successful run.`;

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
  const options: SetupOptions = { ports: {}, assumeYes: false, help: false };
  const portFlags: Readonly<Record<string, keyof SetupPorts>> = {
    '--port': 'backend',
    '--site-port': 'site',
    '--dashboard-port': 'dashboard',
    '--model-port': 'model',
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
    } else if (argument === '--route') {
      const value = take();
      if (value !== 'key' && value !== 'local' && value !== 'endpoint') {
        throw new Error(`--route "${value}" is not one of: key, local, endpoint.`);
      }
      options.route = value;
    } else if (argument === '--project') {
      options.project = take();
    } else if (argument === '--model') {
      options.model = take();
    } else if (argument === '--endpoint') {
      options.endpoint = take();
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
}

export interface PrerequisiteObservations {
  /** What `node --version` printed, or undefined when it could not be run. */
  node?: string;
  pnpm?: string;
  docker?: string;
  compose?: string;
  ports: readonly { name: string; port: number; free: boolean }[];
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
    name: 'pnpm',
    ok: pnpm !== undefined && pnpm >= REQUIRED_PNPM_MAJOR,
    detail:
      pnpm === undefined
        ? 'not on the path'
        : `${observed.pnpm?.trim()} (this project needs ${REQUIRED_PNPM_MAJOR} or newer)`,
    fix: 'Run `corepack enable && corepack prepare pnpm@9 --activate`.',
  });
  results.push({
    name: 'Docker',
    ok: observed.docker !== undefined,
    detail: observed.docker?.trim() ?? 'the daemon did not answer',
    fix: 'Start Docker Desktop, or the `docker` service, and try again.',
  });
  const compose = majorVersion(observed.compose);
  results.push({
    name: 'Compose v2',
    ok: compose !== undefined && compose >= REQUIRED_COMPOSE_MAJOR,
    detail: observed.compose?.trim() ?? '`docker compose version` did not answer',
    fix: 'Compose v2 ships with current Docker; `docker-compose` v1 is not enough.',
  });
  for (const port of observed.ports) {
    results.push({
      name: `${port.name} ${port.port}`,
      ok: port.free,
      detail: port.free ? 'free' : 'already in use on this machine',
      fix: `Move it: \`pnpm setup:local --port <n>\` (or --site-port, --dashboard-port, --model-port), or stop whatever holds ${port.port}.`,
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

/**
 * Refuse a project or volume that holds a real run.
 *
 * Args:
 *   project: Compose project name the reader asked for.
 *
 * Raises:
 *   Error: If the name, or either volume it implies, is protected.
 */
export function assertLocalProject(project: string): void {
  const clash = [project, ...projectVolumes(project)].find(
    (name: string): boolean =>
      PROTECTED_PROJECTS.includes(name) || PROTECTED_VOLUMES.includes(name),
  );
  if (clash === undefined) return;
  throw new Error(
    `"${project}" would use ${projectVolumes(project).join(' and ')}, and ${clash} holds a ` +
      'real run. This helper never starts, writes to or removes it. Choose another name: ' +
      '`pnpm setup:local --project <name>`.',
  );
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
 *   Both addresses. Empty pairs mean api.openai.com, which both sides reach.
 */
export function modelAddresses(
  route: SetupRoute,
  options: { modelPort: number; endpoint?: string },
): ModelAddresses {
  if (route === 'key') return { OPENAI_BASE_URL: '', CONVEX_OPENAI_BASE_URL: '' };
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
}

/**
 * The values this installation needs, and only those.
 *
 * Settings that describe this installation (its project, its ports, its two
 * model addresses) are written every time, because they are what the reader
 * selected. Everything else is written only when the file has nothing to say,
 * so a rerun preserves what the reader changed by hand.
 *
 * Args:
 *   input: Route, project, ports, the file as it stands and any answers given.
 *
 * Returns:
 *   Names and values to write; an already-correct value is left out entirely.
 */
export function setupEnvUpdates(input: EnvPlanInput): Record<string, string> {
  const { backend, site, dashboard, model } = input.ports;
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

  const whenMissing: Record<string, string> = {
    CONVEX_BIND_ADDR: '127.0.0.1',
    DAY0_SURFACE_MODE: 'mock',
  };
  if (input.apiKey) whenMissing.OPENAI_API_KEY = input.apiKey;
  if (input.model) whenMissing.OPENAI_MODEL = input.model;

  const updates: Record<string, string> = { ...selected };
  for (const [name, value] of Object.entries(whenMissing)) {
    if ((input.existing[name] ?? '') === '') updates[name] = value;
  }
  for (const name of Object.keys(updates)) {
    if (input.existing[name] === updates[name]) delete updates[name];
  }
  return updates;
}

/**
 * The helpers this route runs, in the order the README calls load-bearing.
 *
 * Args:
 *   route: The chosen route.
 *
 * Returns:
 *   Step names, in order.
 */
export function sequenceSteps(route: SetupRoute): string[] {
  return [
    'dev:no-auth-key',
    'convex:up',
    ...(route === 'local' ? ['model:up', 'model:pull'] : []),
    'sandbox:up',
    'admin-key',
    'sync:env',
    'convex dev --once',
    'convex:restart',
    'check:setup',
  ];
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
  const temporary = `${path}.setup-${process.pid}`;
  writeFileSync(temporary, upsertEnvText(text, updates), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/** What a first success looks like, printed after the checker's own report. */
export function firstSuccessLines(unlockUrl: string | undefined): string[] {
  return [
    'What a first success looks like:',
    `  1  Open ${unlockUrl ?? 'the unlock URL `pnpm dev` prints'}. It carries the key once; after that it is a cookie.`,
    '     Opening http://localhost:3000 directly answers 403. That is the boundary working.',
    '  2  Deploy an agent. The office it works in is seeded and synthetic; nothing of yours is read.',
    '  3  Hold the Day-1 1:1 in chat mode and answer the seven topics.',
    '  4  Approve the charter it writes. That is the first approval card, and approving it',
    '     is what fills the work queue.',
  ];
}

/* Everything below this line talks to the machine: child processes, ports and
   the env file. The tests drive it through the `SetupIo` above rather than
   through Docker. */

/** The env values every child process inherits, so none of them guesses. */
function childEnvironment(project: string, ports: SetupPorts): Record<string, string> {
  return {
    COMPOSE_PROJECT_NAME: project,
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
  label: string,
  command: string,
  args: readonly string[],
  options: RunOptions,
): RunResult {
  io.log(label);
  return io.run(command, args, options);
}

/** One failed step, printed with the state it leaves behind and how to resume. */
function reportFailure(io: SetupIo, what: string, result: RunResult, project: string): void {
  io.log('');
  io.log(`error: ${what} failed (status ${result.status}).`);
  const detail = `${result.stdout}${result.stderr}`.trim();
  if (detail !== '') {
    for (const line of detail.split('\n').slice(-12)) io.log(`  ${line}`);
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
    assertLocalProject(resolvedProject);

    const ports: SetupPorts = {
      backend: options.ports.backend ?? numberFrom(existing.CONVEX_PORT, DEFAULT_PORTS.backend),
      site: options.ports.site ?? numberFrom(existing.CONVEX_SITE_PROXY_PORT, DEFAULT_PORTS.site),
      dashboard:
        options.ports.dashboard ??
        numberFrom(existing.CONVEX_DASHBOARD_PORT, DEFAULT_PORTS.dashboard),
      model: options.ports.model ?? numberFrom(existing.MODEL_PORT, DEFAULT_PORTS.model),
    };

    const volumes = io.run('docker', ['volume', 'ls', '--format', '{{.Name}}']);
    const existingVolumes =
      volumes.status === 0 ? volumes.stdout.split('\n').map((name) => name.trim()) : [];
    const decision = attachmentDecision({
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

    const services = runningServices(io, resolvedProject);
    const alreadyOurs = decision === 'rerun' && services?.includes('backend') === true;

    io.log(`Day0 local setup, Compose project ${resolvedProject}.`);
    io.log('');
    const portsToCheck = alreadyOurs
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
    const prerequisites = prerequisiteReport({
      node: versionOf(io, 'node', ['--version']),
      pnpm: versionOf(io, 'pnpm', ['--version']),
      docker: versionOf(io, 'docker', ['--version']),
      compose: versionOf(io, 'docker', ['compose', 'version']),
      ports: portResults,
    });
    if (!printPrerequisites(io, prerequisites)) return 1;
    if (alreadyOurs) {
      io.log(`  ok    ${resolvedProject} is already running here, so its ports are its own.`);
      io.log('');
    }

    const route = await chooseRoute(options, io);
    let apiKey: string | undefined;
    let model = options.model;
    let endpoint = options.endpoint;

    if (route === 'key') {
      if ((existing.OPENAI_API_KEY ?? '') === '') {
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
    } else if (route === 'local') {
      const modelPortFree = alreadyOurs || (await io.portFree(ports.model));
      if (!modelPortFree) {
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
      model = model ?? choice.model;
      io.log('');
      io.log('Running the model here is a hardware question, so it is asked before the pull.');
      io.log(`  ${choice.reason}`);
      io.log(`  Pulling ${model}: ${choice.downloadLabel} to download, ${choice.residentLabel}.`);
      io.log(
        '  A model that does not fit spills onto the CPU, and the symptom is a 1:1 that runs ' +
          'perfectly and a charter that never arrives.',
      );
      if (!options.assumeYes) {
        const answer = (await io.ask('  Pull it now? [Y/n] ')).trim().toLowerCase();
        if (answer === 'n' || answer === 'no') throw new SetupCancelled('the pull was declined');
      }
    } else {
      endpoint = endpoint ?? (await io.ask('OpenAI-compatible endpoint URL: ')).trim();
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

    io.log('');
    io.log('The office is mock and seeded, on a backend that runs here. Nothing of yours is read.');
    io.log('  Real mode, on your own documentation and systems: README.md, "Run it in real mode".');
    io.log(
      '  Convex cloud plus Clerk, with a user per sign-in: README.md, "Convex cloud + Clerk".',
    );
    io.log('  Neither is automated here: both need accounts, and one needs a dashboard task.');

    if (!existsSync(envPath)) {
      if (!existsSync(examplePath)) {
        io.log(
          `error: neither ${ENV_FILE} nor ${ENV_EXAMPLE} is here. Run this from the repository root.`,
        );
        return 1;
      }
      copyFileSync(examplePath, envPath);
      chmodSync(envPath, 0o600);
      wrote = true;
      io.log('');
      io.log(`Created ${ENV_FILE} from ${ENV_EXAMPLE}, readable only by you.`);
    }
    const updates = setupEnvUpdates({
      route,
      project: resolvedProject,
      ports,
      existing: readEnvValues(envPath),
      apiKey,
      model,
      endpoint,
    });
    if (Object.keys(updates).length > 0) {
      writeEnvValues(envPath, updates);
      wrote = true;
      const named = Object.keys(updates).filter(
        (name: string): boolean => name !== 'OPENAI_API_KEY',
      );
      io.log(`Wrote ${named.join(', ')}${updates.OPENAI_API_KEY ? ' and your key' : ''}.`);
    } else {
      io.log('');
      io.log(`${ENV_FILE} already says all of this; nothing was changed in it.`);
    }

    const environment = childEnvironment(resolvedProject, ports);
    const inherit: RunOptions = { env: environment, inherit: true };
    io.log('');
    io.log(`Starting. Steps: ${sequenceSteps(route).join(' → ')}`);
    io.log('');
    started = true;

    const keys = step(io, '[1] pnpm dev:no-auth-key', 'pnpm', ['run', 'dev:no-auth-key'], inherit);
    if (keys.status !== 0) {
      reportFailure(io, 'pnpm dev:no-auth-key', keys, resolvedProject);
      return 1;
    }

    const up = step(io, '[2] pnpm convex:up', 'pnpm', ['run', 'convex:up'], {
      env: environment,
      timeoutMs: 600_000,
    });
    if (up.status !== 0) {
      reportFailure(io, 'pnpm convex:up', up, resolvedProject);
      return 1;
    }

    if (route === 'local') {
      const modelUp = step(io, '[3] pnpm model:up', 'pnpm', ['run', 'model:up'], {
        env: environment,
        timeoutMs: 600_000,
      });
      if (modelUp.status !== 0) {
        reportFailure(io, 'pnpm model:up', modelUp, resolvedProject);
        return 1;
      }
      const pull = step(
        io,
        `[4] pnpm model:pull ${model}`,
        'pnpm',
        ['run', 'model:pull', model ?? ''],
        { env: environment, inherit: true, timeoutMs: 3_600_000 },
      );
      if (pull.status !== 0) {
        reportFailure(io, `pnpm model:pull ${model}`, pull, resolvedProject);
        return 1;
      }
    }

    const sandbox = step(io, '[5] pnpm sandbox:up', 'pnpm', ['run', 'sandbox:up'], {
      env: environment,
      timeoutMs: 600_000,
    });
    if (sandbox.status !== 0) {
      reportFailure(io, 'pnpm sandbox:up', sandbox, resolvedProject);
      return 1;
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

    io.log('[6] admin key, from the backend container');
    const generated = io.run(
      'docker',
      composeArguments(['exec', '-T', 'backend', './generate_admin_key.sh']),
      { env: environment, timeoutMs: 60_000 },
    );
    const adminKey = generated.status === 0 ? parseAdminKey(generated.stdout) : undefined;
    if (adminKey === undefined) {
      reportFailure(io, 'generate_admin_key.sh', generated, resolvedProject);
      return 1;
    }
    if (readEnvValues(envPath).CONVEX_SELF_HOSTED_ADMIN_KEY !== adminKey) {
      writeEnvValues(envPath, { CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey });
      io.log(`    wrote CONVEX_SELF_HOSTED_ADMIN_KEY (${adminKeyPrefix(adminKey)}) to ${ENV_FILE}`);
    } else {
      io.log(`    the key in ${ENV_FILE} already belongs to this volume`);
    }

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

    const sync = step(io, '[7] pnpm sync:env', 'pnpm', ['run', 'sync:env'], {
      env: environment,
      timeoutMs: 300_000,
    });
    if (sync.status !== 0) {
      reportFailure(io, 'pnpm sync:env', sync, resolvedProject);
      return 1;
    }

    const push = step(io, '[8] npx convex dev --once', 'npx', ['convex', 'dev', '--once'], {
      env: environment,
      timeoutMs: 600_000,
    });
    if (push.status !== 0) {
      reportFailure(io, 'npx convex dev --once', push, resolvedProject);
      return 1;
    }

    const restart = step(io, '[9] pnpm convex:restart', 'pnpm', ['run', 'convex:restart'], {
      env: environment,
      timeoutMs: 300_000,
    });
    if (restart.status !== 0) {
      reportFailure(io, 'pnpm convex:restart', restart, resolvedProject);
      return 1;
    }
    await io.waitForBackend(ports.backend, 180_000);

    io.log('[10] pnpm check:setup');
    const checker = io.run('pnpm', ['run', 'check:setup'], {
      env: environment,
      timeoutMs: 300_000,
    });
    io.log('');
    for (const line of `${checker.stdout}${checker.stderr}`.replace(/\n$/, '').split('\n')) {
      io.log(line);
    }

    const unlock = io.run('pnpm', ['exec', 'tsx', 'scripts/dev-no-auth-key.ts', 'url'], {
      env: environment,
      timeoutMs: 60_000,
    });
    const unlockUrl = /https?:\/\/\S+/.exec(unlock.stdout)?.[0];

    io.log('');
    io.log('Next: `pnpm dev`. It prints the same unlock URL and serves the app.');
    if (unlockUrl) io.log(`  ${unlockUrl}`);
    io.log('');
    for (const line of firstSuccessLines(unlockUrl)) io.log(line);
    io.log('');
    io.log(
      `Stop it with \`pnpm sandbox:down && pnpm convex:down\`. Your data stays in the ` +
        `${projectVolumes(resolvedProject)[0]} volume, and running this again keeps it.`,
    );
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
    io.log(`  ${result.ok ? 'ok  ' : 'GAP '}  ${result.name}: ${result.detail}`);
  }
  const missing = results.filter((result: PrerequisiteResult): boolean => !result.ok);
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
  const answer = (await io.ask('Choose 1, 2 or 3 [1]: ')).trim();
  if (answer === '' || answer === '1') return 'key';
  if (answer === '2') return 'local';
  if (answer === '3') return 'endpoint';
  throw new SetupCancelled(`"${answer}" is not one of the three`);
}

let consoleReader: Interface | undefined;
let hidden = false;

/** One readline interface for the whole run, so piped answers are not lost. */
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
