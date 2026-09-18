/// <reference types="node" />
/**
 * The demo bed kit: one command per thing the demo laptop has to do.
 *
 *   pnpm demo:bed snapshot                       # tar of a completed run's data volume, read-only
 *   pnpm demo:bed restore --snapshot <tar>       # that tar into a NEW volume for this project
 *   pnpm demo:bed up [--warm-from <p>] [--reset] # the real-mode stack from pre-pulled images
 *   pnpm demo:bed preflight [--video <file>]     # the checklist and the tier verdict
 *   pnpm demo:bed offline-rung                   # the revocation trial against the doubles
 *   pnpm demo:bed down [--volumes]               # stop it; drop this project's volumes if asked
 *
 * The bed's contract is `.env.local` in this checkout, the same file every
 * other `pnpm` command reads, and the compose project is its
 * `COMPOSE_PROJECT_NAME` (or `--project`). Every subcommand refuses the two
 * projects whose volumes hold real runs (`day0`, `day0-demo-7c65e7`) and the
 * warm redactor project (`day0-redactor-warm`); the only thing this file ever
 * does to one of those volumes is mount it read-only, for `snapshot` or for
 * the redactor clone `up --warm-from` makes.
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
import {
  requirementsDigests,
  venvDevice,
  venvStampCommand,
  type VenvDevice,
} from './redactor-device';

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

/**
 * Projects whose volumes are only ever copied from (`--warm-from`). Not a real
 * run, but nothing here starts, restores into, resets or removes them either;
 * the list matches `READ_ONLY_PROJECTS` in `scripts/setup.ts`.
 */
export const READ_ONLY_PROJECTS: readonly string[] = ['day0-redactor-warm'];

/** The completed run the demo restores by default. */
export const DEFAULT_SNAPSHOT_SOURCE = 'day0-demo-7c65e7_convex_data';

/** Where the redactor answers, as the deployment must address it. */
export const REDACTOR_URL = 'http://redactor:8000';

/** The fix when the redactor container is not healthy; the rung's folder sync would fail closed. */
const REDACTOR_UNHEALTHY_FIX =
  'the redactor is not healthy, and real-mode documentation sync fails closed without it, so the rung ' +
  'stops at its folder sync; run pnpm demo:bed up --warm-from <warm project> and wait for the ' +
  'redactor to report healthy';

/** The fix when the backend has no redactor address to sync with. */
const REDACTOR_UNWIRED_FIX =
  `DAY0_REDACTOR_URL is empty in ${ENV_FILE} or on the deployment, so the backend has no redactor to ` +
  `sync with; set it to ${REDACTOR_URL} and re-run pnpm demo:bed up`;

/** What `pnpm eval:revocation` writes into `--out`, in `sha256sum` order. */
export const RUNG_OUTPUT_FILES: readonly string[] = [
  'commands.txt',
  'trace-agent.json',
  'trials.json',
  'trials.md',
];

/**
 * What a demo bed runs: day0 itself, the sandbox that verifies a skill, the
 * two doubles the offline rung is measured against, the browser component,
 * without which the recorded run's tile card flips to `ungranted` on the first
 * re-probe after bring-up (seen 12 Sep 2026), and the redactor, without which
 * real-mode documentation sync fails closed and the rung stops at its folder
 * sync. The dashboard and the Notion component are opt-in with `--profile`.
 */
export const BED_PROFILES: readonly string[] = [
  'real',
  'sandbox',
  'test',
  'demo',
  'browser',
  'redactor',
];

/** The redactor's cache volumes, in the order the compose file declares them. */
const REDACTOR_VOLUME_SUFFIXES: readonly string[] = ['redactor_venv', 'redactor_models'];

/** Where the bundled browser component answers, as the deployment must address it. */
const BROWSER_MCP_URL = 'http://playwright-mcp:8931/mcp';

/** The backend's own port, which the compose file publishes `CONVEX_PORT` from. */
const CONTAINER_BACKEND_PORT = 3210;

/**
 * Where the Slack double answers, as the deployment must address it.
 *
 * `slackApiBaseUrl()` only leaves slack.com for a local no-auth real-mode bed
 * whose `DAY0_TEST_SLACK_API_URL` names `fake-slack` on the compose network. The
 * key is empty in `.env.example` and sits in the sync script's CLEAR_WHEN_EMPTY
 * list, so a bed that does not set it sends the double's synthetic token to the
 * real Slack, which answers `invalid_auth`, and the rung's first probe ends
 * `ungranted`. The port is the container's own, not the published one.
 */
const TEST_SLACK_API_URL = 'http://fake-slack:8090/api/';

/** The agent `pnpm eval:revocation` deploys; its presence means the bed is spent. */
const RUNG_AGENT_NAME = 'Day0 revocation evaluation';

/**
 * The rung's own agents, whose events say whether the trial ids are spent.
 *
 * Args:
 *   agents: The boss's agents as the deployment lists them.
 *
 * Returns:
 *   Those the rung deployed, newest first as the deployment ordered them.
 */
export function rungAgents<T extends { name: string }>(agents: readonly T[]): T[] {
  return agents.filter((agent: T): boolean => agent.name === RUNG_AGENT_NAME);
}

/**
 * Whether a rung has seeded its trials on this volume, so a second one fails.
 *
 * The trial's work rows are keyed `EVAL-rev-scope-01` and up, and the index
 * they are looked up by is `(sourceSystem, externalId)` alone
 * (`convex/revocationEvaluation.ts`), so the ids are unique per *volume*, not
 * per agent. A second rung on the same volume dies with
 * `trial rev-scope-01 already exists` around a minute in, after the onboarding
 * has been paid for. Restoring the snapshot again is the cheap way back.
 *
 * A run that died in onboarding leaves its agent behind and seeds nothing, and
 * that bed is still good: the trial id, not the agent, is what is spent, so the
 * seeded event is what this reads.
 *
 * Args:
 *   events: Events on one of the rung's agents.
 *
 * Returns:
 *   Whether any trial was seeded.
 */
export function trialIdsSpent(events: readonly { payload: unknown }[]): boolean {
  return events.some(
    (event: { payload: unknown }): boolean =>
      typeof (event.payload as { trialId?: unknown } | null)?.trialId === 'string',
  );
}

