/// <reference types="node" />
/**
 * The demo bed kit: one command per thing the demo laptop has to do.
 *
 *   pnpm demo:bed snapshot                       # tar of a completed run's data volume, read-only
 *   pnpm demo:bed restore --snapshot <tar>       # that tar into a NEW volume for this project
 *   pnpm demo:bed up [--reset]                   # the real-mode stack from pre-pulled images
 *   pnpm demo:bed preflight [--video <file>]     # the checklist and the tier verdict
 *   pnpm demo:bed offline-rung                   # the revocation trial against the doubles
 *   pnpm demo:bed down [--volumes]               # stop it; drop this project's volumes if asked
 *
 * The bed's contract is `.env.local` in this checkout, the same file every
 * other `pnpm` command reads, and the compose project is its
 * `COMPOSE_PROJECT_NAME` (or `--project`). Every subcommand refuses the two
 * projects whose volumes hold real runs (`day0`, `day0-demo-7c65e7`); the only
 * thing this file ever does to one of those volumes is mount it read-only for
 * `snapshot`.
 *
 * Three things are deliberate about `up`. Images are never pulled
 * (`--pull never`): the venue network is not to be trusted with a 578 MB
 * download, so the compose file is pinned to digests present on the laptop and
 * a missing image is a pre-flight gap, not a wait. The deployment env is
 * pushed and the backend restarted before functions are used, because a
 * restored volume carries the recording bed's env and a module keeps whatever
 * it was first evaluated with. And the admin key is regenerated from the
 * volume's own instance secret, so a restored volume answers to a key the file
 * did not have yet.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROFILES } from './compose';

const ENV_FILE = '.env.local';
const COMPOSE_FILE = 'docker-compose.yml';
const KIT_DIR = '.demo-bed';
const PROBE_SCRIPT = 'scripts/probe-china-connectivity.sh';

/** The projects whose volumes hold real runs. Nothing here acts on them. */
export const PROTECTED_PROJECTS: readonly string[] = ['day0', 'day0-demo-7c65e7'];

/** The volumes the brief protects, derived from the projects above. */
export const PROTECTED_VOLUMES: readonly string[] = PROTECTED_PROJECTS.flatMap(
  (project: string): string[] => [`${project}_convex_data`, `${project}_sandbox_socket`],
);

/** The completed run the demo restores by default. */
export const DEFAULT_SNAPSHOT_SOURCE = 'day0-demo-7c65e7_convex_data';

/**
 * What a demo bed runs: day0 itself, the sandbox that verifies a skill, and the
 * two doubles the offline rung is measured against. The dashboard, Notion and
 * browser components are opt-in with `--profile`.
 */
export const BED_PROFILES: readonly string[] = ['real', 'sandbox', 'test', 'demo'];

/** Pinned in the compose file; used for the throwaway tar containers too. */
const TAR_IMAGE_PREFIX = 'node:22-alpine@sha256:';

export type Command = 'up' | 'snapshot' | 'restore' | 'preflight' | 'offline-rung' | 'down';

const COMMANDS: readonly Command[] = [
  'up',
  'snapshot',
  'restore',
  'preflight',
  'offline-rung',
  'down',
];

export interface DemoBedOptions {
  command: Command;
  project: string;
  profiles: string[];
  /** `up`: wipe the fixed user's agents after the push. */
  reset: boolean;
  /** `up --reset`: also unlink documentation and purge credential ciphertext. */
  unlink: boolean;
  /** `up` and `preflight`: skip the model probe. */
  probe: boolean;
  /** `up`: skip the checklist at the end. */
  preflight: boolean;
  /** `preflight`: the queued video file, when `.env.local` does not name one. */
  video?: string;
  /** `snapshot`: the volume to read. */
  fromVolume: string;
  /** `snapshot`: where the tar goes. `restore`: the tar to read. */
  snapshot?: string;
  /** `restore`: remove an existing target volume first. */
  replace: boolean;
  /** `offline-rung`: where the trial writes. */
  out?: string;
  /** `down`: remove this project's volumes. */
  volumes: boolean;
  /** `preflight`: seconds per probe request. */
  probeTimeout: number;
}

const USAGE = `Usage: pnpm demo:bed <command> [options]

Commands:
  snapshot      tar a completed run's data volume (read-only) into ${KIT_DIR}/snapshots/
  restore       untar a snapshot into this project's data volume (must not exist yet)
  up            start the stack from pre-pulled images, key, sync, push, restart, checklist
  preflight     ports, images, services, backend, surfaces, model probe, video; tier verdict
  offline-rung  run pnpm eval:revocation against fake-slack and looker-tile, timed
  down          stop the stack

Options:
  --project <name>       compose project (default: COMPOSE_PROJECT_NAME in ${ENV_FILE})
  --profile <name>       up/down: an extra component (dev, docs-notion, browser); repeatable
  --reset                up: wipe the local boss's agents after the push
  --unlink               up --reset: also unlink documentation and purge credentials
  --no-probe             up/preflight: skip the model probe
  --no-preflight         up: skip the checklist
  --video <file>         preflight: the queued video (default: DAY0_DEMO_VIDEO in ${ENV_FILE})
  --from-volume <name>   snapshot: source volume (default: ${DEFAULT_SNAPSHOT_SOURCE})
  --snapshot <file>      snapshot: output path; restore: input path
  --replace              restore: drop an existing target volume first (never a protected one)
  --out <dir>            offline-rung: results directory (default: ${KIT_DIR}/revocation-<stamp>)
  --volumes              down: also remove this project's volumes
  --probe-timeout <s>    preflight: per-request ceiling for the probe (default 15)
`;

