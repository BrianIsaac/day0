/**
 * A recorded setup environment for the real-mode helper and its lifecycle
 * verbs: a disposable checkout, a fake `docker`/`pnpm`/`npx` that answers what
 * the tests script and records every call, and the option shapes the tests
 * start from. Nothing here touches a daemon, a port or a pull.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readEnvValues,
  writeEnvValues,
  type RunOptions,
  type RunResult,
  type SetupIo,
  type SetupOptions,
} from '../../scripts/setup';

export const NODE_IMAGE = `node:22-alpine@sha256:${'c'.repeat(64)}`;
export const CPU_REQUIREMENTS = 'torch==2.9.0+cpu\ngliner==0.2.22\n';
export const CUDA_REQUIREMENTS = 'torch==2.9.0\ngliner==0.2.22\n';
export const CPU_STAMP = createHash('sha256').update(CPU_REQUIREMENTS).digest('hex');
export const CUDA_STAMP = createHash('sha256').update(CUDA_REQUIREMENTS).digest('hex');
export const SYNTHETIC_KEY = 'synthetic-featherless-key-for-tests';

const directories: string[] = [];

/**
 * A disposable checkout holding what the real-mode helper reads: the compose
 * file with its pinned node image, the two redactor requirements files and the
 * example env.
 *
 * Args:
 *   envLocal: Contents of an existing `.env.local`, or undefined for a clean clone.
 *   options.mainWorktree: Whether to give it a `.git` directory.
 *
 * Returns:
 *   The directory path.
 */
export function checkout(envLocal?: string, options: { mainWorktree?: boolean } = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'day0-setup-real-'));
  directories.push(directory);
  mkdirSync(join(directory, 'scripts'));
  mkdirSync(join(directory, 'redactor'));
  if (options.mainWorktree) mkdirSync(join(directory, '.git'));
  writeFileSync(join(directory, 'package.json'), '{"name":"day0"}\n', 'utf8');
  writeFileSync(
    join(directory, 'docker-compose.yml'),
    ['services:', '  looker-tile:', `    image: ${NODE_IMAGE}`, ''].join('\n'),
    'utf8',
  );
  writeFileSync(join(directory, 'redactor', 'requirements.txt'), CPU_REQUIREMENTS, 'utf8');
  writeFileSync(join(directory, 'redactor', 'requirements-cuda.txt'), CUDA_REQUIREMENTS, 'utf8');
  writeFileSync(
    join(directory, '.env.example'),
    [
      '# Day0 environment contract.',
      'CONVEX_DEPLOYMENT=',
      'NEXT_PUBLIC_CONVEX_URL=',
      'CONVEX_SELF_HOSTED_URL=',
      'CONVEX_SELF_HOSTED_ADMIN_KEY=',
      'COMPOSE_PROJECT_NAME=',
      'CONVEX_BIND_ADDR=127.0.0.1',
      'CONVEX_PORT=3210',
      'CONVEX_SITE_PROXY_PORT=3211',
      'CONVEX_DASHBOARD_PORT=6791',
      'DAY0_APP_PORT=3000',
      'MODEL_PORT=11434',
      'MODEL_GPU=auto',
      'NEXT_PUBLIC_DEV_NO_AUTH=',
      'DEV_NO_AUTH_SECRET=',
      'OPENAI_API_KEY=',
      'OPENAI_BASE_URL=',
      'CONVEX_OPENAI_BASE_URL=',
      'OPENAI_MODEL=gpt-5.6-terra',
      'OPENAI_JSON_MODE=auto',
      'OPENAI_MAX_OUTPUT_TOKENS=',
      'OPENAI_REASONING_EFFORT=',
      'FEATHERLESS_API_KEY=',
      'DAYTONA_API_KEY=',
      'DAY0_SURFACE_MODE=mock',
      'DAY0_DOCS_HOST_DIR=./docs-local',
      'DAY0_DOCS_ROOT=/docs',
      'DAY0_BROWSER_MCP_URL=',
      'DAY0_REDACTOR_URL=',
      'NEXT_PUBLIC_DEMO_BOSS_EMAIL=',
      '',
    ].join('\n'),
    'utf8',
  );
  if (envLocal !== undefined) writeFileSync(join(directory, '.env.local'), envLocal, 'utf8');
  return directory;
}