/**
 * Whether any of the boss's agents shows a seeded trial on this volume.
 *
 * Args:
 *   agents: The boss's agents as the deployment lists them.
 *   readEvents: Reads one agent's recent events; the caller owns the client.
 *
 * Returns:
 *   Whether the trial ids on this volume are spent.
 */
async function volumeSpent<T extends { name: string }>(
  agents: readonly T[],
  readEvents: (agent: T) => Promise<Array<{ payload: unknown }>>,
): Promise<boolean> {
  for (const agent of rungAgents(agents)) {
    if (trialIdsSpent(await readEvents(agent))) return true;
  }
  return false;
}

const SYNC_SCRIPT = 'scripts/sync-convex-env.sh';

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
  /** `up`: the project whose redactor volumes are cloned, read-only, into this one's. */
  warmFrom?: string;
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
  --warm-from <project>  up: clone that project's redactor volumes (read-only) into this one's
  --video <file>         preflight: the queued video (default: DAY0_DEMO_VIDEO in ${ENV_FILE})
  --from-volume <name>   snapshot: source volume (default: ${DEFAULT_SNAPSHOT_SOURCE})
  --snapshot <file>      snapshot: output path; restore: input path
  --replace              restore: drop an existing target volume first (never a protected one)
  --out <dir>            offline-rung: new results directory, SHA256SUMS included
                         (default: ${KIT_DIR}/revocation-<stamp>; evidence: evaluation/results/revocation-<stamp>)
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
      case '--warm-from':
        options.warmFrom = valueOf(index, flag);
        index += 1;
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
 * Refuse a project this kit may not run as: a protected one, or a read-only
 * warm project. `assertNotProtected` stays the weaker check because the
 * redactor clone reads a warm project's volumes through it.
 *
 * Args:
 *   name: A compose project name.
 *
 * Raises:
 *   Error: When the project is protected or read-only.
 */
export function assertBedProject(name: string): void {
  assertNotProtected(name);
  if (READ_ONLY_PROJECTS.includes(name)) {
    throw new Error(
      `"${name}" holds the warm redactor volumes this kit clones from (--warm-from). It is only ever read: ` +
        'nothing here starts, restores into, resets or removes it. Pick another --project.',
    );
  }
}

/**
 * Every volume `down --volumes` would remove for a project, each one checked.
 *
 * Args:
 *   project: The compose project name.
 *
 * Returns:
 *   The five volume names the compose file declares, prefixed with the project.
 *
 * Raises:
 *   Error: When the project, or any of its volumes, is protected or read-only.
 */
