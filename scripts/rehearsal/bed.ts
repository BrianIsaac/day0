/**
 * Bringing a real-mode bed up from a clean clone and taking it down again:
 * the README's real-mode sequence as functions over an injected runner, so a
 * test reads every command the rehearsal would issue.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAdminKey } from '../setup';
import { upsertEnvText } from '../demo-bed';
import { writePrivateEnv } from '../private-env';
import { BED_PROFILES, bedComposeArgs, pinnedNodeImage, redactorVolumeClone } from './docker';
import type { BedPorts } from './env';
import { must, waitUntil, type Runner, type RunResult, type ServerHandle, type ServerStarter } from './process';

/** The query parameter the unlock URL carries; restated from src/lib/dev-auth-server.ts, which tsx cannot import. */
export const UNLOCK_PARAM: typeof import('../../src/lib/dev-auth-server').DEV_NO_AUTH_UNLOCK_PARAM =
  'day0_key';

export interface Bed {
  clone: string;
  project: string;
  ports: BedPorts;
  /** Everything the bed's child processes see on top of the shell. */
  env: Record<string, string>;
}

const ENV_FILE = '.env.local';
const LONG_STEP_MS = 15 * 60_000;

function composeCommand(bed: Bed, profiles: readonly string[] = BED_PROFILES): string[] {
  return bedComposeArgs(bed.project, ENV_FILE, profiles);
}

/**
 * The commit a ref names in the source repository.
 *
 * Args:
 *   runner: The process runner.
 *   source: The repository.
 *   ref: The ref.
 *
 * Returns:
 *   The full commit hash.
 */
export function resolveCommit(runner: Runner, source: string, ref: string): string {
  const result = must(
    runner('git', ['-C', source, 'rev-parse', '--verify', `${ref}^{commit}`], { timeoutMs: 30_000 }),
    `git rev-parse ${ref}`,
  );
  return result.stdout.trim();
}

/**
 * Whether the source tree carries uncommitted changes, which a clone of a
 * commit does not, so the record can say so.
 *
 * Args:
 *   runner: The process runner.
 *   source: The repository.
 *
 * Returns:
 *   The porcelain status lines.
 */
export function dirtyPaths(runner: Runner, source: string): string[] {
  const result = runner('git', ['-C', source, 'status', '--porcelain'], { timeoutMs: 30_000 });
  return result.stdout
    .split('\n')
    .map((line: string): string => line.trim())
    .filter(Boolean);
}

/**
 * Clone the source at one commit into a fresh directory.
 *
 * Args:
 *   runner: The process runner.
 *   source: The repository.
 *   commit: The commit to check out, detached.
 *   target: The directory to create.
 */
export function cloneAt(runner: Runner, source: string, commit: string, target: string): void {
  must(
    runner('git', ['clone', '--quiet', '--no-checkout', source, target], { timeoutMs: 120_000 }),
    'git clone',
  );
  must(
    runner('git', ['-C', target, 'checkout', '--quiet', '--detach', commit], { timeoutMs: 60_000 }),
    `git checkout ${commit.slice(0, 7)}`,
  );
}

/**
 * Install the clone's dependencies from its lockfile.
 *
 * Args:
 *   runner: The process runner.
 *   clone: The clone.
 */
export function installDependencies(runner: Runner, clone: string): void {
  must(
    runner('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], {
      cwd: clone,
      timeoutMs: LONG_STEP_MS,
    }),
    'pnpm install',
  );
}

/**
 * Write the bed's `.env.local`: the example file with the bed's values on top,
 * private to the owner.
 *
 * Args:
 *   clone: The clone.
 *   values: The bed's values.
 */
export function writeBedEnv(clone: string, values: Readonly<Record<string, string>>): void {
  const example = readFileSync(join(clone, '.env.example'), 'utf8');
  writePrivateEnv(join(clone, ENV_FILE), upsertEnvText(example, values));
}

/**
 * The bed's `.env.local` as values.
 *
 * Args:
 *   clone: The clone.
 *
 * Returns:
 *   Names and values.
 */
export function readBedEnv(clone: string): Record<string, string> {
  const values: Record<string, string> = {};
  const path = join(clone, ENV_FILE);
  if (!existsSync(path)) return values;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return values;
}

/**
 * Mint the bed's no-auth key, credential key and Notion hop token.
 *
 * Args:
 *   runner: The process runner.
 *   clone: The clone.
 */
