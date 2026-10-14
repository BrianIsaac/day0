import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  resolveStartHost,
  START_HOST,
  startArguments,
  startEnvironment,
  startRefusal,
} from '../../scripts/start';

describe('the address pnpm start binds (P-1)', (): void => {
  it('is loopback by address unless DAY0_APP_HOST widens it, the shell before the file', (): void => {
    expect(START_HOST).toBe('127.0.0.1');
    expect(resolveStartHost(undefined, undefined)).toBe('127.0.0.1');
    expect(resolveStartHost('', 'DAY0_APP_HOST=\nDAY0_APP_PORT=3000\n')).toBe('127.0.0.1');
    expect(resolveStartHost(undefined, 'DAY0_APP_HOST=10.0.0.5\n')).toBe('10.0.0.5');
    expect(resolveStartHost('0.0.0.0', 'DAY0_APP_HOST=10.0.0.5\n')).toBe('0.0.0.0');
  });

  it('is what next start is given, with the port pnpm dev would serve on', (): void => {
    expect(startArguments('127.0.0.1', '3000')).toEqual(['start', '-H', '127.0.0.1', '-p', '3000']);
  });

  // W17-R28 (reader 5): the contributors' table and the README's company sign-in still said
  // `pnpm start` is `next start` on 3000, after 17-P made it this script on loopback.
  it('is described as it starts, never as next start on 3000 (W17-R28)', (): void => {
    const contributing = readFileSync('CONTRIBUTING.md', 'utf8');
    const readme = readFileSync('README.md', 'utf8');
    expect(contributing).not.toContain('`next start` on 3000');
    expect(contributing).toContain(
      '| `pnpm start` | The built app on `127.0.0.1`, its port `PORT`, then `DAY0_APP_PORT`, then 3000',
    );
    expect(readme).not.toContain('the first install runs `next start`');
    expect(readme).toContain('the first install runs `pnpm start`');
  });

  it('is what package.json runs for pnpm start', (): void => {
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    ).scripts;
    expect(scripts.start).toBe('tsx scripts/start.ts');
  });
});