export function projectVolumeNames(project: string): string[] {
  assertBedProject(project);
  return ['convex_data', 'sandbox_socket', 'model_data', 'redactor_venv', 'redactor_models'].map(
    (suffix: string): string => {
      const volume = `${project}_${suffix}`;
      assertNotProtected(volume);
      return volume;
    },
  );
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
 *   Error: When the project is protected or read-only.
 */
export function restoreTargetVolume(project: string): string {
  assertBedProject(project);
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
    'tar',
    'czf',
    `/to/${fileName}`,
    '-C',
    '/from',
    '.',
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
    'tar',
    'xzf',
    `/from/${fileName}`,
    '-C',
    '/to',
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
  /** `docker ps`'s published ports column, empty when none are published. */
  ports: string;
}

/**
 * Read `docker ps` output in the kit's tab-separated format.
 *
 * Args:
 *   stdout: Lines of `service<TAB>state<TAB>status<TAB>ports`.
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
      const [service, state, status = '', ports = ''] = line.split('\t');
      const health: ServiceRow['health'] = status.includes('(healthy)')
        ? 'healthy'
        : status.includes('(unhealthy)')
          ? 'unhealthy'
          : status.includes('(health: starting)')
            ? 'starting'
            : 'none';
      return { service, state, health, ports: ports.trim() };
    });
}

/**
 * The host port a container publishes one of its ports on.
 *
 * Args:
 *   ports: `docker ps`'s ports column, `host:port->container/proto` entries.
 *   containerPort: The container port to look for.
 *
 * Returns:
 *   The host port, or undefined when that container port is not published.
 */
export function publishedHostPort(ports: string, containerPort: number): number | undefined {
  for (const entry of ports.split(',')) {
    const match = /:(\d+)->(\d+)\/(?:tcp|udp)$/.exec(entry.trim());
    if (match && Number.parseInt(match[2], 10) === containerPort) {
      return Number.parseInt(match[1], 10);
    }
  }
  return undefined;
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

/**
 * The keys `scripts/sync-convex-env.sh` pushes, read off the script itself.
 *
 * The sync script skips a key that is empty in the file, which is right for a
 * fresh deployment and wrong for a restored one: the recording bed's OpenAI,
 * Daytona and Exa keys stay on the deployment, and the first is then sent to
 * whichever host `OPENAI_BASE_URL` names. `up` clears those; this is the list
 * it clears from, so the two scripts cannot drift apart.
 *
 * Args:
 *   scriptText: The sync script.
 *
 * Returns:
 *   The names inside its `KEYS=( ... )` block, in order.
 *
 * Raises:
 *   Error: When the block is not found.
 */
export function syncScriptKeys(scriptText: string): string[] {
  const block = /^KEYS=\(\n([\s\S]*?)^\)/m.exec(scriptText);
  if (!block) throw new Error(`${SYNC_SCRIPT} has no KEYS=( ... ) block to read.`);
  return block[1]
    .split('\n')
    .map((line: string): string => line.replace(/#.*$/, '').trim())
    .filter((line: string): boolean => /^[A-Z][A-Z0-9_]*$/.test(line));
}

/**
 * Deployment variables to remove: present there, empty in the file, and among
 * the keys the sync script would otherwise leave alone.
 *
 * Args:
 *   fileValues: What `.env.local` declares.
 *   deploymentValues: What `convex env list` reports.
 *   keys: The sync script's key list.
 *
 * Returns:
 *   The names to clear, in the sync script's order.
 */
export function secretsToClear(
  fileValues: Readonly<Record<string, string>>,
  deploymentValues: Readonly<Record<string, string>>,
  keys: readonly string[],
): string[] {
  return keys.filter(
    (key: string): boolean => !(fileValues[key] ?? '') && (deploymentValues[key] ?? '') !== '',
  );
}

/**
 * The credential key to write into the file, if the volume's differs.
 *
 * Stored credentials were encrypted under the key the recording bed ran with,
 * which a restored volume still carries in its deployment env until the sync
 * overwrites it. Keeping the file's own key would leave every stored
 * credential unreadable and every connected card failing its next probe.
 *
 * Args:
 *   fileValue: `DAY0_CREDENTIAL_KEY` in the file.
 *   deploymentValue: `DAY0_CREDENTIAL_KEY` on the restored deployment.
 *
 * Returns:
 *   The deployment's key when it is set and differs, else undefined.
 */
export function credentialKeyToAdopt(
  fileValue: string,
  deploymentValue: string | undefined,
): string | undefined {
  if (!deploymentValue) return undefined;
  return deploymentValue === fileValue ? undefined : deploymentValue;
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
  /**
   * The env file resolves Slack to the double. Without it the rung's first
   * probe sends a synthetic token to slack.com and ends `ungranted`.
   */
  slackDoubleWired: boolean;
  /** A rung has already run on this volume, so its trial ids are spent. */
  rungAlreadyRun: boolean;
  /** The redactor container reports healthy; real-mode documentation sync fails closed without it. */
  redactorHealthy: boolean;
  /** `DAY0_REDACTOR_URL` names the redactor in the file and on the deployment. */
  redactorWired: boolean;
  /**
   * What the *deployment* dials for a model, which is not always what the host
   * dials: the rung's onboarding runs inside the backend container.
   */
  rungModelRoute: string;
  deploymentModelSettings?: {
    OPENAI_MAX_OUTPUT_TOKENS?: string;
    OPENAI_REASONING_EFFORT?: string;
  };
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
    name: 'Tier 2, the offline rung (pnpm eval:revocation; its measurements are model-free, its onboarding is not)',
    go:
      inputs.offlineRungReady &&
      inputs.redactorHealthy &&
      inputs.redactorWired &&
      inputs.slackDoubleWired &&
      !inputs.rungAlreadyRun &&
      !isOpenAi(inputs.rungModelRoute),
    reason: !inputs.offlineRungReady
      ? 'the backend, fake-slack or looker-tile is not up in real mode'
      : !inputs.redactorHealthy
        ? REDACTOR_UNHEALTHY_FIX
        : !inputs.redactorWired
          ? REDACTOR_UNWIRED_FIX
          : !inputs.slackDoubleWired
            ? `DAY0_TEST_SLACK_API_URL does not name the double, so the rung's Slack probe ends ungranted; set it to ${TEST_SLACK_API_URL} and re-run pnpm demo:bed up`
            : inputs.rungAlreadyRun
              ? 'this volume has already run the rung and its trial ids are spent; down --volumes, restore the snapshot again, then up'
              : isOpenAi(inputs.rungModelRoute)
                ? "the rung's onboarding would dial OpenAI, which is never called from the venue; point CONVEX_OPENAI_BASE_URL at the bundled model or the Featherless route"
                : `backend, fake-slack, looker-tile and the redactor are up in real mode, and the onboarding dials ${inputs.rungModelRoute}; model onboarding remains unverified by this checklist`,
  };
  let warm: TierVerdict;
  const missingSettings = (['OPENAI_MAX_OUTPUT_TOKENS', 'OPENAI_REASONING_EFFORT'] as const)
    .filter((key) => !inputs.deploymentModelSettings?.[key]?.trim());
  if (isOpenAi(inputs.modelBaseUrl) || isOpenAi(inputs.rungModelRoute)) {
    warm = {
      name: 'Tier 3, the warm bed with a live model rung',
      go: false,
      reason: 'The host or backend model route is empty or OpenAI; OpenAI is never called from the venue',
    };
  } else if (missingSettings.length > 0) {
    warm = {
      name: 'Tier 3, the warm bed with a live model rung',
      go: false,
      reason: `missing on the deployment: ${missingSettings.join(', ')}; set both output settings, run pnpm sync:env and restart the backend`,
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
          ? 'the small-prompt probe reached the host model route (tier 1); backend reachability and model onboarding remain unverified by this probe'
          : inputs.probeTier === undefined
            ? 'the probe did not run or printed no verdict; run it before deciding'
            : `the probe verdict is tier ${inputs.probeTier}; stay on tiers 1 and 2 and retry on the next network path`,
    };
  }
  return [video, rung, warm];
}

/**
 * Why a volume cannot be tarred now, if it cannot.
 *
 * A running container may be writing the SQLite files; a stopped one holds
 * nothing open, so the protocol's "stop the backend for the seconds the
 * snapshot takes" is enough.
 *
 * Args:
 *   volume: The volume to read.
 *   runningHolders: Names of running containers that have it mounted.
 *
 * Returns:
 *   The refusal, or undefined when no running container holds it.
 */
export function snapshotRefusal(volume: string, runningHolders: readonly string[]): string | undefined {
  if (runningHolders.length === 0) return undefined;
  return (
    `volume ${volume} is attached to the running ${runningHolders.join(', ')}. Stop that container first ` +
    '(docker compose stop backend, or pnpm demo:bed down without --volumes) so the SQLite files are ' +
    'quiescent; a tar of a live database is not a snapshot.'
  );
}

export interface VolumeClone {
  volume: string;
  create: string[];
  copy: string[];
}

export interface WarmRedactorInput {
  /** The bed. */
  project: string;
  /** The project whose redactor volumes are copied; omitted means the bed's own must exist. */
  warmFrom?: string;
  /** `docker volume ls` on this machine. */
  volumes: readonly string[];
  /** The pinned node image to copy with. */
  image: string;
}

export interface WarmRedactorPlan {
  /** One create and one copy command per volume; empty when the bed's own are kept. */
  clone: VolumeClone[];
  /** The venv volume whose stamp says which wheels the redactor will find. */
  sourceVenv: string;
  /** What the terminal says about the choice. */
  note: string;
}

/** Projects with both redactor volumes on this machine, sorted. */
function warmProjects(volumes: readonly string[]): string[] {
  const [venv, models] = REDACTOR_VOLUME_SUFFIXES;
  return volumes
    .filter((name: string): boolean => name.endsWith(`_${venv}`))
    .map((name: string): string => name.slice(0, -(venv.length + 1)))
    .filter((project: string): boolean => volumes.includes(`${project}_${models}`))
    .sort();
}

/**
 * How the bed gets a redactor that will not download at the venue.
 *
 * The images are never pulled; the redactor's wheels and model are the same
 * hazard, so the bed's redactor volumes are either already there or cloned,
 * read-only, from a warm project's, labelled as compose labels its own so
 * `down --volumes` removes them with the rest. The command shapes match
 * `redactorVolumeClone` in `scripts/rehearsal/docker.ts`.
 *
 * Args:
 *   input: The bed, the warm project if any, the machine's volumes, the image.
 *
 * Returns:
 *   The clone commands (none when the bed already has both volumes), the venv
 *   volume to read the stamp from, and a line for the terminal.
 *
 * Raises:
 *   Error: When the bed is protected or read-only, the warm project is
 *     protected, is the bed itself or lacks a volume, or no warm project was
 *     named and the bed has none of its own.
 */
export function warmRedactorPlan(input: WarmRedactorInput): WarmRedactorPlan {
  assertBedProject(input.project);
  if (input.warmFrom === input.project) {
    throw new Error(`--warm-from ${input.warmFrom} names this bed's own project.`);
  }
  const own = REDACTOR_VOLUME_SUFFIXES.map((suffix: string): string => `${input.project}_${suffix}`);
  if (own.every((volume: string): boolean => input.volumes.includes(volume))) {
    return {
      clone: [],
      sourceVenv: own[0],
      note: `${own.join(' and ')} are already present, so they are kept as they are${
        input.warmFrom ? ` and --warm-from ${input.warmFrom} is not read` : ''
      }`,
    };
  }
  const candidates = warmProjects(input.volumes).filter(
    (project: string): boolean => project !== input.project,
  );
  if (input.warmFrom === undefined) {
    throw new Error(
      `the redactor would install its wheels and fetch its model on first start (minutes, network), ` +
        `because ${input.project} has no redactor volumes. Pass --warm-from <project> to clone a warm ` +
        `project's volumes read-only; warm projects on this machine: ${
          candidates.length > 0 ? candidates.join(', ') : 'none on this machine'
        }.`,
    );
  }
  assertNotProtected(input.warmFrom);
  for (const suffix of REDACTOR_VOLUME_SUFFIXES) {
    if (!input.volumes.includes(`${input.warmFrom}_${suffix}`)) {
      throw new Error(
        `--warm-from ${input.warmFrom}: no ${input.warmFrom}_${suffix} volume exists on this machine; ` +
          `warm projects here: ${candidates.length > 0 ? candidates.join(', ') : 'none on this machine'}.`,
      );
    }
  }
  const clone = REDACTOR_VOLUME_SUFFIXES.map((suffix: string): VolumeClone => {
    const volume = `${input.project}_${suffix}`;
    return {
      volume,
      create: [
        'volume',
        'create',
        '--label',
        `com.docker.compose.project=${input.project}`,
        '--label',
        `com.docker.compose.volume=${suffix}`,
        volume,
      ],
      copy: [
        'run',
        '--rm',
        '-v',
        `${input.warmFrom}_${suffix}:/from:ro`,
        '-v',
        `${volume}:/to`,
        input.image,
        'sh',
        '-c',
        'cp -a /from/. /to/',
      ],
    };
  });
  return {
    clone,
    sourceVenv: `${input.warmFrom}_${REDACTOR_VOLUME_SUFFIXES[0]}`,
    note: `cloning ${input.warmFrom}'s redactor volumes (read-only) into ${input.project}'s`,
  };
}

/**
 * Why a venv must not be started on this bed, if it must not.
 *
 * The bed starts the redactor on the CPU (the compose default, no GPU
 * overlay), and `redactor/start.sh` empties and rebuilds a venv whose stamp
 * is not this checkout's CPU requirements digest: a download at the venue.
 *
 * Args:
 *   device: What the venv's stamp says it was built for.
 *   venv: The volume the stamp was read from, for the message.
 *
 * Returns:
 *   The refusal, or undefined for a CPU venv of this checkout.
 */
export function redactorVenvRefusal(device: VenvDevice, venv: string): string | undefined {
  switch (device) {
    case 'cpu':
      return undefined;
    case 'cuda':
      return (
        `${venv} was built for CUDA, and the bed starts the redactor on the CPU: the start script would ` +
        'empty it and download the CPU wheels. Warm a CPU venv first (MODEL_GPU=off pnpm redactor:up ' +
        'under another project) and --warm-from that.'
      );
    case 'none':
      return (
        `${venv} has no requirements stamp, so the redactor would install its wheels and fetch its ` +
        'model on first start (minutes, network). Clone a warm project with --warm-from.'
      );
    case 'unknown':
      return (
        `${venv} was built from a requirements file this checkout no longer has, so the start script ` +
        'would rebuild it (a download). Re-warm the source project on this checkout first.'
      );
  }
}

export interface RungReadiness {
  /** The bed. */
  project: string;
  /** Its containers, as `docker ps` lists them. */
  services: readonly ServiceRow[];
  /** What `.env.local` declares. */
  values: Readonly<Record<string, string>>;
  /** The host ports derived from the same file. */
  ports: BedPorts;
}

/**
 * Why the offline rung cannot run on this bed, if it cannot.
 *
 * The doubles must be running, the redactor healthy (real-mode documentation
 * sync fails closed without it and the driver's folder sync would stop),
 * the file must say real mode and name the redactor, and the project's own
 * backend must be what publishes the port the file addresses, or the driver
 * would deploy its agent on whatever listens there.
 *
 * Args:
 *   input: The bed, its containers, the file and its ports.
 *
 * Returns:
 *   The refusal naming the fix, or undefined when the rung may run.
 */
export function offlineRungRefusal(input: RungReadiness): string | undefined {
  const row = (name: string): ServiceRow | undefined =>
    input.services.find((candidate: ServiceRow): boolean => candidate.service === name);
  for (const name of ['backend', 'fake-slack', 'looker-tile']) {
    if (row(name)?.state !== 'running') {
      return `${name} is not running in project ${input.project}; run pnpm demo:bed up first.`;
    }
  }
  const redactor = row('redactor');
  if (redactor?.state !== 'running') {
    return `the redactor is ${redactor ? redactor.state : 'absent'} in project ${input.project}; ${REDACTOR_UNHEALTHY_FIX}.`;
  }
  if (redactor.health !== 'healthy') {
    return redactor.health === 'starting'
      ? `the redactor is still loading its model in project ${input.project}; ${REDACTOR_UNHEALTHY_FIX}.`
      : `the redactor is not healthy (${redactor.health}) in project ${input.project}; ${REDACTOR_UNHEALTHY_FIX}.`;
  }
  if ((input.values.DAY0_SURFACE_MODE || 'mock') !== 'real') {
    return `DAY0_SURFACE_MODE must be real in ${ENV_FILE} for the revocation trial.`;
  }
  if (!input.values.DAY0_REDACTOR_URL) return `${REDACTOR_UNWIRED_FIX}.`;
  const published = publishedHostPort(row('backend')?.ports ?? '', CONTAINER_BACKEND_PORT);
  if (published === undefined) {
    return `the backend of project ${input.project} does not publish port ${CONTAINER_BACKEND_PORT}, so nothing of this project serves ${ENV_FILE}'s port ${input.ports.backend}.`;
  }
  if (published !== input.ports.backend) {
    return (
      `the backend of project ${input.project} publishes ${CONTAINER_BACKEND_PORT} on host port ${published}, ` +
      `but ${ENV_FILE} addresses ${input.ports.backend}; the rung would write to whatever listens there. ` +
      `Set CONVEX_PORT and the two Convex URLs to ${published}, or bring the bed up from this file.`
    );
  }
  return undefined;
}

/**
 * Why the rung may not write its evidence there, if it may not.
 *
 * A results directory is written once: the driver would overwrite the four
 * files in place, and `evaluation/results/` is frozen evidence.
 *
 * Args:
 *   out: The resolved `--out` directory.
 *   exists: Whether anything is at that path.
 *
 * Returns:
 *   The refusal, or undefined for a path nothing is at.
 */
export function rungOutputRefusal(out: string, exists: boolean): string | undefined {
  if (!exists) return undefined;
  return `${out} already exists; a results directory is written once. Pass --out <new directory>.`;
}

/**
 * `SHA256SUMS` as `sha256sum` writes and `sha256sum -c` reads it.
 *
 * Args:
 *   digests: One hex digest per file, in any order.
 *
 * Returns:
 *   One `<digest>  <name>` line per file, sorted by name, newline-terminated.
 */
export function sha256SumsText(
  digests: ReadonlyArray<{ name: string; digest: string }>,
): string {
  return [...digests]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ name, digest }): string => `${digest}  ${name}\n`)
    .join('');
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

/**
 * What the env file must say for this bed, for every value it leaves empty.
 *
 * The file is the bed's contract, so a value it already carries is never
 * rewritten; this only fills the blanks a fresh checkout has. The component
 * switches are conditional on the profile that starts the component, because
 * naming a component that is not running is what makes a surface card flip.
 *
 * Args:
 *   project: Compose project the bed runs as.
 *   profiles: Components this bed starts.
 *   values: What the env file already declares.
 *   ports: Host ports derived from the same file.
 *
 * Returns:
 *   The keys to write, and nothing the file already answers.
 */
function assertBedTarget(project: string, values: Readonly<Values>, ports: BedPorts): void {
  assertBedProject(project);
  if (values.COMPOSE_PROJECT_NAME && values.COMPOSE_PROJECT_NAME !== project) {
    throw new Error(`The file names project ${values.COMPOSE_PROJECT_NAME}, not ${project}.`);
  }
  if (values.CONVEX_DEPLOYMENT) throw new Error('A demo bed cannot target CONVEX_DEPLOYMENT.');
  for (const [key, port] of [
    ['CONVEX_SELF_HOSTED_URL', ports.backend],
    ['NEXT_PUBLIC_CONVEX_URL', ports.backend],
    ['NEXT_PUBLIC_CONVEX_SITE_URL', ports.site],
  ] as const) {
    const value = values[key];
    if (!value) continue;
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${key} is not a valid URL.`); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        Number(url.port || 80) !== port || url.pathname !== '/' || url.search || url.hash ||
        url.username || url.password) {
      throw new Error(`${key} must address this bed on loopback port ${port}.`);
    }
  }
}

export function bedEnvDefaults(
  project: string,
  profiles: readonly string[],
  values: Readonly<Values>,
  ports: BedPorts,
): Values {
  assertBedTarget(project, values, ports);
  const derived: Values = {};
  if (!values.COMPOSE_PROJECT_NAME) derived.COMPOSE_PROJECT_NAME = project;
  if (!values.CONVEX_SELF_HOSTED_URL)
    derived.CONVEX_SELF_HOSTED_URL = `http://127.0.0.1:${ports.backend}`;
  if (!values.NEXT_PUBLIC_CONVEX_URL)
    derived.NEXT_PUBLIC_CONVEX_URL = `http://127.0.0.1:${ports.backend}`;
  if (!values.NEXT_PUBLIC_CONVEX_SITE_URL)
    derived.NEXT_PUBLIC_CONVEX_SITE_URL = `http://127.0.0.1:${ports.site}`;
  if (profiles.includes('browser') && !values.DAY0_BROWSER_MCP_URL)
    derived.DAY0_BROWSER_MCP_URL = BROWSER_MCP_URL;
  if (profiles.includes('redactor') && !values.DAY0_REDACTOR_URL)
    derived.DAY0_REDACTOR_URL = REDACTOR_URL;
  if (profiles.includes('test')) {
    if (!values.DAY0_TEST_SLACK_API_URL) derived.DAY0_TEST_SLACK_API_URL = TEST_SLACK_API_URL;
    if (!values.DAY0_TEST_SLACK_AUTHORIZE_URL)
      derived.DAY0_TEST_SLACK_AUTHORIZE_URL = `http://127.0.0.1:${ports.fakeSlack}/oauth/v2/authorize`;
  }
  return derived;
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
      '{{.Label "com.docker.compose.service"}}\t{{.State}}\t{{.Status}}\t{{.Ports}}',
    ],
    { timeoutMs: 15_000 },
  );
  if (result.status !== 0) return undefined;
  return parseDockerPs(result.stdout);
}

