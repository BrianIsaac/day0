import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/dev-docs-dir.ts');
const TSX = resolve('node_modules/.bin/tsx');
const created: string[] = [];

afterEach((): void => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Run the script in a clean clone's place, with only the given setting in the shell and `.env.local`. */
function run(
  env: Record<string, string> = {},
  envFile?: string,
): { cwd: string; status: number | null; output: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'dev-docs-dir-'));
  created.push(cwd);
  if (envFile !== undefined) writeFileSync(join(cwd, '.env.local'), envFile);
  const result = spawnSync(TSX, [SCRIPT], {
    cwd,
    encoding: 'utf8',
    env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', ...env },
    timeout: 60_000,
  });
  return { cwd, status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('pnpm convex:up, before compose', (): void => {
  it('creates the default documentation directory a clean clone lacks, and says so', (): void => {
    const { cwd, status, output } = run();
    expect(status).toBe(0);
    expect(existsSync(join(cwd, 'docs-local'))).toBe(true);
    expect(output).toContain('Created an empty documentation directory');
  });

  it('refuses a configured directory that does not exist rather than create it', (): void => {
    const { status, output } = run({ DAY0_DOCS_HOST_DIR: 'no-such-folder' });
    expect(status).toBe(1);
    expect(output).toContain('error: DAY0_DOCS_HOST_DIR=no-such-folder does not exist.');
  });

  it('reads the setting from .env.local when the shell does not set it', (): void => {
    const { status, output } = run({}, 'DAY0_DOCS_HOST_DIR="missing-docs"\n');
    expect(status).toBe(1);
    expect(output).toContain('DAY0_DOCS_HOST_DIR=missing-docs does not exist.');
  });
});
