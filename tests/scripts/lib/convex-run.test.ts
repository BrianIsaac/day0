import type { SpawnSyncReturns } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  convexEnvironment,
  convexRun,
  redactSecrets,
  type Spawn,
} from '../../../scripts/lib/convex-run';

function answering(stdout: string, status = 0, stderr = ''): Spawn {
  return (): SpawnSyncReturns<string> =>
    ({
      stdout,
      stderr,
      status,
      signal: null,
      output: [null, stdout, stderr],
      pid: 1,
    }) as SpawnSyncReturns<string>;
}

describe('redactSecrets', (): void => {
  it('hides the administrator key by value and by shape', (): void => {
    const env = { CONVEX_SELF_HOSTED_ADMIN_KEY: 'convex-self-hosted|abc123' };
    expect(redactSecrets('failed with convex-self-hosted|abc123 here', env)).toBe(
      'failed with <redacted> here',
    );
    expect(redactSecrets('a fresh convex-self-hosted|zzz key', {})).toBe('a fresh <redacted> key');
  });
});

describe('convexEnvironment', (): void => {
  it('generates the administrator key through the backend container when only the backend URL is set', (): void => {
    const calls: string[][] = [];
    const spawn: Spawn = (command, args) => {
      calls.push([command, ...args]);
      return answering('noise\nconvex-self-hosted|generated\n')(command, args, {
        encoding: 'utf8',
        env: process.env,
        timeout: 0,
      });
    };
    const environment = convexEnvironment(
      { CONVEX_SELF_HOSTED_URL: 'http://127.0.0.1:3210', COMPOSE_PROJECT_NAME: 'day0-x' },
      spawn,
    );
    expect(environment.CONVEX_SELF_HOSTED_ADMIN_KEY).toBe('convex-self-hosted|generated');
    expect(calls[0]!.slice(0, 4)).toEqual(['docker', 'compose', '-p', 'day0-x']);
  });

  it('keeps a key or a cloud deployment it already has, without calling docker', (): void => {
    const spawn: Spawn = () => {
      throw new Error('docker must not be called');
    };
    expect(
      convexEnvironment({ CONVEX_SELF_HOSTED_URL: 'u', CONVEX_SELF_HOSTED_ADMIN_KEY: 'k' }, spawn)
        .CONVEX_SELF_HOSTED_ADMIN_KEY,
    ).toBe('k');
    expect(convexEnvironment({ CONVEX_DEPLOYMENT: 'dev:x' }, spawn).CONVEX_DEPLOYMENT).toBe(
      'dev:x',
    );
  });

  it('says the backend could not be reached, with the key redacted from the detail', (): void => {
    expect(() =>
      convexEnvironment(
        { CONVEX_SELF_HOSTED_URL: 'u' },
        answering('', 1, 'refused convex-self-hosted|leak'),
      ),
    ).toThrow('Could not access the self-hosted Convex backend: refused <redacted>');
  });
});

describe('convexRun', (): void => {
  it('runs the named function through the CLI and decodes its JSON', (): void => {
    const calls: string[][] = [];
    const spawn: Spawn = (command, args) => {
      calls.push([command, ...args]);
      return answering('{"toolNames":["a"],"elapsedMs":3}')(command, args, {
        encoding: 'utf8',
        env: process.env,
        timeout: 0,
      });
    };
    expect(convexRun('probeActions:probeMcp', { docSourceId: 's' }, {}, spawn)).toEqual({
      toolNames: ['a'],
      elapsedMs: 3,
    });
    expect(calls[0]).toEqual([
      'npx',
      'convex',
      'run',
      '--typecheck',
      'disable',
      '--codegen',
      'disable',
      'probeActions:probeMcp',
      '{"docSourceId":"s"}',
    ]);
  });

  it('raises the CLI failure text with secrets redacted', (): void => {
    expect(() => convexRun('x:y', {}, {}, answering('', 1, 'boom convex-self-hosted|k'))).toThrow(
      'boom <redacted>',
    );
  });
});