export interface Call {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface Harness {
  io: SetupIo;
  commands: Call[];
  output: string[];
  directory: string;
  /** Volumes Docker reports; the fake keeps it current across creates and a reset. */
  volumes: string[];
}

export interface HarnessOptions {
  envLocal?: string;
  answers?: string[];
  services?: string[];
  busyPorts?: number[];
  volumes?: string[];
  /** Stamp per venv volume; a volume not listed has none. */
  stamps?: Record<string, string>;
  /** Whether `nvidia-smi -L` names a GPU. */
  driver?: boolean;
  /** What compose reports for the redactor on each poll, last value repeated. */
  redactorHealth?: string[];
  failing?: { match: string; status: number; stderr: string }[];
  environment?: Record<string, string | undefined>;
  adminKeyAccepted?: boolean;
  mainWorktree?: boolean;
  inspectOwner?: string;
  /** Whether stdin is a terminal; absent leaves the flag off the fake. */
  interactive?: boolean;
  /** What `ollama list` prints inside a running model service. */
  ollamaList?: string;
  /** What the manifest listing of `<project>_model_data` prints. */
  manifestListing?: string;
  /** Volumes the fake compose leaves behind on `down -v`, as compose does for a stray label. */
  leftover?: string[];
  /** Services `docker ps` reports until the first `up`; absent means `services` throughout. */
  servicesBeforeUp?: string[];
}

/**
 * A setup environment that records every effect instead of causing one.
 *
 * Args:
 *   options: What the fake machine should report.
 *
 * Returns:
 *   The injectable environment, the recorded commands, the printed lines and
 *   the volume inventory as the fake sees it.
 */
export function harness(options: HarnessOptions = {}): Harness {
  const directory = checkout(options.envLocal, { mainWorktree: options.mainWorktree });
  const commands: Call[] = [];
  const output: string[] = [];
  const answers = [...(options.answers ?? [])];
  const services = options.services ?? [];
  const volumes = [...(options.volumes ?? [])];
  const stamps = { ...(options.stamps ?? {}) };
  const failing = options.failing ?? [];
  const health = [...(options.redactorHealth ?? ['healthy'])];
  let minted = 0;
  let clock = 0;
  let broughtUp = false;

  const run = (command: string, args: readonly string[], runOptions?: RunOptions): RunResult => {
    const joined = [command, ...args].join(' ');
    commands.push({ command, args: [...args], env: runOptions?.env });
    if (/run (convex|sandbox|model|redactor):up/.test(joined)) broughtUp = true;
    for (const failure of failing) {
      if (joined.includes(failure.match)) {
        return { status: failure.status, stdout: '', stderr: failure.stderr };
      }
    }
    if (joined.startsWith('node --version')) return { status: 0, stdout: 'v22.19.0\n', stderr: '' };
    if (joined.startsWith('pnpm --version')) return { status: 0, stdout: '9.15.0\n', stderr: '' };
    if (joined.startsWith('docker --version')) {
      return { status: 0, stdout: 'Docker version 29.8.0, build 88096ef\n', stderr: '' };
    }
    if (joined.startsWith('docker compose version')) {
      return { status: 0, stdout: 'Docker Compose version v5.5.1\n', stderr: '' };
    }
    if (joined.startsWith('docker volume ls')) {
      // A compose label filter answers only that project's volumes.
      const filter = args.find((argument) => argument.startsWith('label=com.docker.compose.project='));
      const project = filter?.slice('label=com.docker.compose.project='.length);
      const listed = project === undefined ? volumes : volumes.filter((name) => name.startsWith(`${project}_`));
      return { status: 0, stdout: `${listed.join('\n')}\n`, stderr: '' };
    }
    if (joined.startsWith('docker volume rm')) {
      for (const name of args.slice(2)) {
        const index = volumes.indexOf(name);
        if (index >= 0) volumes.splice(index, 1);
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (joined.startsWith('docker volume create')) {
      const name = args[args.length - 1];
      if (!volumes.includes(name)) volumes.push(name);
      return { status: 0, stdout: `${name}\n`, stderr: '' };
    }
    if (joined.startsWith('docker run --rm -v')) {
      const source = args[3].split(':')[0];
      if (joined.includes('/ollama/models/manifests')) {
        return { status: 0, stdout: options.manifestListing ?? '', stderr: '' };
      }
      const target = args[5].split(':')[0];
      if (joined.includes('cat /venv/')) {
        const stamp = stamps[source];
        return stamp === undefined
          ? { status: 1, stdout: '', stderr: 'cat: can\'t open: No such file' }
          : { status: 0, stdout: `${stamp}\n`, stderr: '' };
      }
      // The volume copy carries the stamp across with the wheels.
      if (stamps[source] !== undefined) stamps[target] = stamps[source];
      return { status: 0, stdout: '', stderr: '' };
    }
    if (joined.includes(' down -v')) {
      const project = runOptions?.env?.COMPOSE_PROJECT_NAME ?? readEnvValues(join(directory, '.env.local')).COMPOSE_PROJECT_NAME ?? '';
      for (let index = volumes.length - 1; index >= 0; index -= 1) {
        if (volumes[index].startsWith(`${project}_`) && !(options.leftover ?? []).includes(volumes[index])) {
          volumes.splice(index, 1);
        }
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (joined.includes('exec -T model ollama list')) {
      return options.ollamaList === undefined
        ? { status: 1, stdout: '', stderr: 'service "model" is not running' }
        : { status: 0, stdout: options.ollamaList, stderr: '' };
    }
    if (joined.startsWith('docker inspect')) {
      return { status: 0, stdout: `${options.inspectOwner ?? directory}\n`, stderr: '' };
    }
    if (joined.startsWith('docker ps')) {
      const reported = !broughtUp && options.servicesBeforeUp !== undefined ? options.servicesBeforeUp : services;
      return { status: 0, stdout: `${reported.join('\n')}\n`, stderr: '' };
    }
    if (joined.includes('ps -a --format json redactor')) {
      const state = health.length > 1 ? health.shift() : health[0];
      return {
        status: 0,
        stdout: `${JSON.stringify({ Service: 'redactor', State: state === 'exited' ? 'exited' : 'running', Health: state })}\n`,
        stderr: '',
      };
    }
    if (joined.includes('port backend')) {
      const port = readEnvValues(join(directory, '.env.local')).CONVEX_PORT ?? '3210';
      return { status: 0, stdout: `127.0.0.1:${port}\n`, stderr: '' };
    }
    if (joined.includes('generate_admin_key.sh')) {
      minted += 1;
      return {
        status: 0,
        stdout: `Admin key:\nconvex-self-hosted|0123456789abcdef${minted}\n`,
        stderr: '',
      };
    }
    if (joined.includes('convex env list')) {
      return { status: options.adminKeyAccepted === false ? 1 : 0, stdout: '', stderr: '' };
    }
    if (joined.includes('nvidia-smi')) {
      return options.driver
        ? { status: 0, stdout: 'GPU 0: NVIDIA GeForce RTX 5070 Ti Laptop GPU (UUID: GPU-x)\n', stderr: '' }
        : { status: 1, stdout: '', stderr: 'not found' };
    }
    if (joined.includes('dev-no-auth-key.ts url')) {
      const port = runOptions?.env?.PORT ?? '3000';
      return { status: 0, stdout: `http://localhost:${port}/?day0_key=unlock-secret\n`, stderr: '' };
    }
    if (joined.includes('dev:no-auth-key')) {
      const path = join(directory, '.env.local');
      const values = readEnvValues(path);
      if (!values.DEV_NO_AUTH_SECRET) {
        writeEnvValues(path, {
          DEV_NO_AUTH_SECRET: 'generated-secret',
          DEV_NO_AUTH_SIGNING_KEY: 'generated-signing-key',
          DEV_NO_AUTH_JWKS: 'data:text/plain;base64,generated-jwks',
          DAY0_CREDENTIAL_KEY: 'generated-credential-key',
          DAY0_NOTION_MCP_AUTH_TOKEN: 'generated-notion-token',
        });
      }
      return { status: 0, stdout: 'Wrote keys\n', stderr: '' };
    }
    if (joined.includes('convex dev --once')) {
      writeEnvValues(join(directory, '.env.local'), {
        NEXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:3211',
      });
      return { status: 0, stdout: '', stderr: '' };
    }
    if (joined.includes('check:setup')) {
      return { status: 0, stdout: 'Nothing here is half-done. Mode real, route featherless.\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  const io: SetupIo = {
    cwd: directory,
    environment: options.environment ?? {},
    run,
    ask: async (question: string): Promise<string> => {
      output.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`no scripted answer for: ${question}`);
      return answer;
    },
    log: (line: string): void => {
      output.push(line);
    },
    portFree: async (port: number): Promise<boolean> => !(options.busyPorts ?? []).includes(port),
    waitForBackend: async (): Promise<string | undefined> => '2026-09-16',
    sleep: async (ms: number): Promise<void> => {
      clock += ms;
    },
    now: (): number => clock,
    ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
  };
  return { io, commands, output, directory, volumes };
}

/**
 * Options for a non-interactive real-mode run on the Featherless route.
 *
 * Args:
 *   overrides: Fields to replace.
 *
 * Returns:
 *   Complete setup options.
 */
export function realRoute(overrides: Partial<SetupOptions> = {}): SetupOptions {
  return {
    mode: 'real',
    route: 'featherless',
    project: 'day0-setup-test',
    ports: {},
    gpu: 'auto',
    sandbox: 'local',
    bossEmail: 'manager@example.com',
    dryRun: false,
    reset: false,
    purgeEnv: false,
    assumeYes: true,
    help: false,
    ...overrides,
  };
}

/** Every recorded command as one line each. */
export function ran(h: Harness): string {
  return h.commands.map((entry) => [entry.command, ...entry.args].join(' ')).join('\n');
}

/** Remove every checkout made so far; call it from `afterEach`. */
export function cleanupCheckouts(): void {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