describe('pnpm start, run (wave 17, 17-P)', (): void => {
  const ROOT = resolve(__dirname, '../..');
  const directory = mkdtempSync(join(tmpdir(), 'day0-start-'));
  const bin = join(directory, 'bin');
  // tsx by its own entry and this Node, so the child's PATH holds the stand-in and nothing else.
  const TSX = join(ROOT, 'node_modules/tsx/dist/cli.mjs');

  beforeAll((): void => {
    mkdirSync(bin);
    // A stand-in for Next that says what it was started with and exits as a server never does.
    writeFileSync(
      join(bin, 'next'),
      '#!/bin/sh\necho "next $* PORT=$PORT TELEMETRY=$NEXT_TELEMETRY_DISABLED"\nexit 7\n',
      { mode: 0o755 },
    );
  });

  afterAll((): void => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** Run `scripts/start.ts` in a checkout whose `.env.local` is given, with a chosen PATH. */
  function start(
    envText: string,
    path: string,
  ): { status: number | null; out: string; err: string } {
    writeFileSync(join(directory, '.env.local'), envText, 'utf8');
    const ran = spawnSync(process.execPath, [TSX, join(ROOT, 'scripts/start.ts')], {
      cwd: directory,
      encoding: 'utf8',
      env: { PATH: path, HOME: directory, NODE_ENV: 'test' },
      timeout: 60_000,
    });
    return { status: ran.status, out: ran.stdout, err: ran.stderr };
  }

  it('starts Next on this machine’s own address and the file’s port, and exits as it does', (): void => {
    const ran = start('DAY0_APP_PORT=4123\n', bin);
    expect(ran.out.trim()).toBe('next start -H 127.0.0.1 -p 4123 PORT=4123 TELEMETRY=1');
    expect(ran.status).toBe(7);
  });

  it('says that only plain http is proxied when HTTP_PROXY alone is named', (): void => {
    const ran = start('HTTP_PROXY=http://day0:hunter2@proxy.acme.test:3128\n', bin);
    expect(ran.out).toContain(
      'Only HTTP_PROXY is named (proxy.acme.test:3128): every vendor Day0 reaches is https, which ' +
        'HTTPS_PROXY carries, so the app’s requests go out directly. Name the proxy in ' +
        'HTTPS_PROXY as well (docs/running/egress.md).',
    );
    expect(ran.out).not.toContain('hunter2');
    expect(ran.out).not.toContain('go out through the proxy');
  });

  it('says so in one line when Next is not there to start, and starts nothing', (): void => {
    const ran = start('', join(directory, 'nothing-here'));
    expect(ran.status).toBe(1);
    expect(ran.err.trim().split('\n')).toEqual([
      'error: Next could not be started (spawn next ENOENT). Run `pnpm start` from the checkout, ' +
        'after `pnpm install`.',
    ]);
  });
});

describe('what the app is started with behind a proxy on the way out (RM31 (a))', (): void => {
  it('is the shell, the port and Next’s telemetry switch when the file names no proxy', (): void => {
    expect(startEnvironment({ PATH: '/usr/bin' }, 'DAY0_APP_PORT=3000\n', '3000')).toEqual({
      PATH: '/usr/bin',
      PORT: '3000',
      NEXT_TELEMETRY_DISABLED: '1',
    });
  });

  it('hands Node the proxy the file names, since Next reads the file after Node has started', (): void => {
    expect(
      startEnvironment(
        { PATH: '/usr/bin' },
        'HTTPS_PROXY=http://proxy.acme.test:3128\nNO_PROXY=day0.acme.test\n',
        '3000',
      ),
    ).toEqual({
      PATH: '/usr/bin',
      PORT: '3000',
      NEXT_TELEMETRY_DISABLED: '1',
      HTTPS_PROXY: 'http://proxy.acme.test:3128',
      NO_PROXY: 'localhost,127.0.0.1,day0.acme.test',
      NODE_USE_ENV_PROXY: '1',
    });
  });

  it('hands Node a proxy the file quotes and comments as a shell file would, never refusing it (W17-R24)', (): void => {
    const envText = [
      "export HTTPS_PROXY='http://proxy.acme.test:3128' # corp",
      'NO_PROXY="day0.acme.test"',
      '',
    ].join('\r\n');
    expect(startRefusal({}, envText, 'v22.23.2')).toBeUndefined();
    expect(startEnvironment({ PATH: '/usr/bin' }, envText, '3000')).toMatchObject({
      HTTPS_PROXY: 'http://proxy.acme.test:3128',
      NO_PROXY: 'localhost,127.0.0.1,day0.acme.test',
      NODE_USE_ENV_PROXY: '1',
    });
  });

  it('lets the shell name the proxy over the file', (): void => {
    expect(
      startEnvironment(
        { HTTPS_PROXY: 'http://other.acme.test:8080' },
        'HTTPS_PROXY=http://proxy.acme.test:3128\n',
        '3000',
      ),
    ).toMatchObject({ HTTPS_PROXY: 'http://other.acme.test:8080', NODE_USE_ENV_PROXY: '1' });
  });

  it('refuses to start on a Node that would ignore the proxy and dial out directly', (): void => {
    const envText = 'HTTPS_PROXY=http://proxy.acme.test:3128\n';
    expect(startRefusal({}, envText, 'v22.23.2')).toBeUndefined();
    expect(startRefusal({}, undefined, 'v22.12.0')).toBeUndefined();
    expect(startRefusal({}, envText, 'v22.12.0')).toBe(
      'HTTPS_PROXY names a proxy, and this Node (v22.12.0) does not read one from the ' +
        'environment: Node 22.21.0 or later does. Its requests would go out directly.',
    );
    // An address no client can use would send the app's requests nowhere it can say.
    expect(startRefusal({}, 'HTTPS_PROXY=proxy.acme.test:3128\n', 'v22.23.2')).toBe(
      'HTTPS_PROXY is not an address a client can use: write it as http://<host>:<port>.',
    );
  });
});

describe('Next.js’s own telemetry (wave 17, 17-P)', (): void => {
  // The bed day0-w17p's forward proxy logged four CONNECT telemetry.nextjs.org:443 from the
  // machine during the install's build and the app's start: a host no list Day0 prints names.
  // Next reads the switch from its environment, so it is set where Next is started, before it.
  it('is off for the build, by the script every build goes through', (): void => {
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    ).scripts;
    expect(scripts.build).toBe('NEXT_TELEMETRY_DISABLED=1 next build');
  });

  it('is off for the app `pnpm start` starts, unless the shell names the switch itself', (): void => {
    expect(startEnvironment({}, undefined, '3000').NEXT_TELEMETRY_DISABLED).toBe('1');
    expect(
      startEnvironment({ NEXT_TELEMETRY_DISABLED: '' }, undefined, '3000').NEXT_TELEMETRY_DISABLED,
    ).toBe('');
  });
});