export function generateKeys(runner: Runner, clone: string): void {
  must(
    runner('pnpm', ['exec', 'tsx', 'scripts/dev-no-auth-key.ts', 'init'], {
      cwd: clone,
      timeoutMs: 120_000,
    }),
    'dev:no-auth-key',
  );
}

/**
 * Copy a warm project's redactor volumes into the bed's.
 *
 * Args:
 *   runner: The process runner.
 *   fromProject: The warm project.
 *   bed: The bed.
 */
export function warmRedactorVolumes(runner: Runner, fromProject: string, bed: Bed): void {
  const image = pinnedNodeImage(readFileSync(join(bed.clone, 'docker-compose.yml'), 'utf8'));
  for (const step of redactorVolumeClone(fromProject, bed.project, image)) {
    must(runner('docker', step.create, { timeoutMs: 60_000 }), `docker volume create ${step.volume}`);
    must(runner('docker', step.copy, { timeoutMs: LONG_STEP_MS }), `copy into ${step.volume}`);
  }
}

/**
 * Start the bed's containers.
 *
 * Args:
 *   runner: The process runner.
 *   bed: The bed.
 */
export function composeUp(runner: Runner, bed: Bed): void {
  must(
    runner('docker', [...composeCommand(bed), 'up', '-d', '--no-build'], {
      cwd: bed.clone,
      env: bed.env,
      timeoutMs: LONG_STEP_MS,
    }),
    'docker compose up',
  );
}

/**
 * Stop the bed's containers and, by default, remove its volumes.
 *
 * Args:
 *   runner: The process runner.
 *   bed: The bed.
 *   removeVolumes: Whether to pass `-v`.
 */
export function composeDown(runner: Runner, bed: Bed, removeVolumes: boolean = true): void {
  must(
    runner('docker', [...composeCommand(bed), 'down', ...(removeVolumes ? ['-v'] : [])], {
      cwd: bed.clone,
      env: bed.env,
      timeoutMs: 5 * 60_000,
    }),
    'docker compose down',
  );
}

/**
 * The bed's service states, for the record.
 *
 * Args:
 *   runner: The process runner.
 *   bed: The bed.
 *
 * Returns:
 *   `service state` lines.
 */
export function composePs(runner: Runner, bed: Bed): string[] {
  const result = runner(
    'docker',
    [...composeCommand(bed), 'ps', '-a', '--format', '{{.Service}} {{.State}} {{.Health}}'],
    { cwd: bed.clone, env: bed.env, timeoutMs: 30_000 },
  );
  return result.stdout
    .split('\n')
    .map((line: string): string => line.trim())
    .filter(Boolean);
}

/**
 * Wait for the backend to answer its version.
 *
 * Args:
 *   port: The backend's host port.
 *   fetchImpl: The fetch, injectable.
 *   timeoutMs: The ceiling.
 *
 * Returns:
 *   The version string.
 */
export async function waitForBackend(
  port: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = 180_000,
): Promise<string> {
  return await waitUntil(
    async () => {
      try {
        const response = await fetchImpl(`http://127.0.0.1:${port}/version`, {
          signal: AbortSignal.timeout(3_000),
        });
        return response.ok ? (await response.text()).trim() || undefined : undefined;
      } catch {
        return undefined;
      }
    },
    { what: `the backend on 127.0.0.1:${port}`, timeoutMs },
  );
}

/**
 * Wait for a compose service to report healthy.
 *
 * Args:
 *   runner: The process runner.
 *   bed: The bed.
 *   service: The service name.
 *   timeoutMs: The ceiling.
 *   sleep: Injectable sleep.
 */
export async function waitForHealthy(
  runner: Runner,
  bed: Bed,
  service: string,
  timeoutMs: number,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  await waitUntil(
    async () => {
      const line = composePs(runner, bed).find((row: string): boolean => row.startsWith(`${service} `));
      if (line?.includes('exited')) throw new Error(`${service} exited: ${line}`);
      return line?.includes('healthy') && !line.includes('unhealthy') ? line : undefined;
    },
    { what: `${service} to be healthy`, timeoutMs, intervalMs: 5_000, sleep },
  );
}

/**
 * Generate the admin key for the volume the backend runs on.
 *
 * Args:
 *   runner: The process runner.
 *   bed: The bed.
 *
 * Returns:
 *   The key.
 */
