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
      '  const { HTTPS_PROXY, NO_PROXY, NODE_USE_ENV_PROXY, DAY0_SHELL_PROXY } = process.env;',
      "  const quiet = process.execArgv.filter((option) => option.startsWith('--disable-warning'));",
      '  console.log(JSON.stringify({ HTTPS_PROXY, NO_PROXY, NODE_USE_ENV_PROXY, DAY0_SHELL_PROXY, quiet, argv: process.argv.slice(2) }));',
      '  process.exitCode = 7;',
      '} else {',
      '  process.exitCode = restarted;',
      '}',
    ].join('\n'),
    'utf8',
  );
  return path;
}

/**
 * Run a command as `pnpm <script>` does, from a shell that names no proxy but what it is given.
 *
 * @param path - The command.
 * @param given - What the shell names besides.
 */
function run(
  path: string,
  given: Readonly<Record<string, string>> = {},
): { status: number | null; lines: string[] } {
  const shell: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(shell)) {
    if (/^(https?_proxy|no_proxy|all_proxy|node_use_env_proxy|node_options)$/i.test(name)) {
      delete shell[name];
    }
  }
  Object.assign(shell, given);
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
        quiet: ['--disable-warning=UNDICI-EHPA'],
        argv: ['slack', '--report'],
      },
    ]);
    expect(ran.status).toBe(7);
  });

  it('runs as it was started where the file names no proxy', (): void => {
    const ran = run(command({}));
    expect(ran.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { quiet: [], argv: ['slack', '--report'] },
    ]);
    expect(ran.status).toBe(7);
  });

  // D-9 (a): a proxy exported in the shell and not in the file reaches neither the command nor
  // its children; it runs once without it, marked so `check:setup` can say the shell named one.
  it('runs without a proxy the shell names and the file does not, once, marked', (): void => {
    const ran = run(command({}), {
      HTTPS_PROXY: 'http://corp-proxy.acme.test:8080',
      NODE_USE_ENV_PROXY: '1',
    });
    expect(ran.lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      { DAY0_SHELL_PROXY: 'HTTPS_PROXY', quiet: [], argv: ['slack', '--report'] },
    ]);
    expect(ran.status).toBe(7);
  });
});