/**
 * Split a demo-bed command line into its subcommand and options.
 *
 * Args:
 *   argv: Arguments after the script name.
 *   envValues: What `.env.local` declares, for the project default.
 *
 * Returns:
 *   The parsed options.
 *
 * Raises:
 *   Error: On an unknown command, an unknown flag, a flag without its value,
 *     an unknown profile, or no project anywhere.
 */
export function parseDemoBedArguments(
  argv: readonly string[],
  envValues: Readonly<Record<string, string>> = {},
): DemoBedOptions {
  const words = argv.filter((argument: string): boolean => argument !== '--');
  const command = words[0];
  if (!command || command === '--help' || command === '-h') throw new Error(USAGE);
  if (!COMMANDS.includes(command as Command)) {
    throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
  }
  const options: DemoBedOptions = {
    command: command as Command,
    project: envValues.COMPOSE_PROJECT_NAME ?? '',
    profiles: [...BED_PROFILES],
    reset: false,
    unlink: false,
    probe: true,
    preflight: true,
    fromVolume: DEFAULT_SNAPSHOT_SOURCE,
    replace: false,
    volumes: false,
    probeTimeout: 15,
  };
  const valueOf = (index: number, flag: string): string => {
    const value = words[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return value;
  };
  for (let index = 1; index < words.length; index += 1) {
    const flag = words[index];
    switch (flag) {
      case '--project':
        options.project = valueOf(index, flag);
        index += 1;
        break;
      case '--profile': {
        const name = valueOf(index, flag).trim();
        index += 1;
        if (!(name in PROFILES)) {
          throw new Error(
            `Unknown profile "${name}". This compose file defines: ${Object.keys(PROFILES).join(', ')}.`,
          );
        }
        if (!options.profiles.includes(name)) options.profiles.push(name);
        break;
      }
      case '--reset':
        options.reset = true;
        break;
      case '--unlink':
        options.unlink = true;
        break;
      case '--no-probe':
        options.probe = false;
        break;
      case '--no-preflight':
        options.preflight = false;
        break;
      case '--video':
        options.video = valueOf(index, flag);
        index += 1;
        break;
      case '--from-volume':
        options.fromVolume = valueOf(index, flag);
        index += 1;
        break;
      case '--snapshot':
        options.snapshot = valueOf(index, flag);
        index += 1;
        break;
      case '--replace':
        options.replace = true;
        break;
      case '--out':
        options.out = valueOf(index, flag);
        index += 1;
        break;
      case '--volumes':
        options.volumes = true;
        break;
      case '--probe-timeout':
        options.probeTimeout = Number.parseInt(valueOf(index, flag), 10);
        index += 1;
        if (!Number.isSafeInteger(options.probeTimeout) || options.probeTimeout <= 0) {
          throw new Error('--probe-timeout needs a positive number of seconds.');
        }
        break;
      default:
        throw new Error(`Unknown option "${flag}".\n\n${USAGE}`);
    }
  }
  if (options.command !== 'snapshot' && !options.project) {
    throw new Error(
      `No compose project: set COMPOSE_PROJECT_NAME in ${ENV_FILE} or pass --project <name>.`,
    );
  }
  return options;
}

/**
 * Refuse a protected project or volume name.
 *
 * Args:
 *   name: A compose project or a docker volume name.
 *
 * Raises:
 *   Error: When the name is one the brief protects.
 */
export function assertNotProtected(name: string): void {
  if (PROTECTED_PROJECTS.includes(name) || PROTECTED_VOLUMES.includes(name)) {
    throw new Error(
      `"${name}" is protected: it holds a real run. This kit never starts, restores into, ` +
        `or removes ${PROTECTED_PROJECTS.join(' or ')}; it only reads their data volume for a snapshot.`,
    );
  }
}

/**
 * The data volume compose gives a project, which is where a restore lands.
 *
 * Args:
 *   project: The compose project name.
 *
 * Returns:
 *   `<project>_convex_data`.
 *
 * Raises:
 *   Error: When the project is protected.
 */
export function restoreTargetVolume(project: string): string {
  assertNotProtected(project);
  const volume = `${project}_convex_data`;
  assertNotProtected(volume);
  return volume;
}

/** The pinned tar image, read off the compose file so the two never drift. */
function tarImage(composeText: string = readFileSync(COMPOSE_FILE, 'utf8')): string {
  const pinned = composeImages(composeText).find((image) =>
    image.reference.startsWith(TAR_IMAGE_PREFIX),
  );
  if (!pinned) throw new Error(`${COMPOSE_FILE} no longer pins ${TAR_IMAGE_PREFIX}...`);
  return pinned.reference;
}

/**
 * The `docker` arguments that tar a volume through a throwaway container.
 *
 * Args:
 *   volume: The volume to read. Mounted read-only, whatever it is.
 *   outDirectory: Host directory the tar is written into.
 *   fileName: The tar's name inside that directory.
 *
 * Returns:
 *   Arguments for `docker`.
 */
export function snapshotCommand(volume: string, outDirectory: string, fileName: string): string[] {
  return [
    'run',
    '--rm',
    '-v',
    `${volume}:/from:ro`,
    '-v',
    `${outDirectory}:/to`,
    tarImage(),
    'sh',
    '-c',
    `tar czf /to/${fileName} -C /from .`,
  ];
}

/**
 * The `docker` arguments that untar a snapshot into a volume.
 *
 * Args:
 *   snapshotDirectory: Host directory holding the tar.
 *   fileName: The tar's name inside that directory.
 *   volume: The target volume. Never a protected one.
 *
 * Returns:
 *   Arguments for `docker`.
 *
 * Raises:
 *   Error: When the target is protected.
 */
export function restoreCommand(
  snapshotDirectory: string,
  fileName: string,
  volume: string,
): string[] {
  assertNotProtected(volume);
  return [
    'run',
    '--rm',
    '-v',
    `${snapshotDirectory}:/from:ro`,
    '-v',
    `${volume}:/to`,
    tarImage(),
    'sh',
    '-c',
    `tar xzf /from/${fileName} -C /to`,
  ];
}

export interface ComposeImage {
  service: string;
  reference: string;
  pinned: boolean;
}

/**
 * Every `image:` line in the compose file with the service it belongs to.
 *
 * Args:
 *   composeText: The compose file.
 *
 * Returns:
 *   One entry per service that names an image, in file order.
 */
export function composeImages(composeText: string): ComposeImage[] {
  const images: ComposeImage[] = [];
  let service = '';
  for (const line of composeText.split('\n')) {
    const serviceMatch = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (serviceMatch) {
      service = serviceMatch[1];
      continue;
    }
    const imageMatch = /^\s+image:\s*'?([^'#\s]+)'?\s*$/.exec(line);
    if (imageMatch && service) {
      const reference = imageMatch[1];
      images.push({ service, reference, pinned: /@sha256:[0-9a-f]{64}$/.test(reference) });
    }
  }
  return images;
}

/**
 * Replace or append `KEY=value` lines, keeping the file's trailing newline.
 *
 * The Convex CLI and `pnpm dev:no-auth-key` append to this file too, and a file
 * that ends without a newline gets its last value glued to the next key.
 *
 * Args:
 *   text: The env file's text.
 *   updates: Names and values to write.
 *
 * Returns:
 *   The new text.
 */
export function upsertEnvText(text: string, updates: Readonly<Record<string, string>>): string {
  const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
  for (const [key, value] of Object.entries(updates)) {
    const index = lines.findIndex((line: string): boolean =>
      new RegExp(`^\\s*${key}\\s*=`).test(line),
    );
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface BedPorts {
  backend: number;
  site: number;
  dashboard: number;
  fakeSlack: number;
}

/**
 * The host ports the compose file publishes, with its defaults.
 *
 * Args:
 *   values: What `.env.local` declares.
 *
 * Returns:
 *   The four host ports.
 */
export function bedPorts(values: Readonly<Record<string, string>>): BedPorts {
  const port = (name: string, fallback: number): number => {
    const parsed = Number.parseInt(values[name] ?? '', 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    backend: port('CONVEX_PORT', 3210),
    site: port('CONVEX_SITE_PROXY_PORT', 3211),
    dashboard: port('CONVEX_DASHBOARD_PORT', 6791),
    fakeSlack: port('FAKE_SLACK_HOST_PORT', 8090),
  };
}

export interface ServiceRow {
  service: string;
  state: string;
  health: 'healthy' | 'unhealthy' | 'starting' | 'none';
}

/**
 * Read `docker ps` output in the kit's tab-separated format.
 *
 * Args:
 *   stdout: Lines of `service<TAB>state<TAB>status`.
 *
 * Returns:
 *   One row per container.
 */
export function parseDockerPs(stdout: string): ServiceRow[] {
  return stdout
    .split('\n')
    .map((line: string): string => line.trim())
    .filter(Boolean)
    .map((line: string): ServiceRow => {
      const [service, state, status = ''] = line.split('\t');
      const health: ServiceRow['health'] = status.includes('(healthy)')
        ? 'healthy'
        : status.includes('(unhealthy)')
          ? 'unhealthy'
          : status.includes('(health: starting)')
            ? 'starting'
            : 'none';
      return { service, state, health };
    });
}

/**
 * The tier the arrival probe printed, if it printed one.
 *
 * Args:
 *   stdout: The probe's output.
 *
 * Returns:
 *   1, 2 or 3, or undefined when no verdict line is present.
 */
export function probeTier(stdout: string): 1 | 2 | 3 | undefined {
  const match = /^tier ([123]):/m.exec(stdout);
  if (!match) return undefined;
  return Number.parseInt(match[1], 10) as 1 | 2 | 3;
}

/**
 * The count and containment lines of a revocation report.
 *
 * Args:
 *   report: `trials.md` as the trial wrote it.
 *
 * Returns:
 *   The raw-count and time-to-block lines, in order.
 */
export function revocationSummary(report: string): string[] {
  return report
    .split('\n')
    .filter(
      (line: string): boolean => line.startsWith('- All:') || line.startsWith('Time to block'),
    );
}

export type ChecklistStatus = 'ok' | 'warn' | 'gap';

export interface ChecklistItem {
  label: string;
  status: ChecklistStatus;
  detail: string;
}

/**
 * The checklist as printed: one marker and label per line, gaps counted.
 *
 * Args:
 *   items: The checks, in the order to print them.
 *
 * Returns:
 *   The text.
 */
export function renderChecklist(items: readonly ChecklistItem[]): string {
  const marker = (status: ChecklistStatus): string =>
    status === 'ok' ? 'ok   ' : status === 'warn' ? 'note ' : 'GAP  ';
  const lines = items.map(
    (item: ChecklistItem): string =>
      `${marker(item.status)} ${item.label}${item.detail ? `\n        ${item.detail.split('\n').join('\n        ')}` : ''}`,
  );
  const gaps = items.filter((item: ChecklistItem): boolean => item.status === 'gap').length;
  lines.push('', gaps === 0 ? 'No gaps.' : `${gaps} gap${gaps === 1 ? '' : 's'}.`);
  return lines.join('\n');
}

export interface TierInputs {
  videoPresent: boolean;
  offlineRungReady: boolean;
  backendHealthy: boolean;
  /** Empty means api.openai.com, which is never dialled from the venue. */
  modelBaseUrl: string;
  probeTier: 1 | 2 | 3 | undefined;
}

export interface TierVerdict {
  name: string;
  go: boolean;
  reason: string;
}

/** True for the one host the operator must not call from China. */
function isOpenAi(baseUrl: string): boolean {
  return baseUrl.trim() === '' || /api\.openai\.com/i.test(baseUrl);
}

/**
 * Which of the three demo tiers are go, from the pre-flight facts.
 *
 * Args:
 *   inputs: What pre-flight established.
 *
 * Returns:
 *   The three tiers in order: video, offline rung, warm bed with a live model.
 */
export function demoTiers(inputs: TierInputs): TierVerdict[] {
  const video: TierVerdict = {
    name: 'Tier 1, the demo video',
    go: inputs.videoPresent,
    reason: inputs.videoPresent ? 'the file is on disk' : 'no video file found; queue it locally',
  };
  const rung: TierVerdict = {
    name: 'Tier 2, the offline rung (pnpm eval:revocation, no model call)',
    go: inputs.offlineRungReady,
    reason: inputs.offlineRungReady
      ? 'backend, fake-slack and looker-tile are up in real mode'
      : 'the backend, fake-slack or looker-tile is not up in real mode',
  };
  let warm: TierVerdict;
  if (isOpenAi(inputs.modelBaseUrl)) {
    warm = {
      name: 'Tier 3, the warm bed with a live model rung',
      go: false,
      reason: 'OPENAI_BASE_URL is empty or OpenAI; OpenAI is never called from the venue',
    };
  } else if (!inputs.backendHealthy) {
    warm = {
      name: 'Tier 3, the warm bed with a live model rung',
      go: false,
      reason: 'the backend is not healthy',
    };
  } else {
    warm = {
      name: 'Tier 3, the warm bed with a live model rung',
      go: inputs.probeTier === 1,
      reason:
        inputs.probeTier === 1
          ? 'the probe reached the model with the key (tier 1)'
          : inputs.probeTier === undefined
            ? 'the probe did not run or printed no verdict; run it before deciding'
            : `the probe verdict is tier ${inputs.probeTier}; stay on tiers 1 and 2 and retry on the next network path`,
    };
  }
  return [video, rung, warm];
}

/* ------------------------------------------------------------------------- */
/* Everything below talks to Docker, the backend or the file system.          */
/* ------------------------------------------------------------------------- */

type Values = Record<string, string>;

function readEnvFile(path: string = ENV_FILE): Values {
  const values: Values = {};
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return values;
}

function writeEnvValues(updates: Readonly<Record<string, string>>): void {
  writeFileSync(ENV_FILE, upsertEnvText(readFileSync(ENV_FILE, 'utf8'), updates), 'utf8');
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  command: string,
  args: readonly string[],
  options: { env?: Values; timeoutMs?: number; inherit?: boolean } = {},
): RunResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeoutMs,
    stdio: options.inherit ? ['inherit', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function must(result: RunResult, what: string): RunResult {
  if (result.status !== 0) {
    throw new Error(`${what} failed (status ${result.status}).\n${result.stdout}${result.stderr}`);
  }
  return result;
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function stamp(now: Date = new Date()): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
}

function elapsed(startedAt: number): string {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;
}

/** Everything the bed's child processes see: the shell, then the file, then the project. */
function bedEnvironment(options: DemoBedOptions, values: Values): Values {
  return { ...values, COMPOSE_PROJECT_NAME: options.project };
}

function composeArgs(
  options: DemoBedOptions,
  profiles: readonly string[] = options.profiles,
): string[] {
  return [
    'compose',
    '-p',
    options.project,
    '--env-file',
    ENV_FILE,
    ...profiles.flatMap((profile: string): string[] => ['--profile', profile]),
  ];
}

function projectServices(project: string): ServiceRow[] | undefined {
  const result = run(
    'docker',
    [
      'ps',
      '-a',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--format',
      '{{.Label "com.docker.compose.service"}}\t{{.State}}\t{{.Status}}',
    ],
    { timeoutMs: 15_000 },
  );
  if (result.status !== 0) return undefined;
  return parseDockerPs(result.stdout);
}

function volumeExists(name: string): boolean {
  return run('docker', ['volume', 'inspect', name], { timeoutMs: 15_000 }).status === 0;
}

function volumeInUse(name: string): string[] {
  const result = run(
    'docker',
    ['ps', '-a', '--filter', `volume=${name}`, '--format', '{{.Names}}'],
    { timeoutMs: 15_000 },
  );
  return result.stdout
    .split('\n')
    .map((line: string): string => line.trim())
    .filter(Boolean);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function portListening(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (open: boolean): void => {
      socket.destroy();
      resolvePromise(open);
    };
    socket.setTimeout(1_000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function backendVersion(port: number): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/version`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return undefined;
    return (await response.text()).trim();
  } catch {
    return undefined;
  }
}

async function waitForBackend(port: number, timeoutMs: number = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = await backendVersion(port);
    if (version) return version;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`the backend did not answer on 127.0.0.1:${port} within ${timeoutMs / 1000} s`);
}

/** A signed-in client for the fixed local boss, or the reason there is none. */
async function bossClient(
  values: Values,
): Promise<{ client: import('convex/browser').ConvexHttpClient } | { reason: string }> {
  const url = values.CONVEX_SELF_HOSTED_URL;
  if (!url) return { reason: 'CONVEX_SELF_HOSTED_URL is empty' };
  if (!values.DEV_NO_AUTH_SIGNING_KEY) return { reason: 'DEV_NO_AUTH_SIGNING_KEY is empty' };
  process.env.DEV_NO_AUTH_SIGNING_KEY = values.DEV_NO_AUTH_SIGNING_KEY;
  const { ConvexHttpClient } = await import('convex/browser');
  const { mintDevNoAuthToken } = await import('../src/lib/dev-auth-token');
  const client = new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true, logger: false });
  client.setAuth(await mintDevNoAuthToken());
  return { client };
}

/* --------------------------------- snapshot -------------------------------- */

function snapshot(options: DemoBedOptions): void {
  const source = options.fromVolume;
  if (!volumeExists(source)) throw new Error(`volume ${source} does not exist on this machine.`);
  const users = volumeInUse(source);
  if (users.length > 0) {
    throw new Error(
      `volume ${source} is attached to ${users.join(', ')}. Stop that backend first (without -v) so ` +
        'the SQLite files are quiescent; a tar of a live database is not a snapshot.',
    );
  }
  const target = resolve(options.snapshot ?? `${KIT_DIR}/snapshots/${source}-${stamp()}.tar.gz`);
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true });
  const startedAt = Date.now();
  log(`Snapshot of ${source} (mounted read-only) -> ${target}`);
  must(
    run('docker', snapshotCommand(source, directory, basename(target)), { inherit: true }),
    'tar',
  );
  const digest = sha256(target);
  writeFileSync(`${target}.sha256`, `${digest}  ${basename(target)}\n`, 'utf8');
  const size = statSync(target).size;
  log(
    `Wrote ${target} (${(size / 1024 / 1024).toFixed(1)} MB, sha256 ${digest}) in ${elapsed(startedAt)}.`,
  );
  log(`Restore with: pnpm demo:bed restore --snapshot ${target} --project <new project>`);
}

/* --------------------------------- restore --------------------------------- */

function restore(options: DemoBedOptions): void {
  if (!options.snapshot) throw new Error('restore needs --snapshot <file>.');
  const source = resolve(options.snapshot);
  if (!existsSync(source)) throw new Error(`${source} does not exist.`);
  const sidecar = `${source}.sha256`;
  if (existsSync(sidecar)) {
    const expected = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
    const actual = sha256(source);
    if (expected !== actual) {
      throw new Error(`${source} does not match ${sidecar}: expected ${expected}, got ${actual}.`);
    }
    log(`Checksum matches ${basename(sidecar)}.`);
  } else {
    log(`note: no ${basename(sidecar)} beside the snapshot, so its integrity is not checked.`);
  }
  const target = restoreTargetVolume(options.project);
  if (volumeExists(target)) {
    if (!options.replace) {
      throw new Error(
        `volume ${target} already exists. Pass --replace to drop it first, or pick another --project; ` +
          'a restore never writes into a volume that has data.',
      );
    }
    const users = volumeInUse(target);
    if (users.length > 0) {
      throw new Error(
        `volume ${target} is attached to ${users.join(', ')}; run "pnpm demo:bed down" first.`,
      );
    }
    must(run('docker', ['volume', 'rm', target]), `removing ${target}`);
    log(`Removed the previous ${target}.`);
  }
  // Labelled as compose labels its own volumes, so `up` adopts it in silence
  // rather than warning that it was created outside the project.
  must(
    run('docker', [
      'volume',
      'create',
      '--label',
      `com.docker.compose.project=${options.project}`,
      '--label',
      'com.docker.compose.volume=convex_data',
      target,
    ]),
    `creating ${target}`,
  );
  const startedAt = Date.now();
  log(`Restoring ${basename(source)} -> ${target}`);
  must(
    run('docker', restoreCommand(dirname(source), basename(source), target), { inherit: true }),
    'untar',
  );
  log(`Restored in ${elapsed(startedAt)}. Next: pnpm demo:bed up --project ${options.project}`);
}

/* ----------------------------------- up ------------------------------------ */

async function up(options: DemoBedOptions): Promise<void> {
  assertNotProtected(options.project);
  if (!existsSync(ENV_FILE)) {
    throw new Error(
      `${ENV_FILE} not found. Copy .env.example to ${ENV_FILE} and fill in the bed's values first.`,
    );
  }
  let values = readEnvFile();
  const ports = bedPorts(values);
  const derived: Values = {};
  if (!values.COMPOSE_PROJECT_NAME) derived.COMPOSE_PROJECT_NAME = options.project;
  if (values.COMPOSE_PROJECT_NAME && values.COMPOSE_PROJECT_NAME !== options.project) {
    throw new Error(
      `${ENV_FILE} says COMPOSE_PROJECT_NAME=${values.COMPOSE_PROJECT_NAME} and --project says ${options.project}; ` +
        'the file is the contract, so change one of them.',
    );
  }
  if (!values.CONVEX_SELF_HOSTED_URL)
    derived.CONVEX_SELF_HOSTED_URL = `http://127.0.0.1:${ports.backend}`;
  if (!values.NEXT_PUBLIC_CONVEX_URL)
    derived.NEXT_PUBLIC_CONVEX_URL = `http://127.0.0.1:${ports.backend}`;
  if (!values.NEXT_PUBLIC_CONVEX_SITE_URL)
    derived.NEXT_PUBLIC_CONVEX_SITE_URL = `http://127.0.0.1:${ports.site}`;
  if (Object.keys(derived).length > 0) {
    writeEnvValues(derived);
    log(`Wrote ${Object.keys(derived).join(', ')} to ${ENV_FILE}.`);
  }
  if (values.CONVEX_DEPLOYMENT) {
    throw new Error(
      `${ENV_FILE} carries CONVEX_DEPLOYMENT=${values.CONVEX_DEPLOYMENT}. A self-hosted bed must not; ` +
        'remove that line (and any .convex/ directory an anonymous deployment left) before continuing.',
    );
  }
  const env = bedEnvironment(options, readEnvFile());

  const startedAt = Date.now();
  log(`[1/7] Keys: pnpm dev:no-auth-key (no-op when ${ENV_FILE} already has them)`);
  must(
    run('pnpm', ['exec', 'tsx', 'scripts/dev-no-auth-key.ts', 'init'], { env, inherit: true }),
    'dev:no-auth-key',
  );
  values = readEnvFile();

  log(
    `[2/7] Documentation directory, then compose up (${options.profiles.join(', ')}), images never pulled`,
  );
  must(
    run('pnpm', ['exec', 'tsx', 'scripts/dev-docs-dir.ts'], {
      env: bedEnvironment(options, values),
      inherit: true,
    }),
    'docs dir',
  );
  must(
    run('docker', [...composeArgs(options), 'up', '-d', '--pull', 'never', '--no-build'], {
      env: bedEnvironment(options, values),
      inherit: true,
    }),
    'docker compose up',
  );
  const version = await waitForBackend(ports.backend);
  log(`      backend ${version} on 127.0.0.1:${ports.backend} after ${elapsed(startedAt)}`);

  log("[3/7] Admin key from the volume's own instance secret");
  const keyResult = must(
    run(
      'docker',
      [...composeArgs(options, ['real']), 'exec', '-T', 'backend', './generate_admin_key.sh'],
      {
        env: bedEnvironment(options, values),
        timeoutMs: 60_000,
      },
    ),
    'generate_admin_key.sh',
  );
  const adminKey = keyResult.stdout
    .split('\n')
    .map((line: string): string => line.trim())
    .filter((line: string): boolean => line.includes('|'))
    .pop();
  if (!adminKey)
    throw new Error(
      `generate_admin_key.sh printed no key:\n${keyResult.stdout}${keyResult.stderr}`,
    );
  if (values.CONVEX_SELF_HOSTED_ADMIN_KEY !== adminKey) {
    writeEnvValues({ CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey });
    log(`      wrote CONVEX_SELF_HOSTED_ADMIN_KEY (${adminKey.split('|')[0]}|...) to ${ENV_FILE}`);
  } else {
    log('      the key in the file already matches this volume');
  }
  values = readEnvFile();
  const pushEnv = bedEnvironment(options, values);

  log('[4/7] Deployment env: ./scripts/sync-convex-env.sh');
  must(
    run('bash', ['scripts/sync-convex-env.sh', ENV_FILE], { env: pushEnv, inherit: true }),
    'sync:env',
  );

  log('[5/7] Functions: convex dev --once');
  const pushStartedAt = Date.now();
  must(
    run('pnpm', ['exec', 'convex', 'dev', '--once', '--typecheck', 'disable'], {
      env: pushEnv,
      inherit: true,
    }),
    'convex dev --once',
  );
  log(`      pushed in ${elapsed(pushStartedAt)}`);

  log('[6/7] Restart the backend so the pushed env is what the modules read');
  must(
    run('docker', [...composeArgs(options, ['real']), 'restart', 'backend'], {
      env: pushEnv,
      inherit: true,
    }),
    'restart',
  );
  await waitForBackend(ports.backend);

  if (options.reset) {
    log(
      `[7/7] Reset the local boss's agents${options.unlink ? ', documentation and credentials' : ''}`,
    );
    const boss = await bossClient(values);
    if ('reason' in boss) throw new Error(`cannot reset: ${boss.reason}`);
    const { api } = await import('../convex/_generated/api');
    const result = await boss.client.mutation(api.reset.deleteMyData, {
      alsoUnlinkDocumentation: options.unlink,
    });
    log(`      deleted ${result.deleted} agent(s), unlinked ${result.unlinkedSources} source(s)`);
  } else {
    log("[7/7] No reset asked for; the volume's agents stay");
  }
  log(`Up in ${elapsed(startedAt)}.`);
  if (options.preflight) {
    log('');
    await preflight(options);
  }
}

/* -------------------------------- preflight -------------------------------- */

interface SurfaceSummary {
  agents: number;
  verdicts: Record<string, number>;
  docSources: string[];
}

async function surfacesState(values: Values): Promise<SurfaceSummary | string> {
  const boss = await bossClient(values);
  if ('reason' in boss) return boss.reason;
  try {
    const { api } = await import('../convex/_generated/api');
    const agents = await boss.client.query(api.agents.listForUser, {});
    const verdicts: Record<string, number> = {};
    for (const agent of agents) {
      const surfaces = await boss.client.query(api.surfaces.listForAgent, { agentId: agent._id });
      for (const surface of surfaces)
        verdicts[surface.verdict] = (verdicts[surface.verdict] ?? 0) + 1;
    }
    const sources = await boss.client.query(api.docSources.listMine, {});
    return {
      agents: agents.length,
      verdicts,
      docSources: sources.map(
        (source): string =>
          `${source.kind} "${source.label}": ${source.status}, ${source.pageCount} pages`,
      ),
    };
  } catch (error) {
    return (error as Error).message.split('\n')[0];
  }
}

async function preflight(options: DemoBedOptions): Promise<number> {
  const values = readEnvFile();
  const ports = bedPorts(values);
  const items: ChecklistItem[] = [];
  const startedAt = Date.now();

  const docker = run('docker', ['version', '--format', '{{.Server.Version}}'], {
    timeoutMs: 15_000,
  });
  items.push({
    label: 'Docker',
    status: docker.status === 0 ? 'ok' : 'gap',
    detail:
      docker.status === 0
        ? `engine ${docker.stdout.trim()}`
        : 'the daemon did not answer; start Docker',
  });

  const images = composeImages(readFileSync(COMPOSE_FILE, 'utf8'));
  const missing: string[] = [];
  const unpinned = images.filter((image: ComposeImage): boolean => !image.pinned);
  for (const image of images) {
    if (run('docker', ['image', 'inspect', image.reference], { timeoutMs: 15_000 }).status !== 0) {
      missing.push(`${image.service} (${image.reference})`);
    }
  }
  items.push({
    label: `Images: ${images.length - missing.length}/${images.length} present, ${images.length - unpinned.length}/${images.length} pinned`,
    status: missing.length > 0 ? 'gap' : unpinned.length > 0 ? 'warn' : 'ok',
    detail: [
      ...missing.map(
        (name: string): string => `missing: ${name}; pull it before travelling, not at the venue`,
      ),
      ...unpinned.map(
        (image: ComposeImage): string => `unpinned: ${image.service} (${image.reference})`,
      ),
    ].join('\n'),
  });

  const services = projectServices(options.project);
  const running = (name: string): boolean =>
    services?.some((row: ServiceRow): boolean => row.service === name && row.state === 'running') ??
    false;
  const healthy = (name: string): boolean =>
    services?.some(
      (row: ServiceRow): boolean => row.service === name && row.health === 'healthy',
    ) ?? false;
  items.push({
    label: `Compose project ${options.project}`,
    status:
      services === undefined
        ? 'gap'
        : services.length === 0
          ? 'gap'
          : running('backend')
            ? 'ok'
            : 'gap',
    detail:
      services === undefined
        ? 'docker ps could not be asked'
        : services.length === 0
          ? 'no containers; run pnpm demo:bed up'
          : services
              .map(
                (row: ServiceRow): string =>
                  `${row.service}: ${row.state}${row.health === 'none' ? '' : ` (${row.health})`}`,
              )
              .join('\n'),
  });

  const expected: Array<[string, number, boolean]> = [
    ['backend', ports.backend, running('backend')],
    ['site proxy', ports.site, running('backend')],
    ['dashboard', ports.dashboard, running('dashboard')],
    ['fake-slack', ports.fakeSlack, running('fake-slack')],
  ];
  const portLines: string[] = [];
  let portGap = false;
  for (const [name, port, wanted] of expected) {
    const open = await portListening(port);
    if (wanted && !open) portGap = true;
    portLines.push(
      `${port} ${name}: ${open ? 'listening' : 'closed'}${wanted && !open ? ' (expected open)' : ''}`,
    );
  }
  items.push({ label: 'Host ports', status: portGap ? 'gap' : 'ok', detail: portLines.join('\n') });

  const version = await backendVersion(ports.backend);
  items.push({
    label: 'Backend answers /version',
    status: version ? 'ok' : 'gap',
    detail: version
      ? `${values.CONVEX_SELF_HOSTED_URL || `http://127.0.0.1:${ports.backend}`} is ${version}`
      : 'no answer',
  });

  const docsDir = values.DAY0_DOCS_HOST_DIR || './docs-local';
  const pages = existsSync(docsDir)
    ? readdirSync(docsDir, { recursive: true }).filter((entry): boolean =>
        String(entry).endsWith('.md'),
      ).length
    : 0;
  items.push({
    label: `Documentation folder ${docsDir}`,
    status: pages > 0 ? 'ok' : 'warn',
    detail:
      pages > 0
        ? `${pages} markdown page(s)`
        : 'no markdown pages; the offline rung links this folder and needs at least one',
  });

  let surfaceMode = values.DAY0_SURFACE_MODE || 'mock';
  let backendModel = '';
  let backendSandbox = '';
  if (version) {
    const boss = await bossClient(values);
    if (!('reason' in boss)) {
      try {
        const { api } = await import('../convex/_generated/api');
        const mode = await boss.client.query(api.config.surfaceMode, {});
        surfaceMode = mode.mode;
        const model = await boss.client.query(api.config.modelSettings, {});
        backendModel = model.model;
        backendSandbox = model.skillSandboxBackend;
      } catch (error) {
        items.push({
          label: 'Backend config',
          status: 'gap',
          detail: (error as Error).message.split('\n')[0],
        });
      }
    }
  }
  const localModel = values.OPENAI_MODEL || 'gpt-5.6-terra';
  items.push({
    label: `Surface mode ${surfaceMode}; backend model ${backendModel || '(unknown)'}`,
    status: surfaceMode === 'real' && backendModel === localModel ? 'ok' : 'gap',
    detail: [
      surfaceMode === 'real'
        ? 'real mode, as the rung requires'
        : 'not real mode; the offline rung refuses',
      backendModel === localModel
        ? `OPENAI_MODEL agrees on both sides (${localModel})`
        : `OPENAI_MODEL is ${localModel} locally and ${backendModel || 'unknown'} on the deployment; re-run sync:env and restart`,
      `local OPENAI_BASE_URL ${values.OPENAI_BASE_URL || '(empty: api.openai.com)'}; the deployment verifies skills in the ${backendSandbox || 'unknown'} sandbox`,
    ].join('\n'),
  });

  const surfaces = version ? await surfacesState(values) : 'the backend is down';
  items.push({
    label: 'Surfaces and documentation on the bed',
    status: typeof surfaces === 'string' ? 'warn' : 'ok',
    detail:
      typeof surfaces === 'string'
        ? `could not be read: ${surfaces}`
        : [
            `${surfaces.agents} agent(s); surfaces by verdict: ${
              Object.entries(surfaces.verdicts)
                .map(([verdict, count]): string => `${verdict} ${count}`)
                .join(', ') || 'none'
            }`,
            ...surfaces.docSources,
          ].join('\n'),
  });

  const rungReady =
    surfaceMode === 'real' && !!version && healthy('fake-slack') && healthy('looker-tile');
  items.push({
    label: 'Offline rung doubles',
    status: rungReady ? 'ok' : 'gap',
    detail: `fake-slack ${healthy('fake-slack') ? 'healthy' : 'not healthy'}, looker-tile ${healthy('looker-tile') ? 'healthy' : 'not healthy'}, sandbox ${healthy('sandbox') ? 'healthy' : 'not healthy'}`,
  });

  let tier: 1 | 2 | 3 | undefined;
  const baseUrl = values.OPENAI_BASE_URL ?? '';
  if (!options.probe) {
    items.push({ label: 'Model probe skipped (--no-probe)', status: 'warn', detail: '' });
  } else if (isOpenAi(baseUrl)) {
    items.push({
      label: 'Model probe not run',
      status: 'gap',
      detail:
        'OPENAI_BASE_URL is empty or OpenAI. Point it at the Featherless route before the venue.',
    });
  } else {
    const probeStartedAt = Date.now();
    const probe = run(
      'bash',
      [
        PROBE_SCRIPT,
        '--base-url',
        baseUrl,
        '--model',
        localModel,
        '--key-var',
        'OPENAI_API_KEY',
        '--env-file',
        ENV_FILE,
        '--timeout',
        String(options.probeTimeout),
        '--no-catalogue',
        '--no-reference',
      ],
      { env: values, timeoutMs: (options.probeTimeout * 8 + 60) * 1000 },
    );
    tier = probeTier(probe.stdout);
    const verdictLine = probe.stdout
      .split('\n')
      .find((line: string): boolean => /^tier [123]:/.test(line));
    items.push({
      label: `Model probe: ${verdictLine ?? `no verdict (status ${probe.status})`}`,
      status: tier === 1 ? 'ok' : tier === undefined ? 'gap' : 'warn',
      detail: `${baseUrl} ${localModel}, ${elapsed(probeStartedAt)}${tier === undefined ? `\n${probe.stderr.trim().split('\n').slice(-3).join('\n')}` : ''}`,
    });
  }

  const video = options.video ?? values.DAY0_DEMO_VIDEO ?? '';
  const videoPresent = !!video && existsSync(video);
  items.push({
    label: 'Demo video queued locally',
    status: videoPresent ? 'ok' : 'gap',
    detail: videoPresent
      ? `${video}, ${(statSync(video).size / 1024 / 1024).toFixed(1)} MB`
      : video
        ? `${video} does not exist`
        : `no path: set DAY0_DEMO_VIDEO in ${ENV_FILE} or pass --video`,
  });

  log(
    `Pre-flight for compose project ${options.project}, read from ${ENV_FILE} (${elapsed(startedAt)})\n`,
  );
  log(renderChecklist(items));
  log('');
  const tiers = demoTiers({
    videoPresent,
    offlineRungReady: rungReady,
    backendHealthy: !!version,
    modelBaseUrl: baseUrl,
    probeTier: tier,
  });
  for (const verdict of tiers)
    log(`${verdict.go ? 'GO   ' : 'NO-GO'} ${verdict.name}: ${verdict.reason}`);
  return items.some((item: ChecklistItem): boolean => item.status === 'gap') ? 1 : 0;
}

/* ------------------------------- offline rung ------------------------------ */

function offlineRung(options: DemoBedOptions): void {
  assertNotProtected(options.project);
  const values = readEnvFile();
  const services = projectServices(options.project) ?? [];
  for (const name of ['backend', 'fake-slack', 'looker-tile']) {
    if (
      !services.some((row: ServiceRow): boolean => row.service === name && row.state === 'running')
    ) {
      throw new Error(
        `${name} is not running in project ${options.project}; run pnpm demo:bed up first.`,
      );
    }
  }
  if ((values.DAY0_SURFACE_MODE || 'mock') !== 'real') {
    throw new Error(`DAY0_SURFACE_MODE must be real in ${ENV_FILE} for the revocation trial.`);
  }
  const ports = bedPorts(values);
  const out = resolve(options.out ?? `${KIT_DIR}/revocation-${stamp()}`);
  const env: Values = {
    ...bedEnvironment(options, values),
    DAY0_EVAL_COMPOSE_PROJECT: options.project,
    FAKE_SLACK_PROOF_URL: `http://127.0.0.1:${ports.fakeSlack}`,
    // The bundled sandbox verifies the trial's skills; a Daytona key would win over it.
    DAYTONA_API_KEY: '',
  };
  log(
    `Offline rung: pnpm eval:revocation against fake-slack (127.0.0.1:${ports.fakeSlack}) and looker-tile`,
  );
  log(`Results: ${out}`);
  const startedAt = Date.now();
  const result = run('pnpm', ['eval:revocation', '--', '--out', out], { env, inherit: true });
  const took = elapsed(startedAt);
  if (result.status !== 0)
    throw new Error(`eval:revocation failed after ${took} (status ${result.status}).`);
  const report = `${out}/trials.md`;
  log('');
  log(`Wall clock: ${took}`);
  if (existsSync(report))
    for (const line of revocationSummary(readFileSync(report, 'utf8'))) log(line);
}

/* ---------------------------------- down ----------------------------------- */

function down(options: DemoBedOptions): void {
  assertNotProtected(options.project);
  const values = readEnvFile();
  const profiles = Object.keys(PROFILES);
  const args = [...composeArgs(options, profiles), 'down'];
  if (options.volumes) {
    for (const suffix of ['convex_data', 'sandbox_socket', 'model_data']) {
      assertNotProtected(`${options.project}_${suffix}`);
    }
    args.push('--volumes');
  }
  must(
    run('docker', args, { env: bedEnvironment(options, values), inherit: true }),
    'docker compose down',
  );
  log(
    options.volumes
      ? `Project ${options.project} is down and its volumes are gone.`
      : `Project ${options.project} is down; its volumes stay.`,
  );
}

/* ---------------------------------- main ----------------------------------- */

async function main(): Promise<number> {
  let options: DemoBedOptions;
  try {
    options = parseDemoBedArguments(process.argv.slice(2), readEnvFile());
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith('Usage:')) {
      log(message);
      return 0;
    }
    process.stderr.write(`error: ${message}\n`);
    return 2;
  }
  try {
    switch (options.command) {
      case 'snapshot':
        snapshot(options);
        return 0;
      case 'restore':
        restore(options);
        return 0;
      case 'up':
        await up(options);
        return 0;
      case 'preflight':
        return await preflight(options);
      case 'offline-rung':
        offlineRung(options);
        return 0;
      case 'down':
        down(options);
        return 0;
    }
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Handed back rather than passed to process.exit so a piped stdout drains.
  process.exitCode = await main();
}
