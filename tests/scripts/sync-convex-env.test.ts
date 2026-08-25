import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/sync-convex-env.sh');

/**
 * Run the sync script against a fake `npx` that records every Convex CLI call.
 *
 * Args:
 *   deploymentEnv: Lines the fake `npx convex env list` returns.
 *   localEnv: Contents of the `.env.local` handed to the script.
 *
 * Returns:
 *   Exit status and the recorded CLI invocations.
 */
function runSync(
  deploymentEnv: string[],
  localEnv: string,
): { status: number | null; calls: string[] } {
  const directory = mkdtempSync(join(tmpdir(), 'day0-sync-env-'));
  const envFile = join(directory, '.env.local');
  const log = join(directory, 'calls.log');
  const state = join(directory, 'deployment.env');
  writeFileSync(envFile, localEnv, 'utf8');
  writeFileSync(state, deploymentEnv.join('\n'), 'utf8');
  const fakeNpx = join(directory, 'npx');
  writeFileSync(
    fakeNpx,
    [
      '#!/usr/bin/env bash',
      `echo "$*" >> "${log}"`,
      'if [ "$1 $2 $3" = "convex env list" ]; then cat "' + state + '"; exit 0; fi',
      'if [ "$1 $2 $3" = "convex env remove" ]; then',
      `  grep -v "^$4=" "${state}" > "${state}.next" || true; mv "${state}.next" "${state}"; exit 0`,
      'fi',
      'exit 0',
    ].join('\n'),
    'utf8',
  );
  chmodSync(fakeNpx, 0o755);
  const result = spawnSync('bash', [SCRIPT, envFile], {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}` },
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    calls = [];
  }
  return { status: result.status, calls };
}

describe('sync-convex-env.sh', (): void => {
  it('clears the retired credential names a deployment still carries', (): void => {
    const { status, calls } = runSync(
      [
        'DAY0_SECRET_REFS=NOTION_TOKEN,LINEAR_API_KEY',
        'NOTION_TOKEN=value',
        'LINEAR_API_KEY=value',
        'SLACK_BOT_TOKEN=value',
        'SLACK_MCP_API_KEY=value',
        'SLACK_MANAGER_DM_CHANNEL_ID=C0',
        'OPENAI_API_KEY=value',
      ],
      'OPENAI_API_KEY=value\nDAY0_SURFACE_MODE=mock\n',
    );
    expect(status).toBe(0);
    for (const name of [
      'DAY0_SECRET_REFS',
      'NOTION_TOKEN',
      'LINEAR_API_KEY',
      'SLACK_BOT_TOKEN',
      'SLACK_MCP_API_KEY',
      'SLACK_MANAGER_DM_CHANNEL_ID',
    ]) {
      expect(calls).toContain(`convex env remove ${name}`);
      expect(calls).not.toContain(`convex env set ${name} value`);
    }
    expect(calls).toContain('convex env set OPENAI_API_KEY value');
  });

  it('never pushes a credential name and clears the key when .env.local drops it', (): void => {
    const { status, calls } = runSync(
      ['DAY0_CREDENTIAL_KEY=old', 'DAY0_NOTION_MCP_AUTH_TOKEN=old'],
      'NOTION_TOKEN=local-value\nLINEAR_API_KEY=local-value\nDAY0_SURFACE_MODE=mock\n',
    );
    expect(status).toBe(0);
    expect(calls.some((call) => call.includes('local-value'))).toBe(false);
    expect(calls).toContain('convex env remove DAY0_CREDENTIAL_KEY');
    expect(calls).toContain('convex env remove DAY0_NOTION_MCP_AUTH_TOKEN');
  });

  it('refuses real mode without the generated credential key', (): void => {
    const { status, calls } = runSync([], 'DAY0_SURFACE_MODE=real\n');
    expect(status).toBe(1);
    expect(calls).toEqual([]);
  });
});
