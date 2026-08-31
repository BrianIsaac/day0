import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/dev-no-auth-key.ts');
const TSX = resolve('node_modules/.bin/tsx');

/**
 * Run the key script the way `pnpm dev` does, from a directory of choice.
 *
 * Args:
 *   cwd: Working directory holding, or lacking, `.env.local`.
 *
 * Returns:
 *   Exit status and combined output.
 */
function runUrlMode(cwd: string): { status: number | null; output: string } {
  const result = spawnSync(TSX, [SCRIPT, 'url'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, DAY0_CREDENTIAL_KEY: '', DAY0_NOTION_MCP_AUTH_TOKEN: '' },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('dev-no-auth-key url mode', (): void => {
  it('starts pnpm dev without .env.local instead of failing on key generation', (): void => {
    const cwd = mkdtempSync(join(tmpdir(), 'day0-dev-key-'));
    const { status, output } = runUrlMode(cwd);
    expect(status).toBe(0);
    expect(output).not.toContain('not found');
  });

  it('generates the credential key and transport token once, without printing them', (): void => {
    const cwd = mkdtempSync(join(tmpdir(), 'day0-dev-key-'));
    const envFile = join(cwd, '.env.local');
    writeFileSync(envFile, 'NEXT_PUBLIC_DEV_NO_AUTH=false\n', 'utf8');
    const first = runUrlMode(cwd);
    expect(first.status).toBe(0);
    const written = readFileSync(envFile, 'utf8');
    const key = /^DAY0_CREDENTIAL_KEY=(.+)$/m.exec(written)?.[1];
    const token = /^DAY0_NOTION_MCP_AUTH_TOKEN=(.+)$/m.exec(written)?.[1];
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.output).not.toContain(key);
    expect(first.output).not.toContain(token);
    const second = runUrlMode(cwd);
    expect(second.status).toBe(0);
    expect(readFileSync(envFile, 'utf8')).toBe(written);
  });
});
