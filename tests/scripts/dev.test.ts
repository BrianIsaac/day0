import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { devServerEnvironment, resolveAppHost, resolveAppPort } from '../../scripts/dev';

describe('the port pnpm dev serves on', (): void => {
  it('takes the shell, then the file, then 3000', (): void => {
    expect(resolveAppPort('45300', 'DAY0_APP_PORT=4000\n')).toBe('45300');
    expect(resolveAppPort('', 'DAY0_APP_PORT=4000\n')).toBe('4000');
    expect(resolveAppPort(undefined, 'DAY0_APP_PORT="4000"\n')).toBe('4000');
    expect(resolveAppPort(undefined, 'DAY0_APP_PORT=\n')).toBe('3000');
    expect(resolveAppPort(undefined, undefined)).toBe('3000');
  });

  it('is what package.json runs for pnpm dev, so the URL and the server agree', (): void => {
    const scripts = (
      JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
    ).scripts;
    expect(scripts.dev).toBe('tsx scripts/dev.ts');
    const source = readFileSync('scripts/dev.ts', 'utf8');
    expect(source).toContain("['scripts/dev-no-auth-key.ts', 'url']");
    expect(source).toContain("['dev', '-H', host, '-p', port]");
  });
});

describe('the address pnpm dev binds', (): void => {
  it('takes the shell, then the file, then loopback by name', (): void => {
    expect(resolveAppHost('0.0.0.0', 'DAY0_APP_HOST=127.0.0.1\n')).toBe('0.0.0.0');
    expect(resolveAppHost(' ', 'DAY0_APP_HOST="127.0.0.1"\n')).toBe('127.0.0.1');
    expect(resolveAppHost(undefined, 'DAY0_APP_PORT=4000\n')).toBe('localhost');
    expect(resolveAppHost(undefined, undefined)).toBe('localhost');
  });
});

describe('what the dev server runs with (C-34)', (): void => {
  it('turns Next telemetry off and serves on the chosen port', (): void => {
    expect(devServerEnvironment({ PATH: '/usr/bin' }, '4000')).toEqual({
      PATH: '/usr/bin',
      PORT: '4000',
      NEXT_TELEMETRY_DISABLED: '1',
    });
  });

  it('leaves the telemetry switch to a shell that sets it', (): void => {
    expect(devServerEnvironment({ NEXT_TELEMETRY_DISABLED: '0' }, '3000')).toMatchObject({
      NEXT_TELEMETRY_DISABLED: '0',
    });
  });

  it('is the environment pnpm dev starts next dev with', (): void => {
    expect(readFileSync('scripts/dev.ts', 'utf8')).toContain(
      'env: devServerEnvironment(process.env, port)',
    );
  });
});
