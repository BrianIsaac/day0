import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('setup.sh');
/** The real bash, by path: the fake one the tests put first on the path must not run the script. */
const BASH = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();

const directories: string[] = [];

interface Machine {
  /** What `docker info` answers: a server version and architecture, or the daemon's refusal on stderr. */
  daemon?: { ok: true; arch?: string } | { ok: false; stderr: string };
  /** What `docker compose version` answers. */
  compose?: { ok: true; version: string } | { ok: false; stderr: string };
  /** The major version the bash on the path reports. */
  bashMajor?: number;
  /** Whether the clone already has its dependencies. */
  installed?: boolean;
}

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Every `pnpm` invocation, one per line, as the fake recorded it. */
  pnpm: string[];
}

/**
 * Write an executable shell script.
 *
 * Args:
 *   path: Where to put it.
 *   lines: Its body after the shebang.
 */
function executable(path: string, lines: string[]): void {
  writeFileSync(path, ['#!/bin/sh', ...lines, ''].join('\n'), 'utf8');
  chmodSync(path, 0o755);
}

/**
 * Run `setup.sh` as a newcomer would on a clean clone: the script alone in a
 * directory whose name has capitals, a space and a dot, with no
 * `node_modules`, and a fake `node`, `pnpm`, `docker` and `bash` first on the
 * path that answer as the machine says and record every `pnpm` call.
 *
 * Args:
 *   machine: What the fake tools report.
 *   args: The command line after `./setup.sh`.
 *
 * Returns:
 *   Exit status, both streams and the recorded `pnpm` calls.
 */
