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
  storedCredentials = '',
): { status: number | null; calls: string[]; stderr: string } {
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
      `if [ "$1 $2 $3" = "convex data credentials" ]; then printf '%s' '${storedCredentials}'; exit 0; fi`,
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
  return { status: result.status, calls, stderr: result.stderr };
}

describe('sync-convex-env.sh', (): void => {
  it('sets model knobs and removes stale knobs when the local settings are cleared', (): void => {
    const configured = runSync([], 'OPENAI_MAX_OUTPUT_TOKENS=32768\nOPENAI_REASONING_EFFORT=low\n');
    expect(configured.status).toBe(0);
    expect(configured.calls).toContain('convex env set OPENAI_MAX_OUTPUT_TOKENS -- 32768');
    expect(configured.calls).toContain('convex env set OPENAI_REASONING_EFFORT -- low');
    const cleared = runSync(['OPENAI_MAX_OUTPUT_TOKENS=32768', 'OPENAI_REASONING_EFFORT=low'], '');
    expect(cleared.status).toBe(0);
    expect(cleared.calls).toContain('convex env remove OPENAI_MAX_OUTPUT_TOKENS');
    expect(cleared.calls).toContain('convex env remove OPENAI_REASONING_EFFORT');
  });

  it('clears the retired credential names a deployment still carries', (): void => {
    const { status, calls } = runSync(
      [
        'DAY0_SECRET_REFS=NOTION_TOKEN,LINEAR_API_KEY',
        'NOTION_TOKEN=value',
        'LINEAR_API_KEY=value',
        'SLACK_BOT_TOKEN=value',
        'SLACK_MCP_API_KEY=value',
        'SLACK_MANAGER_DM_CHANNEL_ID=C0',
        'OPENAI_API_KEY=stale',
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
    expect(calls).toContain('convex env set OPENAI_API_KEY -- value');
  });

  it('keeps a value the deployment already holds and sets only what differs', (): void => {
    const { status, calls } = runSync(
      ['OPENAI_API_KEY=same', 'OPENAI_MODEL=qwen3:8b', 'NEXT_PUBLIC_DEV_NO_AUTH=true', 'DEV_NO_AUTH_JWKS=data:text/plain;base64,abc'],
      [
        'OPENAI_API_KEY=same',
        'OPENAI_MODEL=qwen3:4b',
        'NEXT_PUBLIC_DEV_NO_AUTH=true',
        'DEV_NO_AUTH_JWKS=data:text/plain;base64,abc',
        'DAY0_SURFACE_MODE=mock',
        '',
      ].join('\n'),
    );
    expect(status).toBe(0);
    expect(calls).not.toContain('convex env set OPENAI_API_KEY -- same');
    expect(calls).not.toContain('convex env set NEXT_PUBLIC_DEV_NO_AUTH -- true');
    expect(calls).not.toContain('convex env set DEV_NO_AUTH_JWKS -- data:text/plain;base64,abc');
    expect(calls).toContain('convex env set OPENAI_MODEL -- qwen3:4b');
    expect(calls).toContain('convex env set DAY0_SURFACE_MODE -- mock');
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

  it('allows real mode without the optional Notion component token', (): void => {
    const { status, calls } = runSync(
      ['DAY0_NOTION_MCP_AUTH_TOKEN=old'],
      'DAY0_SURFACE_MODE=real\nDAY0_CREDENTIAL_KEY=credential-key\nDAY0_NOTION_MCP_AUTH_TOKEN=\n',
    );
    expect(status).toBe(0);
    expect(calls).toContain('convex env set DAY0_CREDENTIAL_KEY -- credential-key');
    expect(calls).toContain('convex env remove DAY0_NOTION_MCP_AUTH_TOKEN');
  });

  it('refuses to clear or replace the credential key while the deployment stores credentials', (): void => {
    const stored = '{"_id":"c1","label":"linear service token"}';
    const cleared = runSync(['DAY0_CREDENTIAL_KEY=held'], 'DAY0_SURFACE_MODE=mock\n', stored);
    expect(cleared.status).toBe(1);
    expect(cleared.stderr).toContain('Clearing it would leave every one unreadable');
    expect(cleared.calls).not.toContain('convex env remove DAY0_CREDENTIAL_KEY');

    const replaced = runSync(
      ['DAY0_CREDENTIAL_KEY=held'],
      'DAY0_SURFACE_MODE=real\nDAY0_CREDENTIAL_KEY=minted-here\n',
      stored,
    );
    expect(replaced.status).toBe(1);
    expect(replaced.stderr).toContain('scripts/rotate-credential-key.ts');
    expect(replaced.calls.some((call) => call.startsWith('convex env set DAY0_CREDENTIAL_KEY'))).toBe(
      false,
    );

    // The same key, or no credential stored yet, goes through as before.
    const same = runSync(
      ['DAY0_CREDENTIAL_KEY=held'],
      'DAY0_SURFACE_MODE=real\nDAY0_CREDENTIAL_KEY=held\n',
      stored,
    );
    expect(same.status).toBe(0);
    const empty = runSync(['DAY0_CREDENTIAL_KEY=held'], 'DAY0_SURFACE_MODE=real\nDAY0_CREDENTIAL_KEY=new\n');
    expect(empty.status).toBe(0);
    expect(empty.calls).toContain('convex env set DAY0_CREDENTIAL_KEY -- new');
  });

  it('sets a value that begins with a dash as a value, and aliases without associative arrays', (): void => {
    expect(readFileSync(SCRIPT, 'utf8')).not.toMatch(/declare -A/);
    const { status, calls } = runSync(
      [],
      'DAY0_NOTION_MCP_AUTH_TOKEN=-leading-dash\nOPENAI_BASE_URL=http://127.0.0.1:11434/v1\nCONVEX_OPENAI_BASE_URL=http://model:11434/v1\n',
    );
    expect(status).toBe(0);
    expect(calls).toContain('convex env set DAY0_NOTION_MCP_AUTH_TOKEN -- -leading-dash');
    expect(calls).toContain('convex env set OPENAI_BASE_URL -- http://model:11434/v1');
  });
});