function volumeExists(name: string): boolean {
  return run('docker', ['volume', 'inspect', name], { timeoutMs: 15_000 }).status === 0;
}

/** Containers that have the volume mounted; stopped ones still pin it for `docker volume rm`. */
function volumeInUse(name: string): string[] {
  return volumeHolders(name, true);
}

/** Running containers that have the volume mounted, the ones that may be writing it. */
function volumeHeldByRunning(name: string): string[] {
  return volumeHolders(name, false);
}

function volumeHolders(name: string, includeStopped: boolean): string[] {
  const result = must(
    run(
      'docker',
      ['ps', ...(includeStopped ? ['-a'] : []), '--filter', `volume=${name}`, '--format', '{{.Names}}'],
      { timeoutMs: 15_000 },
    ),
    'docker ps',
  );
  return result.stdout
    .split('\n')
    .map((line: string): string => line.trim())
    .filter(Boolean);
}

function volumeNames(): string[] {
  const result = must(
    run('docker', ['volume', 'ls', '--format', '{{.Name}}'], { timeoutMs: 15_000 }),
    'docker volume ls',
  );
  return result.stdout
    .split('\n')
    .map((line: string): string => line.trim())
    .filter(Boolean);
}

/** The stamp on a venv volume, read through a read-only mount; `none` when the volume is empty. */
function redactorVenvDevice(volume: string, image: string): VenvDevice {
  const stamp = run('docker', venvStampCommand(volume, image), { timeoutMs: 120_000 });
  return venvDevice(stamp.status === 0 ? stamp.stdout : undefined, requirementsDigests('.'));
}