function runSetupSh(machine: Machine, args: string[]): Outcome {
  const root = mkdtempSync(join(tmpdir(), 'day0-setup-sh-'));
  directories.push(root);
  const clone = join(root, 'My Day0.clone');
  const bin = join(root, 'bin');
  mkdirSync(clone);
  mkdirSync(bin);
  copyFileSync(SCRIPT, join(clone, 'setup.sh'));
  chmodSync(join(clone, 'setup.sh'), 0o755);
  if (machine.installed) mkdirSync(join(clone, 'node_modules'));
  const calls = join(root, 'pnpm.log');
  const daemon = machine.daemon ?? { ok: true };
  const compose = machine.compose ?? { ok: true, version: 'Docker Compose version v2.39.1' };
  executable(join(bin, 'node'), ['echo v22.19.0']);
  executable(join(bin, 'pnpm'), [
    'if [ "$1" = "--version" ]; then echo 9.15.0; exit 0; fi',
    `echo "$*" >> '${calls}'`,
  ]);
  executable(join(bin, 'docker'), [
    'case "$1" in',
    '  --version) echo "Docker version 29.8.0, build 88096ef" ;;',
    daemon.ok
      ? `  info) echo '29.8.0 ${daemon.arch ?? 'x86_64'}' ;;`
      : `  info) echo '${daemon.stderr}' >&2; exit 1 ;;`,
    compose.ok
      ? `  compose) echo '${compose.version}' ;;`
      : `  compose) echo '${compose.stderr}' >&2; exit 1 ;;`,
    'esac',
  ]);
  if (machine.bashMajor !== undefined) {
    executable(join(bin, 'bash'), [
      `if [ "$1" = "-c" ]; then case "$2" in *VERSINFO*) echo ${machine.bashMajor} ;; *) echo ${machine.bashMajor}.2.57 ;; esac; fi`,
    ]);
  }
  const result = spawnSync(BASH, [join(clone, 'setup.sh'), ...args], {
    cwd: clone,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    pnpm: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
  };
}

afterEach((): void => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

// The script is bash; a machine without it cannot run the setup at all.
describe.skipIf(BASH === '')('setup.sh', (): void => {
  it('reports a stopped daemon on a dry run, names the fix, and runs nothing', (): void => {
    const outcome = runSetupSh(
      {
        daemon: {
          ok: false,
          stderr:
            'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
        },
      },
      ['--dry-run', '--route', 'local'],
    );
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain(
      'gap  Docker is installed and its daemon did not answer: Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
    );
    expect(outcome.stderr).toContain('sudo systemctl start docker');
    expect(outcome.stderr).toContain('Nothing was started and nothing was written.');
    expect(outcome.pnpm).toEqual([]);
  });

  it('still reports the gap when the daemon fails without a word', (): void => {
    const outcome = runSetupSh({ daemon: { ok: false, stderr: '' } }, ['--dry-run']);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain('gap  Docker is installed and its daemon did not answer');
    expect(outcome.stderr).toContain('Nothing was started and nothing was written.');
  });

  it('tells a user outside the docker group how to join it', (): void => {
    const outcome = runSetupSh(
      {
        daemon: {
          ok: false,
          stderr:
            'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock',
        },
      },
      ['--dry-run'],
    );
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain('this user may not reach its daemon: permission denied');
    expect(outcome.stderr).toContain('sudo usermod -aG docker "$USER"');
    expect(outcome.pnpm).toEqual([]);
  });

  it('names the Compose plugin when `docker compose` is missing, not docker-compose v1', (): void => {
    const outcome = runSetupSh(
      { compose: { ok: false, stderr: 'docker: unknown command: docker compose' } },
      ['--dry-run'],
    );
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain(
      'The Docker Compose v2 plugin (`docker compose`) did not answer: docker: unknown command: docker compose',
    );
    expect(outcome.stderr).toContain('docker-compose-plugin');
    expect(outcome.stderr).not.toContain('v1 is not enough');
  });

  it('runs with the bash 3.2 macOS ships on the path, since the env sync needs nothing newer', (): void => {
    const outcome = runSetupSh({ bashMajor: 3, installed: true }, [
      '--dry-run',
      '--route',
      'local',
    ]);
    expect(outcome.stderr).not.toContain('bash 4');
    expect(outcome.status).toBe(0);
    expect(outcome.pnpm).toEqual(['setup:local --mode real --dry-run --route local']);
  });

  it('names backup, restore and upgrade in its usage', (): void => {
    const outcome = runSetupSh({}, ['--help']);
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toContain('./setup.sh backup | restore <file> | upgrade');
    expect(outcome.stdout).toContain('./setup.sh restore <file>');
    expect(outcome.stdout).toContain('A mock deployment upgrades with pnpm setup:local upgrade.');
  });

  it('refuses an arm64 daemon before it installs anything, since the redactor wheel locks are x86_64 only', (): void => {
    const outcome = runSetupSh({ daemon: { ok: true, arch: 'aarch64' } }, ['--route', 'local']);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain('gap  This Docker daemon runs aarch64 containers');
    expect(outcome.stderr).toContain('pnpm setup:local');
    expect(outcome.pnpm).toEqual([]);
  });

  it('never installs dependencies on a dry run, and says what the setup would run', (): void => {
    const outcome = runSetupSh({}, ['--dry-run', '--route', 'local']);
    expect(outcome.status).toBe(0);
    expect(outcome.pnpm).toEqual([]);
    expect(outcome.stdout).toContain('  pnpm install --frozen-lockfile');
    expect(outcome.stdout).toContain('  pnpm setup:local --mode real --dry-run --route local');
    expect(outcome.stdout).toContain('Nothing was started and nothing was written.');
  });

  it('installs on a real run and hands every flag to the typed entry in real mode', (): void => {
    expect(runSetupSh({}, ['--route', 'local']).pnpm).toEqual([
      'install --frozen-lockfile',
      'setup:local --mode real --route local',
    ]);
    expect(runSetupSh({ installed: true }, ['--dry-run', '--route', 'featherless']).pnpm).toEqual([
      'setup:local --mode real --dry-run --route featherless',
    ]);
  });
});
