import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasHostTool } from '../setup/host-tools';
import { temporaryDirectories } from '../setup/temporary-directories';

const temporary = temporaryDirectories();

/** The repository root, found from this file rather than the working directory. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const SCRIPT = join(ROOT, 'scripts/sync-convex-env.sh');

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
  pushed = false,
): {
  status: number | null;
  calls: string[];
  stdout: string;
  stderr: string;
  deployment: string[];
} {
  const directory = temporary('day0-sync-env-');
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
      // A deployment with functions on it validates its auth config on every
      // env change and refuses one that would leave it invalid.
      'valid() {',
      '  local file="$1" flag jwks issuer audience clerk',
      '  flag=$(grep "^NEXT_PUBLIC_DEV_NO_AUTH=" "$file" | cut -d= -f2-)',
      '  jwks=$(grep "^DEV_NO_AUTH_JWKS=" "$file" | cut -d= -f2-)',
      '  issuer=$(grep "^DAY0_OIDC_ISSUER=" "$file" | cut -d= -f2-)',
      '  audience=$(grep "^DAY0_OIDC_AUDIENCE=" "$file" | cut -d= -f2-)',
      '  clerk=$(grep "^CLERK_JWT_ISSUER_DOMAIN=" "$file" | cut -d= -f2-)',
      '  if [ "$flag" = true ] && [ -z "$jwks" ]; then return 1; fi',
      '  if [ -n "$issuer" ] && [ -z "$audience" ]; then return 1; fi',
      '  [ "$flag" = true ] || [ -n "$issuer" ] || [ -n "$clerk" ]',
      '}',
      'if [ "$1 $2" = "convex env" ] && { [ "$3" = remove ] || [ "$3" = set ]; }; then',
      `  grep -v "^$4=" "${state}" > "${state}.next" || true`,
      `  if [ "$3" = set ]; then echo "$4=$6" >> "${state}.next"; fi`,
      `  if [ "${pushed}" = true ] && ! valid "${state}.next"; then`,
      '    echo "InvalidAuthConfig: this change would leave the auth config invalid" >&2; exit 1',
      '  fi',
      `  mv "${state}.next" "${state}"; exit 0`,
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
  const deployment = readFileSync(state, 'utf8').split('\n').filter(Boolean).sort();
  return { status: result.status, calls, stdout: result.stdout, stderr: result.stderr, deployment };
}

describe.skipIf(!hasHostTool('bash'))('sync-convex-env.sh (needs bash)', (): void => {
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

  it('names the deployment an evaluation bed from .env.local, and stops naming it once the file drops the flag', (): void => {
    const bed = runSync([], 'DAY0_EVALUATION_BED=comparison\n');
    expect(bed.status).toBe(0);
    expect(bed.calls).toContain('convex env set DAY0_EVALUATION_BED -- comparison');
    const leaving = runSync(['DAY0_EVALUATION_BED=comparison'], 'DAY0_SURFACE_MODE=mock\n');
    expect(leaving.status).toBe(0);
    expect(leaving.calls).toContain('convex env remove DAY0_EVALUATION_BED');
    expect(leaving.deployment).not.toContain('DAY0_EVALUATION_BED=comparison');
  });

  it("puts the customer issuer's trust flag on the deployment, and removes a stale one once the file drops it (D3)", (): void => {
    const trusted = runSync([], 'DAY0_OIDC_EMAIL_TRUSTED=true\n');
    expect(trusted.calls).toContain('convex env set DAY0_OIDC_EMAIL_TRUSTED -- true');
    const dropped = runSync(['DAY0_OIDC_EMAIL_TRUSTED=true'], 'DAY0_SURFACE_MODE=mock\n');
    expect(dropped.calls).toContain('convex env remove DAY0_OIDC_EMAIL_TRUSTED');
    expect(dropped.deployment).not.toContain('DAY0_OIDC_EMAIL_TRUSTED=true');
  });

  it('puts the shared-skills off switch on the deployment, and removes it once the file drops it, which turns sharing back on (K4)', (): void => {
    const off = runSync([], 'DAY0_SHARED_SKILLS=false\n');
    expect(off.status).toBe(0);
    expect(off.calls).toContain('convex env set DAY0_SHARED_SKILLS -- false');
    const dropped = runSync(['DAY0_SHARED_SKILLS=false'], 'DAY0_SURFACE_MODE=mock\n');
    expect(dropped.calls).toContain('convex env remove DAY0_SHARED_SKILLS');
    expect(dropped.deployment).not.toContain('DAY0_SHARED_SKILLS=false');
  });

  it('puts the allowed domains on the deployment with the issuer and clears a stale list, never the two secrets or the browser copy', (): void => {
    const local = [
      'DAY0_PROFILE=customer-local',
      'NEXT_PUBLIC_DAY0_PROFILE=customer-local',
      'DAY0_OIDC_AUDIENCE=day0',
      'DAY0_OIDC_ISSUER=https://sso.example.com/realms/ops',
      'DAY0_OIDC_ALLOWED_DOMAINS=acme.test,acme.co.uk',
      'DAY0_OIDC_CLIENT_SECRET=day0-test-client-secret',
      `DAY0_SESSION_SECRET=${'s'.repeat(43)}`,
      '',
    ].join('\n');
    const pushed = runSync([], local);
    expect(pushed.status).toBe(0);
    expect(pushed.calls).toContain(
      'convex env set DAY0_OIDC_ALLOWED_DOMAINS -- acme.test,acme.co.uk',
    );
    expect(
      pushed.calls.findIndex((call) =>
        call.startsWith('convex env set DAY0_OIDC_ALLOWED_DOMAINS '),
      ),
    ).toBeLessThan(
      pushed.calls.findIndex((call) => call.startsWith('convex env set DAY0_OIDC_ISSUER ')),
    );
    for (const secret of [
      'DAY0_OIDC_CLIENT_SECRET',
      'DAY0_SESSION_SECRET',
      'NEXT_PUBLIC_DAY0_PROFILE',
    ]) {
      expect(pushed.calls.join('\n'), secret).not.toContain(secret);
    }

    const dropped = runSync(
      [
        'DAY0_OIDC_ALLOWED_DOMAINS=acme.test',
        'DAY0_OIDC_ISSUER=https://sso.example.com/realms/ops',
      ],
      'DAY0_SURFACE_MODE=mock\n',
    );
    expect(dropped.calls).toContain('convex env remove DAY0_OIDC_ALLOWED_DOMAINS');
    expect(dropped.deployment).not.toContain('DAY0_OIDC_ALLOWED_DOMAINS=acme.test');
  });

  it('puts the administrators on the deployment before the issuer and clears a list dropped from the file (B8)', (): void => {
    const local = [
      'DAY0_PROFILE=customer-local',
      'DAY0_OIDC_AUDIENCE=day0',
      'DAY0_OIDC_ISSUER=https://sso.example.com/realms/ops',
      'DAY0_OIDC_ALLOWED_DOMAINS=acme.test',
      'DAY0_ADMINISTRATORS=ines@acme.test,ops@acme.test',
      '',
    ].join('\n');
    const pushed = runSync([], local);
    expect(pushed.status).toBe(0);
    expect(pushed.calls).toContain(
      'convex env set DAY0_ADMINISTRATORS -- ines@acme.test,ops@acme.test',
    );
    expect(
      pushed.calls.findIndex((call) => call.startsWith('convex env set DAY0_ADMINISTRATORS ')),
    ).toBeLessThan(
      pushed.calls.findIndex((call) => call.startsWith('convex env set DAY0_OIDC_ISSUER ')),
    );

    const localDev = runSync([], 'DAY0_ADMINISTRATORS=boss@day0.local\n');
    expect(localDev.calls).toContain('convex env set DAY0_ADMINISTRATORS -- boss@day0.local');

    const dropped = runSync(['DAY0_ADMINISTRATORS=ines@acme.test'], 'DAY0_SURFACE_MODE=mock\n');
    expect(dropped.calls).toContain('convex env remove DAY0_ADMINISTRATORS');
    expect(dropped.deployment).not.toContain('DAY0_ADMINISTRATORS=ines@acme.test');
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

  it('removes a name the release stopped reading when the deployment holds it, and says a missing one is absent', (): void => {
    const { status, calls, stdout, deployment } = runSync(
      ['EXA_API_KEY=exa-stale', 'OPENAI_API_KEY=same'],
      'OPENAI_API_KEY=same\nEXA_API_KEY=exa-local\nOPENAI_IMAGE_MODEL=gpt-image-1\nDAY0_SURFACE_MODE=mock\n',
    );
    expect(status).toBe(0);
    expect(calls).toContain('convex env remove EXA_API_KEY');
    expect(deployment).not.toContain('EXA_API_KEY=exa-stale');
    expect(stdout).toContain('clear EXA_API_KEY (no longer read by the deployment)');
    expect(calls).not.toContain('convex env remove OPENAI_IMAGE_MODEL');
    expect(stdout).toContain('clear OPENAI_IMAGE_MODEL (already absent)');
    expect(calls.some((call) => call.includes('exa-local') || call.includes('gpt-image-1'))).toBe(
      false,
    );
  });

  it('keeps a value the deployment already holds and sets only what differs', (): void => {
    const { status, calls } = runSync(
      [
        'OPENAI_API_KEY=same',
        'OPENAI_MODEL=qwen3:8b',
        'NEXT_PUBLIC_DEV_NO_AUTH=true',
        'DEV_NO_AUTH_JWKS=data:text/plain;base64,abc',
      ],
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

  it("puts the token store's Nango address and key on the deployment, never the keys only Nango holds, and clears both once the file drops them (11-AT)", (): void => {
    const configured = runSync(
      [],
      [
        'DAY0_NANGO_URL=http://nango-server:3003',
        'DAY0_NANGO_SECRET_KEY=3f1c2a9e-5b7d-4c8a-9e21-0a6b4d2c8f17',
        'DAY0_NANGO_ENCRYPTION_KEY=nango-encryption-only',
        'DAY0_NANGO_DB_PASSWORD=nango-database-only',
        '',
      ].join('\n'),
    );
    expect(configured.status).toBe(0);
    expect(configured.calls).toContain('convex env set DAY0_NANGO_URL -- http://nango-server:3003');
    expect(configured.calls).toContain(
      'convex env set DAY0_NANGO_SECRET_KEY -- 3f1c2a9e-5b7d-4c8a-9e21-0a6b4d2c8f17',
    );
    expect(configured.calls.some((call) => call.includes('-only'))).toBe(false);
    const dropped = runSync(
      ['DAY0_NANGO_URL=http://nango-server:3003', 'DAY0_NANGO_SECRET_KEY=old'],
      'DAY0_SURFACE_MODE=mock\n',
    );
    expect(dropped.calls).toContain('convex env remove DAY0_NANGO_URL');
    expect(dropped.calls).toContain('convex env remove DAY0_NANGO_SECRET_KEY');
  });

  it('puts the git hosts list on the deployment, and clears it once the file drops it (14-F)', (): void => {
    const listed = runSync([], 'DAY0_SURFACE_MODE=mock\nDAY0_GIT_HOSTS=gitee.com\n');
    expect(listed.status).toBe(0);
    expect(listed.calls).toContain('convex env set DAY0_GIT_HOSTS -- gitee.com');
    const dropped = runSync(['DAY0_GIT_HOSTS=gitee.com'], 'DAY0_SURFACE_MODE=mock\n');
    expect(dropped.calls).toContain('convex env remove DAY0_GIT_HOSTS');
    expect(dropped.deployment).not.toContain('DAY0_GIT_HOSTS=gitee.com');
  });

  it('puts the Slack socket bridge secret on the deployment, and clears it once the file drops it (12-M)', (): void => {
    const configured = runSync(
      [],
      'DAY0_SURFACE_MODE=mock\nDAY0_SOCKET_BRIDGE_SECRET=bridge-secret-for-tests\n',
    );
    expect(configured.status).toBe(0);
    expect(configured.calls).toContain(
      'convex env set DAY0_SOCKET_BRIDGE_SECRET -- bridge-secret-for-tests',
    );
    const dropped = runSync(['DAY0_SOCKET_BRIDGE_SECRET=old'], 'DAY0_SURFACE_MODE=mock\n');
    expect(dropped.calls).toContain('convex env remove DAY0_SOCKET_BRIDGE_SECRET');
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
    const cleared = runSync(
      ['DAY0_CREDENTIAL_KEY=held', 'NOTION_TOKEN=retired'],
      'DAY0_SURFACE_MODE=mock\n',
      stored,
    );
    expect(cleared.status).toBe(1);
    expect(cleared.stderr).toContain('Clearing it would leave every one unreadable');
    // Refused before any change, the retired name included.
    expect(cleared.calls.filter((call) => /^convex env (set|remove)/.test(call))).toEqual([]);

    const replaced = runSync(
      ['DAY0_CREDENTIAL_KEY=held'],
      'DAY0_SURFACE_MODE=real\nDAY0_CREDENTIAL_KEY=minted-here\n',
      stored,
    );
    expect(replaced.status).toBe(1);
    expect(replaced.stderr).toContain('scripts/rotate-credential-key.ts');
    expect(
      replaced.calls.some((call) => call.startsWith('convex env set DAY0_CREDENTIAL_KEY')),
    ).toBe(false);

    // The same key, or no credential stored yet, goes through as before.
    const same = runSync(
      ['DAY0_CREDENTIAL_KEY=held'],
      'DAY0_SURFACE_MODE=real\nDAY0_CREDENTIAL_KEY=held\n',
      stored,
    );
    expect(same.status).toBe(0);
    const empty = runSync(
      ['DAY0_CREDENTIAL_KEY=held'],
      'DAY0_SURFACE_MODE=real\nDAY0_CREDENTIAL_KEY=new\n',
    );
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

  describe('the customer issuer and the private hosts', (): void => {
    const LOCAL_KEY = [
      'NEXT_PUBLIC_DEV_NO_AUTH=true',
      'DEV_NO_AUTH_JWKS=data:text/plain;base64,abc',
    ];
    const CUSTOMER = [
      'DAY0_PROFILE=customer-local',
      'DAY0_OIDC_AUDIENCE=day0',
      'DAY0_OIDC_ISSUER=https://sso.example.com/realms/ops',
    ];
    const setOrder = (calls: readonly string[], key: string): number =>
      calls.findIndex((call) => call.startsWith(`convex env set ${key} `));

    it('puts the profile and the audience on the deployment before the issuer that needs them', (): void => {
      const { status, calls, deployment } = runSync(
        LOCAL_KEY,
        [...LOCAL_KEY, ...CUSTOMER, 'DAY0_PRIVATE_HOSTS=.corp.internal', ''].join('\n'),
        '',
        true,
      );
      expect(status).toBe(0);
      expect(setOrder(calls, 'DAY0_PROFILE')).toBeLessThan(setOrder(calls, 'DAY0_OIDC_ISSUER'));
      expect(setOrder(calls, 'DAY0_OIDC_AUDIENCE')).toBeLessThan(
        setOrder(calls, 'DAY0_OIDC_ISSUER'),
      );
      expect(deployment).toEqual(
        expect.arrayContaining([...LOCAL_KEY, ...CUSTOMER, 'DAY0_PRIVATE_HOSTS=.corp.internal']),
      );
    });

    it('switches from the local key to the issuer without passing through a deployment with neither', (): void => {
      const { status, deployment, stderr } = runSync(
        LOCAL_KEY,
        [...CUSTOMER, ''].join('\n'),
        '',
        true,
      );
      expect(stderr).not.toContain('InvalidAuthConfig');
      expect(status).toBe(0);
      expect(
        deployment.filter((line) => /^(NEXT_PUBLIC_DEV_NO_AUTH|DEV_NO_AUTH_JWKS|DAY0_)/.test(line)),
      ).toEqual([...CUSTOMER].sort());
    });

    it('puts Clerk on before it takes the local key off, so a move to Clerk never leaves no way in', (): void => {
      const { status, stderr, deployment } = runSync(
        LOCAL_KEY,
        'CLERK_JWT_ISSUER_DOMAIN=https://demo.clerk.accounts.dev\n',
        '',
        true,
      );
      expect(stderr).not.toContain('InvalidAuthConfig');
      expect(status).toBe(0);
      expect(deployment).toContain('CLERK_JWT_ISSUER_DOMAIN=https://demo.clerk.accounts.dev');
      expect(deployment.some((line) => line.startsWith('NEXT_PUBLIC_DEV_NO_AUTH='))).toBe(false);
    });

    it('refuses an issuer with no audience before it changes anything', (): void => {
      const { status, calls, stderr } = runSync(
        LOCAL_KEY,
        [...LOCAL_KEY, 'DAY0_OIDC_ISSUER=https://sso.example.com', ''].join('\n'),
        '',
        true,
      );
      expect(status).toBe(1);
      expect(stderr).toContain('DAY0_OIDC_AUDIENCE is empty');
      expect(calls.filter((call) => /^convex env (set|remove)/.test(call))).toEqual([]);
    });

    it('removes the issuer before the audience, and the profile and private hosts with it', (): void => {
      const { status, calls, deployment } = runSync(
        [...LOCAL_KEY, ...CUSTOMER, 'DAY0_PRIVATE_HOSTS=.corp.internal'],
        [...LOCAL_KEY, ''].join('\n'),
        '',
        true,
      );
      expect(status).toBe(0);
      expect(calls.indexOf('convex env remove DAY0_OIDC_ISSUER')).toBeLessThan(
        calls.indexOf('convex env remove DAY0_OIDC_AUDIENCE'),
      );
      expect(calls).toContain('convex env remove DAY0_PROFILE');
      expect(calls).toContain('convex env remove DAY0_PRIVATE_HOSTS');
      expect(deployment).toEqual([...LOCAL_KEY].sort());
    });
  });
});