async function waitForRedactor(project: string, timeoutMs: number = 600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    const row = (projectServices(project) ?? []).find(
      (candidate: ServiceRow): boolean => candidate.service === 'redactor',
    );
    if (row?.health === 'healthy') return;
    if (!row || row.state !== 'running') {
      throw new Error(
        `the redactor is ${row ? row.state : 'absent'} in project ${project}; read ` +
          `docker compose -p ${project} --profile redactor logs redactor`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the redactor did not report healthy within ${timeoutMs / 1000} s (last: ${row.health}); read ` +
          `docker compose -p ${project} --profile redactor logs redactor`,
      );
    }
    if (!announced) {
      log('      waiting for the redactor to load its model (under a minute on a warm volume)');
      announced = true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
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

/** `convex env list` as a map; empty when the CLI cannot answer. */
function deploymentEnv(env: Values): Values {
  const result = run('npx', ['convex', 'env', 'list'], { env, timeoutMs: 60_000 });
  const values: Values = {};
  if (result.status !== 0) return values;
  for (const line of result.stdout.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/* --------------------------------- snapshot -------------------------------- */

function snapshot(options: DemoBedOptions): void {
  const source = options.fromVolume;
  if (!volumeExists(source)) throw new Error(`volume ${source} does not exist on this machine.`);
  const refusal = snapshotRefusal(source, volumeHeldByRunning(source));
  if (refusal) throw new Error(refusal);
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
  assertBedProject(options.project);
  if (!existsSync(ENV_FILE)) {
    throw new Error(
      `${ENV_FILE} not found. Copy .env.example to ${ENV_FILE} and fill in the bed's values first.`,
    );
  }
  let values = readEnvFile();
  const ports = bedPorts(values);
  if (values.COMPOSE_PROJECT_NAME && values.COMPOSE_PROJECT_NAME !== options.project) {
    throw new Error(
      `${ENV_FILE} says COMPOSE_PROJECT_NAME=${values.COMPOSE_PROJECT_NAME} and --project says ${options.project}; ` +
        'the file is the contract, so change one of them.',
    );
  }
  const derived = bedEnvDefaults(options.project, options.profiles, values, ports);
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
  log(`[1/10] Keys: pnpm dev:no-auth-key (no-op when ${ENV_FILE} already has them)`);
  must(
    run('pnpm', ['exec', 'tsx', 'scripts/dev-no-auth-key.ts', 'init'], { env, inherit: true }),
    'dev:no-auth-key',
  );
  values = readEnvFile();

  log('[2/10] Redactor volumes: present, or cloned read-only from --warm-from, never downloaded');
  if (options.profiles.includes('redactor')) {
    const image = tarImage();
    const plan = warmRedactorPlan({
      project: options.project,
      warmFrom: options.warmFrom,
      volumes: volumeNames(),
      image,
    });
    const refusal = redactorVenvRefusal(redactorVenvDevice(plan.sourceVenv, image), plan.sourceVenv);
    if (refusal) throw new Error(refusal);
    log(`      ${plan.note}`);
    for (const step of plan.clone) {
      must(run('docker', step.create, { timeoutMs: 60_000 }), `docker volume create ${step.volume}`);
      must(run('docker', step.copy, { timeoutMs: 900_000 }), `copy into ${step.volume}`);
      log(`      ${step.volume}`);
    }
  } else {
    log('      the redactor profile is off, so nothing to prepare');
  }

  log(
    `[3/10] Documentation directory, then compose up (${options.profiles.join(', ')}), images never pulled`,
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

  log("[4/10] Admin key from the volume's own instance secret");
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

  log("[5/10] What the volume's deployment already carries");
  const deployment = deploymentEnv(bedEnvironment(options, values));
  const adopt = credentialKeyToAdopt(
    values.DAY0_CREDENTIAL_KEY ?? '',
    deployment.DAY0_CREDENTIAL_KEY,
  );
  if (adopt) {
    writeEnvValues({ DAY0_CREDENTIAL_KEY: adopt });
    log(
      `      adopted the volume's DAY0_CREDENTIAL_KEY into ${ENV_FILE}: its stored credentials stay readable`,
    );
    values = readEnvFile();
  }
  const stale = secretsToClear(
    values,
    deployment,
    syncScriptKeys(readFileSync(SYNC_SCRIPT, 'utf8')),
  );
  for (const key of stale) {
    must(
      run('npx', ['convex', 'env', 'remove', key], {
        env: bedEnvironment(options, values),
        timeoutMs: 60_000,
      }),
      `convex env remove ${key}`,
    );
    log(
      `      cleared ${key}: on the deployment, empty in ${ENV_FILE}, and the sync would skip it`,
    );
  }
  if (!adopt && stale.length === 0) log('      nothing to adopt or clear');
  const pushEnv = bedEnvironment(options, values);

  log('[6/10] Deployment env: ./scripts/sync-convex-env.sh');
  must(
    run('bash', ['scripts/sync-convex-env.sh', ENV_FILE], { env: pushEnv, inherit: true }),
    'sync:env',
  );

  log('[7/10] Functions: convex dev --once');
  const pushStartedAt = Date.now();
  must(
    run('pnpm', ['exec', 'convex', 'dev', '--once', '--typecheck', 'disable'], {
      env: pushEnv,
      inherit: true,
    }),
    'convex dev --once',
  );
  log(`      pushed in ${elapsed(pushStartedAt)}`);

  log('[8/10] Restart the backend so the pushed env is what the modules read');
  must(
    run('docker', [...composeArgs(options, ['real']), 'restart', 'backend'], {
      env: pushEnv,
      inherit: true,
    }),
    'restart',
  );
  await waitForBackend(ports.backend);

  log('[9/10] The redactor reports healthy, or real-mode documentation sync fails closed');
  if (options.profiles.includes('redactor')) {
    const redactorStartedAt = Date.now();
    await waitForRedactor(options.project);
    log(`      healthy after ${elapsed(redactorStartedAt)}`);
  } else {
    log('      the redactor profile is off; the offline rung will refuse');
  }

  if (options.reset) {
    log(
      `[10/10] Reset the local boss's agents${options.unlink ? ', documentation and credentials' : ''}`,
    );
    const boss = await bossClient(values);
    if ('reason' in boss) throw new Error(`cannot reset: ${boss.reason}`);
    const { api } = await import('../convex/_generated/api');
    const result = await boss.client.mutation(api.reset.deleteMyData, {
      alsoUnlinkDocumentation: options.unlink,
    });
    log(`      deleted ${result.deleted} agent(s), unlinked ${result.unlinkedSources} source(s)`);
  } else {
    log("[10/10] No reset asked for; the volume's agents stay");
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
  rungAlreadyRun: boolean;
  verdicts: Record<string, number>;
  docSources: string[];
  lastProbeFailure?: string;
}

async function surfacesState(values: Values): Promise<SurfaceSummary | string> {
  const boss = await bossClient(values);
  if ('reason' in boss) return boss.reason;
  try {
    const { api } = await import('../convex/_generated/api');
    const agents = await boss.client.query(api.agents.listForUser, {});
    const verdicts: Record<string, number> = {};
    let lastProbeFailure: { createdAt: number; text: string } | undefined;
    for (const agent of agents) {
      const surfaces = await boss.client.query(api.surfaces.listForAgent, { agentId: agent._id });
      for (const surface of surfaces)
        verdicts[surface.verdict] = (verdicts[surface.verdict] ?? 0) + 1;
      const events = (await boss.client.query(api.events.recent, {
        agentId: agent._id,
        limit: 200,
      })) as Array<{ type: string; createdAt: number; payload: unknown }>;
      const failure = events.find((event): boolean => event.type === 'surface.probe-failed');
      if (failure && (!lastProbeFailure || failure.createdAt > lastProbeFailure.createdAt)) {
        const payload = failure.payload as { reason?: string; verdict?: string };
        lastProbeFailure = {
          createdAt: failure.createdAt,
          text: `${new Date(failure.createdAt).toISOString()} -> ${payload.verdict ?? '?'}: ${(payload.reason ?? '').slice(0, 120)}`,
        };
      }
    }
    const sources = await boss.client.query(api.docSources.listMine, {});
    return {
      agents: agents.length,
      rungAlreadyRun: await volumeSpent(
        agents,
        async (agent): Promise<Array<{ payload: unknown }>> =>
          await boss.client.query(api.events.recent, { agentId: agent._id, limit: 500 }),
      ),
      verdicts,
      docSources: sources.map(
        (source): string =>
          `${source.kind} "${source.label}": ${source.status}, ${source.pageCount} pages${
            source.status === 'error' && source.lastError
              ? ` (${source.lastError.slice(0, 100)})`
              : ''
          }`,
      ),
      ...(lastProbeFailure ? { lastProbeFailure: lastProbeFailure.text } : {}),
    };
  } catch (error) {
    return (error as Error).message.split('\n')[0];
  }
}

async function preflight(options: DemoBedOptions): Promise<number> {
  const values = readEnvFile();
  const ports = bedPorts(values);
  assertBedTarget(options.project, values, ports);
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
      ? `${values.CONVEX_SELF_HOSTED_URL || `http://127.0.0.1:${ports.backend}`} (version ${version})`
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
            ...(surfaces.lastProbeFailure
              ? [`last surface.probe-failed: ${surfaces.lastProbeFailure}`]
              : []),
            'the hourly re-probe runs within seconds of a bring-up; with no network the Slack and Linear cards flip on it',
          ].join('\n'),
  });

  const deployment = version && values.CONVEX_SELF_HOSTED_ADMIN_KEY
    ? deploymentEnv(bedEnvironment(options, values))
    : {};
  if (version && values.CONVEX_SELF_HOSTED_ADMIN_KEY) {
    const stale = Object.keys(deployment).length
      ? secretsToClear(values, deployment, syncScriptKeys(readFileSync(SYNC_SCRIPT, 'utf8')))
      : [];
    items.push({
      label: `Deployment env: ${Object.keys(deployment).length} variable(s)`,
      status: Object.keys(deployment).length === 0 ? 'warn' : stale.length > 0 ? 'gap' : 'ok',
      detail:
        Object.keys(deployment).length === 0
          ? 'convex env list did not answer; the admin key may not match this volume'
          : stale.length > 0
            ? `set on the deployment and empty in ${ENV_FILE}: ${stale.join(', ')}; run pnpm demo:bed up to clear them`
            : `nothing on the deployment that ${ENV_FILE} leaves empty`,
    });
  }

  const browserRunning = running('playwright-mcp');
  const browserSwitch = values.DAY0_BROWSER_MCP_URL ?? '';
  items.push({
    label: 'Browser component',
    status: browserRunning && browserSwitch ? 'ok' : 'warn',
    detail: browserRunning
      ? browserSwitch
        ? `playwright-mcp is running and DAY0_BROWSER_MCP_URL names ${browserSwitch}`
        : 'playwright-mcp is running but DAY0_BROWSER_MCP_URL is empty, so the tile card flips to ungranted on the next probe'
      : 'playwright-mcp is not running; the recorded tile card flips to ungranted on the next probe',
  });

  const redactorRow = services?.find((row: ServiceRow): boolean => row.service === 'redactor');
  const redactorHealthy = redactorRow?.health === 'healthy';
  const redactorWired =
    !!values.DAY0_REDACTOR_URL &&
    (Object.keys(deployment).length === 0 || !!deployment.DAY0_REDACTOR_URL);
  items.push({
    label: 'Redactor component',
    status: redactorHealthy && redactorWired ? 'ok' : 'gap',
    detail: [
      redactorHealthy
        ? 'the redactor reports healthy'
        : redactorRow
          ? `the redactor is ${redactorRow.state}${redactorRow.health === 'none' ? '' : ` (${redactorRow.health})`}; ${REDACTOR_UNHEALTHY_FIX}`
          : `no redactor container in project ${options.project}; ${REDACTOR_UNHEALTHY_FIX}`,
      ...(redactorHealthy
        ? []
        : [
            `warm projects on this machine: ${
              warmProjects(docker.status === 0 ? volumeNames() : [])
                .filter((project: string): boolean => project !== options.project)
                .join(', ') || 'none'
            }`,
          ]),
      redactorWired
        ? `DAY0_REDACTOR_URL names ${values.DAY0_REDACTOR_URL}${Object.keys(deployment).length === 0 ? ' (deployment not read)' : ' on both sides'}`
        : REDACTOR_UNWIRED_FIX,
    ].join('\n'),
  });

  const backendRow = services?.find((row: ServiceRow): boolean => row.service === 'backend');
  const publishedBackend = backendRow ? publishedHostPort(backendRow.ports, CONTAINER_BACKEND_PORT) : undefined;
  items.push({
    label: `Backend port belongs to project ${options.project}`,
    status: publishedBackend === ports.backend ? 'ok' : 'gap',
    detail:
      publishedBackend === ports.backend
        ? `its backend publishes ${CONTAINER_BACKEND_PORT} on 127.0.0.1:${ports.backend}, the port ${ENV_FILE} addresses`
        : backendRow
          ? `its backend publishes ${CONTAINER_BACKEND_PORT} on ${publishedBackend ?? 'no host port'}, but ${ENV_FILE} addresses ${ports.backend}; the rung would write to whatever listens there`
          : `no backend container; ${ENV_FILE} addresses ${ports.backend}, which nothing of this project serves`,
  });

  const rungReady =
    surfaceMode === 'real' && !!version && healthy('fake-slack') && healthy('looker-tile');
  const slackDouble = values.DAY0_TEST_SLACK_API_URL ?? '';
  const spent = typeof surfaces !== 'string' && surfaces.rungAlreadyRun;
  items.push({
    label: 'Offline rung doubles',
    status: rungReady && slackDouble && !spent ? 'ok' : 'gap',
    detail: [
      `fake-slack ${healthy('fake-slack') ? 'healthy' : 'not healthy'}, looker-tile ${healthy('looker-tile') ? 'healthy' : 'not healthy'}, sandbox ${healthy('sandbox') ? 'healthy' : 'not healthy'}`,
      slackDouble
        ? `DAY0_TEST_SLACK_API_URL names ${slackDouble}`
        : `DAY0_TEST_SLACK_API_URL is empty, so the rung's Slack probe reaches slack.com and ends ungranted; set it to ${TEST_SLACK_API_URL}`,
      spent
        ? 'this volume has already run the rung: restore the snapshot again before running another'
        : 'the trial ids on this volume are unspent',
    ].join('\n'),
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
    slackDoubleWired: !!slackDouble,
    rungAlreadyRun: spent,
    redactorHealthy,
    redactorWired,
    rungModelRoute: deployment.OPENAI_BASE_URL ?? '',
    deploymentModelSettings: deployment,
    backendHealthy: !!version,
    modelBaseUrl: baseUrl,
    probeTier: tier,
  });
  for (const verdict of tiers)
    log(`${verdict.go ? 'GO   ' : 'NO-GO'} ${verdict.name}: ${verdict.reason}`);
  return items.some((item: ChecklistItem): boolean => item.status === 'gap') ? 1 : 0;
}