export function readAdminKey(runner: Runner, bed: Bed): string {
  const result = must(
    runner('docker', [...composeCommand(bed, ['real']), 'exec', '-T', 'backend', './generate_admin_key.sh'], {
      cwd: bed.clone,
      env: bed.env,
      timeoutMs: 60_000,
    }),
    'generate_admin_key.sh',
  );
  const key = parseAdminKey(result.stdout);
  if (!key) throw new Error(`generate_admin_key.sh printed no key:\n${result.stdout}${result.stderr}`);
  return key;
}

/**
 * Write one value into the bed's `.env.local`, keeping it private.
 *
 * Args:
 *   clone: The clone.
 *   updates: Names and values.
 */
export function updateBedEnv(clone: string, updates: Readonly<Record<string, string>>): void {
  const path = join(clone, ENV_FILE);
  writePrivateEnv(path, upsertEnvText(readFileSync(path, 'utf8'), updates));
}

/** Push the env to the deployment. */
export function syncEnv(runner: Runner, bed: Bed): RunResult {
  return must(
    runner('bash', ['scripts/sync-convex-env.sh', ENV_FILE], {
      cwd: bed.clone,
      env: bed.env,
      timeoutMs: 5 * 60_000,
    }),
    'sync:env',
  );
}

/** Push the functions once. */
export function pushFunctions(runner: Runner, bed: Bed): RunResult {
  return must(
    runner('pnpm', ['exec', 'convex', 'dev', '--once', '--typecheck', 'disable'], {
      cwd: bed.clone,
      env: bed.env,
      timeoutMs: 10 * 60_000,
    }),
    'convex dev --once',
  );
}

/** Restart the backend so its modules read the pushed env. */
export function restartBackend(runner: Runner, bed: Bed): void {
  must(
    runner('docker', [...composeCommand(bed, ['real']), 'restart', 'backend'], {
      cwd: bed.clone,
      env: bed.env,
      timeoutMs: 120_000,
    }),
    'restart backend',
  );
}

/**
 * Run the intake poll now rather than waiting for the cron.
 *
 * Args:
 *   runner: The process runner.
 *   bed: The bed.
 */
export function pollIntake(runner: Runner, bed: Bed): RunResult {
  return must(
    runner('pnpm', ['exec', 'convex', 'run', 'intakeActions:pollAll', '{}'], {
      cwd: bed.clone,
      env: bed.env,
      timeoutMs: 5 * 60_000,
    }),
    'convex run intakeActions:pollAll',
  );
}

/**
 * Start the app server on the bed's port and wait for it to serve.
 *
 * Args:
 *   startServer: The server starter.
 *   bed: The bed.
 *   fetchImpl: The fetch, injectable.
 *   timeoutMs: The ceiling.
 *
 * Returns:
 *   The server handle.
 */
export async function startApp(
  startServer: ServerStarter,
  bed: Bed,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = 180_000,
): Promise<ServerHandle> {
  const server = startServer('pnpm', ['exec', 'next', 'dev', '-H', 'localhost', '-p', String(bed.ports.app)], {
    cwd: bed.clone,
    env: { ...bed.env, PORT: String(bed.ports.app) },
  });
  try {
    await waitUntil(
      async () => {
        try {
          const response = await fetchImpl(appUrl(bed, '/'), { signal: AbortSignal.timeout(5_000) });
          return response.status < 500 ? true : undefined;
        } catch {
          return undefined;
        }
      },
      { what: `the app on localhost:${bed.ports.app}`, timeoutMs },
    );
  } catch (error) {
    await server.stop();
    throw new Error(`${(error as Error).message}\n${server.output().slice(-4000)}`);
  }
  return server;
}

/**
 * A URL on the bed's app, on `localhost` because the unlock cookie is only
 * set for that origin.
 *
 * Args:
 *   bed: The bed.
 *   path: The path, with a leading slash.
 *
 * Returns:
 *   The URL.
 */
export function appUrl(bed: Pick<Bed, 'ports'>, path: string): string {
  return `http://localhost:${bed.ports.app}${path}`;
}

/**
 * The unlock URL for the bed's no-auth mode.
 *
 * Args:
 *   bed: The bed.
 *   secret: The bed's `DEV_NO_AUTH_SECRET`.
 *
 * Returns:
 *   The URL to open once.
 */
export function unlockUrl(bed: Pick<Bed, 'ports'>, secret: string): string {
  return appUrl(bed, `/?${UNLOCK_PARAM}=${encodeURIComponent(secret)}`);
}
