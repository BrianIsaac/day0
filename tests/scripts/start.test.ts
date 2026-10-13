import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
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

  it('is what package.json runs for pnpm start', (): void => {
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    ).scripts;
    expect(scripts.start).toBe('tsx scripts/start.ts');
    const source = readFileSync('scripts/start.ts', 'utf8');
    expect(source).toContain("spawn('next', startArguments(host, port)");
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