/* ------------------------------- offline rung ------------------------------ */

async function offlineRung(options: DemoBedOptions): Promise<void> {
  assertBedProject(options.project);
  const values = readEnvFile();
  const ports = bedPorts(values);
  assertBedTarget(options.project, values, ports);
  const refusal = offlineRungRefusal({
    project: options.project,
    services: projectServices(options.project) ?? [],
    values,
    ports,
  });
  if (refusal) throw new Error(refusal);
  const out = resolve(options.out ?? `${KIT_DIR}/revocation-${stamp()}`);
  const outRefusal = rungOutputRefusal(out, existsSync(out));
  if (outRefusal) throw new Error(outRefusal);
  const boss = await bossClient(values);
  if (!('reason' in boss)) {
    const { api } = await import('../convex/_generated/api');
    const agents = await boss.client.query(api.agents.listForUser, {});
    const spentHere = await volumeSpent(
      agents,
      async (agent): Promise<Array<{ payload: unknown }>> =>
        await boss.client.query(api.events.recent, { agentId: agent._id, limit: 500 }),
    );
    if (spentHere) {
      throw new Error(
        `this volume has already run the rung, and its trial ids are spent: a second one dies ` +
          `about a minute in with "trial rev-scope-01 already exists". Start from the snapshot ` +
          `again:\n  pnpm demo:bed down --volumes --project ${options.project}\n` +
          `  pnpm demo:bed restore --snapshot ${KIT_DIR}/snapshots/<file>.tar.gz --project ${options.project}\n` +
          `  pnpm demo:bed up --project ${options.project}`,
      );
    }
  }
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
  const missing = RUNG_OUTPUT_FILES.filter((name: string): boolean => !existsSync(`${out}/${name}`));
  if (missing.length > 0) {
    throw new Error(`eval:revocation returned without writing ${missing.join(', ')} in ${out}.`);
  }
  writeFileSync(
    `${out}/SHA256SUMS`,
    sha256SumsText(
      RUNG_OUTPUT_FILES.map((name: string): { name: string; digest: string } => ({
        name,
        digest: sha256(`${out}/${name}`),
      })),
    ),
    'utf8',
  );
  log('');
  log(`Wall clock: ${took}`);
  for (const line of revocationSummary(readFileSync(`${out}/trials.md`, 'utf8'))) log(line);
  log(`Wrote ${out}/SHA256SUMS over ${RUNG_OUTPUT_FILES.join(', ')}; check with: (cd ${out} && sha256sum -c SHA256SUMS)`);
}

/* ---------------------------------- down ----------------------------------- */

function down(options: DemoBedOptions): void {
  assertBedProject(options.project);
  const values = readEnvFile();
  const profiles = Object.keys(PROFILES);
  const args = [...composeArgs(options, profiles), 'down'];
  if (options.volumes) {
    projectVolumeNames(options.project);
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
        await offlineRung(options);
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
