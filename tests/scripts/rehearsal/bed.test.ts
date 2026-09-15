import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appUrl,
  cloneAt,
  composeDown,
  composePs,
  composeUp,
  generateKeys,
  installDependencies,
  pollIntake,
  pushFunctions,
  readAdminKey,
  readBedEnv,
  resolveCommit,
  restartBackend,
  startApp,
  syncEnv,
  unlockUrl,
  updateBedEnv,
  waitForBackend,
  waitForHealthy,
  writeBedEnv,
  type Bed,
} from '../../../scripts/rehearsal/bed';
import type { RunOptions, RunResult, ServerHandle } from '../../../scripts/rehearsal/process';

interface Call {
  command: string;
  args: string[];
  options: RunOptions;
}

function recorder(answers: Partial<Record<string, RunResult>> = {}): {
  calls: Call[];
  runner: (command: string, args: readonly string[], options?: RunOptions) => RunResult;
} {
  const calls: Call[] = [];
  return {
    calls,
    runner: (command, args, options = {}) => {
      calls.push({ command, args: [...args], options });
      const key = `${command} ${args.join(' ')}`;
      const match = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
      return match?.[1] ?? { status: 0, stdout: '', stderr: '' };
    },
  };
}

const bed: Bed = {
  clone: '/tmp/day0-rehearsal-abc123',
  project: 'day0-rehearsal-abc123',
  ports: { backend: 45210, site: 45211, dashboard: 45212, app: 45213 },
  env: { COMPOSE_PROJECT_NAME: 'day0-rehearsal-abc123' },
};

const compose = [
  'compose', '-p', 'day0-rehearsal-abc123', '--env-file', '.env.local',
  '--profile', 'real', '--profile', 'sandbox', '--profile', 'browser', '--profile', 'demo', '--profile', 'redactor',
];

