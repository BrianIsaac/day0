import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSetupArguments, readEnvValues, runCommand } from '../../scripts/setup';
import { harness } from './setup-harness';

/** An installation the setup already made, its project and backend named. */
const INSTALLED = [
  'COMPOSE_PROJECT_NAME=day0-w10s',
  'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3550',
  'CONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|admin',
  'NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3550',
  'NEXT_PUBLIC_CONVEX_SITE_URL=http://127.0.0.1:3551',
  'DAY0_SURFACE_MODE=real',
  '',
].join('\n');

const TENANT = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const ENTRA_ARGUMENTS = [
  '--mode',
  'real',
  'sign-in',
  '--provider',
  'entra',
  '--tenant',
  TENANT,
  '--client-id',
  'day0-app',
  '--allowed-domains',
  'acme.test',
  '--public-url',
  'https://day0.acme.test',
];

/** The commands a run made, each as one line. */
function lines(commands: ReadonlyArray<{ command: string; args: string[] }>): string[] {
  return commands.map((call) => [call.command, ...call.args].join(' '));
}

describe('setup: the sign-in verb', (): void => {
  it("the sign-in verb runs alone and exits with the check's code", async (): Promise<void> => {
    for (const checkStatus of [0, 1]) {
      const bed = harness({
        envLocal: INSTALLED,
        environment: { DAY0_OIDC_CLIENT_SECRET: 'day0-test-client-secret' },
        failing: checkStatus === 0 ? [] : [{ match: 'run check:setup', status: 1, stderr: 'gap' }],
      });
      const status = await runCommand(parseSetupArguments(ENTRA_ARGUMENTS), bed.io);
      expect(status, `check exited ${checkStatus}`).toBe(checkStatus);
      const ran = lines(bed.commands);
      const order = [
        'run sync:env',
        'convex dev --once',
        'run convex:restart',
        'run check:setup',
      ].map((step) => ran.findIndex((line) => line.includes(step)));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(ran.some((line) => /run convex:up|model:up|redactor:up|sandbox:up/.test(line))).toBe(
        false,
      );
    }
  });

  it('writes the customer-local block, the audience as the client id, and a fresh session secret', async (): Promise<void> => {
    const bed = harness({
      envLocal: INSTALLED,
      environment: { DAY0_OIDC_CLIENT_SECRET: 'day0-test-client-secret' },
    });
    await runCommand(parseSetupArguments(ENTRA_ARGUMENTS), bed.io);
    const values = readEnvValues(join(bed.directory, '.env.local'));
    expect(values).toMatchObject({
      DAY0_PROFILE: 'customer-local',
      NEXT_PUBLIC_DAY0_PROFILE: 'customer-local',
      DAY0_OIDC_ISSUER: `https://login.microsoftonline.com/${TENANT}/v2.0`,
      DAY0_OIDC_AUDIENCE: 'day0-app',
      DAY0_OIDC_CLIENT_SECRET: 'day0-test-client-secret',
      DAY0_OIDC_ALLOWED_DOMAINS: 'acme.test',
      DAY0_PUBLIC_URL: 'https://day0.acme.test',
    });
    expect(values.DAY0_SESSION_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bed.output.join('\n')).not.toContain('day0-test-client-secret');
    expect(bed.output.join('\n')).not.toContain(values.DAY0_SESSION_SECRET);
    expect(bed.output.join('\n')).toContain('https://day0.acme.test/api/auth/oidc/callback');
    expect(bed.output).toContain('Register these with Microsoft Entra ID (its guide says where):');
  });

  it('turns the local key off, since the build signs in through the issuer and next build refuses the key', async (): Promise<void> => {
    const bed = harness({
      envLocal: `${INSTALLED}NEXT_PUBLIC_DEV_NO_AUTH=true\nDEV_NO_AUTH_SECRET=generated-secret\n`,
      environment: { DAY0_OIDC_CLIENT_SECRET: 'day0-test-client-secret' },
    });
    await runCommand(parseSetupArguments(ENTRA_ARGUMENTS), bed.io);
    expect(readEnvValues(join(bed.directory, '.env.local')).NEXT_PUBLIC_DEV_NO_AUTH).toBe('');
    expect(bed.output.join('\n')).toContain('NEXT_PUBLIC_DEV_NO_AUTH=');
  });

  it('keeps a session secret already set, so nobody is signed out by a second run', async (): Promise<void> => {
    const kept = 'k'.repeat(43);
    const bed = harness({
      envLocal: `${INSTALLED}DAY0_SESSION_SECRET=${kept}\nDAY0_OIDC_CLIENT_SECRET=day0-test-client-secret\n`,
    });
    await runCommand(parseSetupArguments(ENTRA_ARGUMENTS), bed.io);
    expect(readEnvValues(join(bed.directory, '.env.local')).DAY0_SESSION_SECRET).toBe(kept);
  });

  it('asks for what no flag names, the client secret hidden', async (): Promise<void> => {
    const bed = harness({
      envLocal: INSTALLED,
      interactive: true,
      answers: [
        '2',
        'acme.okta.com',
        'default',
        'day0-app',
        'day0-test-client-secret',
        'acme.test',
        'https://day0.acme.test',
      ],
    });
    const status = await runCommand(parseSetupArguments(['--mode', 'real', 'sign-in']), bed.io);
    expect(status).toBe(0);
    expect(readEnvValues(join(bed.directory, '.env.local')).DAY0_OIDC_ISSUER).toBe(
      'https://acme.okta.com/oauth2/default',
    );
  });

  it('puts back the public addresses the push rewrote, whatever they were', async (): Promise<void> => {
    const bed = harness({
      envLocal: INSTALLED,
      environment: { DAY0_OIDC_CLIENT_SECRET: 'day0-test-client-secret' },
    });
    await runCommand(parseSetupArguments(ENTRA_ARGUMENTS), bed.io);
    expect(readEnvValues(join(bed.directory, '.env.local')).NEXT_PUBLIC_CONVEX_SITE_URL).toBe(
      'http://127.0.0.1:3551',
    );
  });

  it("refuses Entra's common tenant, and an installation the setup has not made, before writing anything", async (): Promise<void> => {
    const common = harness({
      envLocal: INSTALLED,
      environment: { DAY0_OIDC_CLIENT_SECRET: 'day0-test-client-secret' },
    });
    const args = [...ENTRA_ARGUMENTS];
    args[args.indexOf(TENANT)] = 'common';
    expect(await runCommand(parseSetupArguments(args), common.io)).toBe(1);
    expect(readFileSync(join(common.directory, '.env.local'), 'utf8')).toBe(INSTALLED);
    expect(lines(common.commands).some((line) => line.includes('sync:env'))).toBe(false);

    const bare = harness({ environment: { DAY0_OIDC_CLIENT_SECRET: 'day0-test-client-secret' } });
    expect(await runCommand(parseSetupArguments(ENTRA_ARGUMENTS), bare.io)).toBe(1);
    expect(bare.output.join('\n')).toContain('./setup.sh --route');
  });

  it('prints the plan and changes nothing on --dry-run', async (): Promise<void> => {
    const bed = harness({
      envLocal: INSTALLED,
      environment: { DAY0_OIDC_CLIENT_SECRET: 'day0-test-client-secret' },
    });
    expect(await runCommand(parseSetupArguments([...ENTRA_ARGUMENTS, '--dry-run']), bed.io)).toBe(
      0,
    );
    expect(readFileSync(join(bed.directory, '.env.local'), 'utf8')).toBe(INSTALLED);
    expect(bed.commands).toEqual([]);
    expect(bed.output.join('\n')).toContain('pnpm run sync:env');
  });
});
