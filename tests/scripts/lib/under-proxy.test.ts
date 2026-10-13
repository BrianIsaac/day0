import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');
const directory = mkdtempSync(join(tmpdir(), 'day0-under-proxy-'));

/**
 * A command that restarts itself under the proxy its file names, then says what it ran with.
 *
 * @param file - The env file's values, as the command reads them.
 */
function command(file: Readonly<Record<string, string>>): string {
  const path = join(directory, `command-${Object.keys(file).length}.mts`);
  writeFileSync(
    path,
    [
      `import { runUnderProxy } from ${JSON.stringify(join(ROOT, 'scripts/lib/under-proxy.ts'))};`,
      `const restarted = runUnderProxy(${JSON.stringify(file)});`,
      'if (restarted === undefined) {',
      '  const { HTTPS_PROXY, NO_PROXY, NODE_USE_ENV_PROXY } = process.env;',
      '  console.log(JSON.stringify({ HTTPS_PROXY, NO_PROXY, NODE_USE_ENV_PROXY, argv: process.argv.slice(2) }));',
      '  process.exitCode = 7;',
      '} else {',
      '  process.exitCode = restarted;',
      '}',
    ].join('\n'),
    'utf8',
  );
  return path;
}

/** Run a command as `pnpm <script>` does, from a shell that names no proxy. */
function run(path: string): { status: number | null; lines: string[] } {
  const shell = { ...process.env };
  for (const name of Object.keys(shell)) {
    if (/^(https?_proxy|no_proxy|node_use_env_proxy)$/i.test(name)) delete shell[name];
  }
  const result = spawnSync(TSX, [path, 'slack', '--report'], {
    encoding: 'utf8',
    env: shell,
    timeout: 60_000,
  });
  return {
    status: result.status,
    lines: result.stdout.split('\n').filter((line) => line.startsWith('{')),
  };
}

describe('a command restarting itself under the proxy its file names (wave 17, 17-P)', (): void => {
  afterAll((): void => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('runs once, with the proxy, this machine kept out of it, its own arguments and its own exit status', (): void => {
    const ran = run(
      command({ HTTPS_PROXY: 'http://proxy.acme.test:3128', NO_PROXY: 'day0.acme.test' }),
    );
    expect(ran.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        HTTPS_PROXY: 'http://proxy.acme.test:3128',
        NO_PROXY: 'localhost,127.0.0.1,day0.acme.test',
        NODE_USE_ENV_PROXY: '1',
        argv: ['slack', '--report'],
      },
    ]);
    expect(ran.status).toBe(7);
  });

  it('runs as it was started where the file names no proxy', (): void => {
    const ran = run(command({}));
    expect(ran.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { argv: ['slack', '--report'] },
    ]);
    expect(ran.status).toBe(7);
  });
});