describe('bringing the bed up', (): void => {
  const created: string[] = [];
  afterEach((): void => {
    for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('resolves the ref, clones it detached and installs from the lockfile', (): void => {
    const { calls, runner } = recorder({ 'git -C /src rev-parse': { status: 0, stdout: 'abc123def\n', stderr: '' } });
    expect(resolveCommit(runner, '/src', 'HEAD')).toBe('abc123def');
    cloneAt(runner, '/src', 'abc123def', '/tmp/clone');
    installDependencies(runner, '/tmp/clone');
    expect(calls.map((call) => [call.command, ...call.args].join(' '))).toEqual([
      'git -C /src rev-parse --verify HEAD^{commit}',
      'git clone --quiet --no-checkout /src /tmp/clone',
      'git -C /tmp/clone checkout --quiet --detach abc123def',
      'pnpm install --frozen-lockfile --prefer-offline',
    ]);
    expect(calls[3].options.cwd).toBe('/tmp/clone');
    const failing = recorder({ 'git clone': { status: 128, stdout: '', stderr: 'fatal: no such path' } });
    expect(() => cloneAt(failing.runner, '/src', 'abc', '/tmp/x')).toThrow('git clone failed (status 128)');
  });

  it("writes the bed's env from the example, private to the owner, and reads it back", (): void => {
    const clone = mkdtempSync(join(tmpdir(), 'rehearsal-bed-'));
    created.push(clone);
    writeFileSync(join(clone, '.env.example'), 'CONVEX_DEPLOYMENT=\nOPENAI_API_KEY=\n# comment\nDAY0_SURFACE_MODE=mock\n');
    writeBedEnv(clone, { OPENAI_API_KEY: 'sk-test', DAY0_SURFACE_MODE: 'real', COMPOSE_PROJECT_NAME: 'p' });
    const path = join(clone, '.env.local');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toBe(
      'CONVEX_DEPLOYMENT=\nOPENAI_API_KEY=sk-test\n# comment\nDAY0_SURFACE_MODE=real\nCOMPOSE_PROJECT_NAME=p\n',
    );
    updateBedEnv(clone, { CONVEX_SELF_HOSTED_ADMIN_KEY: 'convex-self-hosted|k' });
    expect(readBedEnv(clone)).toEqual({
      CONVEX_DEPLOYMENT: '',
      OPENAI_API_KEY: 'sk-test',
      DAY0_SURFACE_MODE: 'real',
      COMPOSE_PROJECT_NAME: 'p',
      CONVEX_SELF_HOSTED_ADMIN_KEY: 'convex-self-hosted|k',
    });
    expect(readBedEnv('/nonexistent')).toEqual({});
  });

  it('issues the README sequence against the bed project with its env', (): void => {
    const { calls, runner } = recorder({
      'docker compose -p day0-rehearsal-abc123 --env-file .env.local --profile real exec': {
        status: 0,
        stdout: 'Admin key:\nconvex-self-hosted|abc\n',
        stderr: '',
      },
      'docker compose -p day0-rehearsal-abc123 --env-file .env.local --profile real --profile sandbox --profile browser --profile demo --profile redactor ps': {
        status: 0,
        stdout: 'backend running healthy\nredactor running starting\n',
        stderr: '',
      },
    });
    generateKeys(runner, bed.clone);
    composeUp(runner, bed);
    expect(readAdminKey(runner, bed)).toBe('convex-self-hosted|abc');
    syncEnv(runner, bed);
    pushFunctions(runner, bed);
    restartBackend(runner, bed);
    pollIntake(runner, bed);
    expect(composePs(runner, bed)).toEqual(['backend running healthy', 'redactor running starting']);
    composeDown(runner, bed);
    composeDown(runner, bed, false);
    expect(calls.map((call) => [call.command, ...call.args].join(' '))).toEqual([
      'pnpm exec tsx scripts/dev-no-auth-key.ts init',
      `docker ${compose.join(' ')} up -d --no-build`,
      'docker compose -p day0-rehearsal-abc123 --env-file .env.local --profile real exec -T backend ./generate_admin_key.sh',
      'bash scripts/sync-convex-env.sh .env.local',
      'pnpm exec convex dev --once --typecheck disable',
      'docker compose -p day0-rehearsal-abc123 --env-file .env.local --profile real restart backend',
      'pnpm exec convex run intakeActions:pollAll {}',
      `docker ${compose.join(' ')} ps -a --format {{.Service}} {{.State}} {{.Health}}`,
      `docker ${compose.join(' ')} down -v`,
      `docker ${compose.join(' ')} down`,
    ]);
    for (const call of calls.slice(1)) {
      expect(call.options.cwd).toBe(bed.clone);
      expect(call.options.env).toBe(bed.env);
    }
    const noKey = recorder();
    expect(() => readAdminKey(noKey.runner, bed)).toThrow('printed no key');
  });

  it('waits for the backend version, a healthy service, and the app on localhost', async (): Promise<void> => {
    const fetchImpl = (async (url: string | URL | Request): Promise<Response> => {
      if (String(url).endsWith('/version')) return new Response('0.1.0\n');
      return new Response('ok');
    }) as typeof fetch;
    expect(await waitForBackend(45210, fetchImpl, 60_000)).toBe('0.1.0');

    let pings = 0;
    const { runner } = recorder({
      'docker': { status: 0, stdout: 'backend running healthy\nredactor running starting\n', stderr: '' },
    });
    const sleep = async (): Promise<void> => {
      pings += 1;
    };
    await waitForHealthy(runner, bed, 'backend', 60_000, sleep);
    expect(pings).toBe(0);
    const exited = recorder({ 'docker': { status: 0, stdout: 'redactor exited (1)\n', stderr: '' } });
    await expect(waitForHealthy(exited.runner, bed, 'redactor', 60_000, sleep)).rejects.toThrow('redactor exited');

    const started: Array<{ command: string; args: string[]; options: RunOptions }> = [];
    let stopped = 0;
    const startServer = (command: string, args: readonly string[], options: RunOptions): ServerHandle => {
      started.push({ command, args: [...args], options });
      return { pid: 4242, output: () => 'ready', stop: async () => { stopped += 1; } };
    };
    const server = await startApp(startServer, bed, fetchImpl, 60_000);
    expect(server.pid).toBe(4242);
    expect(started[0].command).toBe('pnpm');
    expect(started[0].args).toEqual(['exec', 'next', 'dev', '-H', 'localhost', '-p', '45213']);
    expect(started[0].options.env).toMatchObject({ COMPOSE_PROJECT_NAME: 'day0-rehearsal-abc123', PORT: '45213' });
    expect(stopped).toBe(0);

    const never = (async (): Promise<Response> => {
      throw new Error('refused');
    }) as typeof fetch;
    await expect(startApp(startServer, bed, never, 1)).rejects.toThrow('the app on localhost:45213');
    expect(stopped).toBe(1);
  });

  it('addresses the app on localhost and carries the unlock secret once', (): void => {
    expect(appUrl(bed, '/documentation')).toBe('http://localhost:45213/documentation');
    expect(unlockUrl(bed, 'a b')).toBe('http://localhost:45213/?day0_key=a%20b');
  });
});
