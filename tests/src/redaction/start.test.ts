import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const START = fileURLToPath(new URL('../../../redactor/start.sh', import.meta.url));

/** The script is POSIX shell over `find` and `sha256sum`; a machine without them skips. */
const HAS_TOOLS = ['sh', 'find', 'sha256sum'].every(
  (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
);

let root = '';

/** The three volumes, the app directory and a bin directory for stand-ins, under one temp root. */
function layout(): { venv: string; models: string; scratch: string; app: string; bin: string } {
  const paths = {
    venv: join(root, 'venv'),
    models: join(root, 'models'),
    scratch: join(root, 'tmp'),
    app: join(root, 'app'),
    bin: join(root, 'bin'),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  return paths;
}

/** Run start.sh with only the environment given, plus a PATH that finds the stand-ins first. */
function start(
  args: readonly string[],
  env: Record<string, string>,
  bin: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', [START, ...args], {
    encoding: 'utf8',
    env: { NODE_ENV: 'test', PATH: `${bin}:${process.env.PATH ?? ''}`, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A stand-in executable that appends its arguments to a log. */
function standIn(bin: string, name: string, log: string): void {
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\necho "$@" >> '${log}'\n`);
  chmodSync(path, 0o755);
}

beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), 'redactor-start-'));
});

afterEach((): void => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!HAS_TOOLS)('redactor start.sh --own-volumes (needs sh, find, sha256sum)', () => {
  it('leaves volumes alone when the redactor uid already owns everything in them', () => {
    const paths = layout();
    const log = join(root, 'chown.log');
    standIn(paths.bin, 'chown', log);
    writeFileSync(join(paths.models, 'weights.bin'), 'x');
    const owner = `${process.getuid!()}:${process.getgid!()}`;
    const result = start(
      ['--own-volumes'],
      {
        REDACTOR_OWNER: owner,
        REDACTOR_VENV: paths.venv,
        REDACTOR_MODELS_DIR: paths.models,
        TMPDIR: paths.scratch,
      },
      paths.bin,
    );
    expect(result.status).toBe(0);
    expect(existsSync(log)).toBe(false);
  });

  it('hands every volume holding anything owned by another uid to the redactor uid', () => {
    const paths = layout();
    const log = join(root, 'chown.log');
    standIn(paths.bin, 'chown', log);
    const result = start(
      ['--own-volumes'],
      {
        REDACTOR_OWNER: '10001:10001',
        REDACTOR_VENV: paths.venv,
        REDACTOR_MODELS_DIR: paths.models,
        TMPDIR: paths.scratch,
      },
      paths.bin,
    );
    expect(result.status).toBe(0);
    expect(spawnSync('cat', [log], { encoding: 'utf8' }).stdout.trim().split('\n')).toEqual([
      `-R 10001:10001 ${paths.venv}`,
      `-R 10001:10001 ${paths.models}`,
      `-R 10001:10001 ${paths.scratch}`,
    ]);
  });

  it('refuses without an owner to hand the volumes to', () => {
    const paths = layout();
    const result = start(['--own-volumes'], { TMPDIR: paths.scratch }, paths.bin);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('REDACTOR_OWNER');
  });
});

describe.skipIf(!HAS_TOOLS)('redactor start.sh (needs sh, find, sha256sum)', () => {
  /** A virtual environment already built from the app directory's requirements. */
  function builtVenv(paths: ReturnType<typeof layout>): string {
    writeFileSync(join(paths.app, 'requirements.txt'), 'gliner==0.2.29\n');
    const digest = spawnSync('sha256sum', [join(paths.app, 'requirements.txt')], {
      encoding: 'utf8',
    }).stdout.split(' ')[0]!;
    mkdirSync(join(paths.venv, 'bin'));
    writeFileSync(join(paths.venv, '.requirements.sha256'), `${digest}\n`);
    const log = join(root, 'python.log');
    standIn(join(paths.venv, 'bin'), 'python', log);
    return log;
  }

  it('empties the scratch volume, makes the cache and home directories, and serves', () => {
    const paths = layout();
    const log = builtVenv(paths);
    writeFileSync(join(paths.scratch, 'pip-unpack-left-behind'), 'x');
    const result = start(
      [],
      {
        REDACTOR_VENV: paths.venv,
        REDACTOR_APP_DIR: paths.app,
        TMPDIR: paths.scratch,
        HF_HOME: join(paths.scratch, 'huggingface'),
        XDG_CACHE_HOME: join(paths.scratch, 'cache'),
        HOME: join(paths.scratch, 'home'),
      },
      paths.bin,
    );
    expect(result.status).toBe(0);
    expect(readdirSync(paths.scratch).sort()).toEqual(['cache', 'home', 'huggingface']);
    expect(spawnSync('cat', [log], { encoding: 'utf8' }).stdout.trim()).toBe(
      join(paths.app, 'server.py'),
    );
  });

  it('refuses to empty a TMPDIR that is the root directory', () => {
    const paths = layout();
    const result = start([], { REDACTOR_VENV: paths.venv, TMPDIR: '/' }, paths.bin);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not a scratch directory it may empty');
  });
});
