import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/*
 * The setup's own process and the way out (wave 18, 18-P; D-9 (a)). The setup hands its children
 * the proxy `.env.local` names, and makes requests of its own too (an MCP server's discovery in
 * `./setup.sh access`), so it starts itself again under that proxy as the three checks do, and
 * never under one the shell names. A preload records each Node process the entry runs as.
 */

const ROOT = resolve(__dirname, '../..');
const TSX = join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const directory = mkdtempSync(join(tmpdir(), 'day0-setup-entry-'));
const seen = join(directory, 'seen.jsonl');
const preload = join(directory, 'record.mjs');
writeFileSync(
  preload,
  [
    "import { appendFileSync } from 'node:fs';",
    'const { HTTPS_PROXY, NODE_USE_ENV_PROXY, DAY0_SHELL_PROXY } = process.env;',
    `appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ HTTPS_PROXY, NODE_USE_ENV_PROXY, DAY0_SHELL_PROXY, quiet: process.execArgv.includes('--disable-warning=UNDICI-EHPA') }) + '\\n');`,
  ].join('\n'),
  'utf8',
);

/**
 * Run the setup's entry as `pnpm setup:local --help` does, in a checkout whose `.env.local` is
 * given, from a shell that names what it is given.
 *
 * @param envText - The checkout's `.env.local`.
 * @param shell - What the shell names besides `PATH` and `HOME`.
 */
function entry(
  envText: string,
  shell: Readonly<Record<string, string>> = {},
): { status: number | null; processes: unknown[] } {
  writeFileSync(join(directory, '.env.local'), envText, 'utf8');
  rmSync(seen, { force: true });
  const ran = spawnSync(process.execPath, [TSX, join(ROOT, 'scripts/setup.ts'), '--help'], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      NODE_ENV: 'test',
      NODE_OPTIONS: `--import=${preload}`,
      ...shell,
    },
    timeout: 60_000,
  });
  let lines: string[] = [];
  try {
    lines = readFileSync(seen, 'utf8').trim().split('\n');
  } catch {
    lines = [];
  }
  // tsx's own launcher is a Node process too; the setup's are the ones that loaded its loader.
  return { status: ran.status, processes: lines.map((line) => JSON.parse(line) as unknown) };
}

describe("the setup's own process and the proxy .env.local names (D-9 (a))", (): void => {
  afterAll((): void => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('starts itself again under the file’s proxy, the warning quieted', (): void => {
    const ran = entry('HTTPS_PROXY=http://proxy.acme.test:3128\n');
    expect(ran.status).toBe(0);
    expect(ran.processes.at(-1)).toEqual({
      HTTPS_PROXY: 'http://proxy.acme.test:3128',
      NODE_USE_ENV_PROXY: '1',
      quiet: true,
    });
  });

  it('starts itself again without a proxy the shell names and the file does not, marked', (): void => {
    const ran = entry('', {
      HTTPS_PROXY: 'http://corp-proxy.acme.test:8080',
      NODE_USE_ENV_PROXY: '1',
    });
    expect(ran.status).toBe(0);
    expect(ran.processes.at(-1)).toEqual({ DAY0_SHELL_PROXY: 'HTTPS_PROXY', quiet: false });
  });

  it('runs as it was started where neither names one', (): void => {
    const ran = entry('');
    expect(ran.status).toBe(0);
    expect(ran.processes.at(-1)).toEqual({ quiet: false });
  });
});
