import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSetupArguments, readEnvValues, runCommand } from '../../scripts/setup';
import { slackKitManifestTemplate } from '../../src/surfaces/access-kit/slack';
import { SLACK_KIT_BOT_SCOPES } from '../../src/surfaces/access-kit/slack';
import { buildSlackManifest } from '../../src/surfaces/slack-manifest';
import { harness, type Harness, type HarnessOptions } from './setup-harness';
import { createIssuer } from '../../fake-oidc/issuer.js';
import type { OauthFetch } from '../../src/surfaces/mcp-oauth';

/** An installation with the company sign-in in place, as `./setup.sh sign-in` leaves it. */
const SIGNED_IN = [
  'COMPOSE_PROJECT_NAME=day0-w11ai',
  'CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3740',
  'CONVEX_SELF_HOSTED_ADMIN_KEY=convex-self-hosted|admin',
  'NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3740',
  'DAY0_SURFACE_MODE=real',
  'DAY0_PROFILE=customer-local',
  'DAY0_OIDC_ISSUER=https://id.acme.test',
  'DAY0_OIDC_AUDIENCE=day0-app',
  'DAY0_OIDC_ALLOWED_DOMAINS=acme.test',
  'DAY0_PUBLIC_URL=https://day0.acme.test',
  'DAY0_DOCS_HOST_DIR=./docs-local',
  '',
].join('\n');

/** Fakes in the tree's short shapes only. */
const SECRETS = {
  SLACK_CONFIGURATION_TOKEN: 'xoxe-1234567890-abcdefghij',
  SLACK_CONFIGURATION_REFRESH_TOKEN: 'xoxe-1-refresh-abcdefghij',
  LINEAR_CLIENT_SECRET: 'lin-test-client-secret',
} as const;

const STDIN = [
  `SLACK_CONFIGURATION_TOKEN=${SECRETS.SLACK_CONFIGURATION_TOKEN}`,
  `SLACK_CONFIGURATION_REFRESH_TOKEN=${SECRETS.SLACK_CONFIGURATION_REFRESH_TOKEN}`,
  'LINEAR_CLIENT_ID=lin-client',
  `LINEAR_CLIENT_SECRET=${SECRETS.LINEAR_CLIENT_SECRET}`,
  '',
].join('\n');

/** The deployment's function API as the verb meets it: which systems are connected, and every call. */
interface Deployment {
  readonly calls: Array<{ kind: string; path: string; args: Record<string, unknown> }>;
  readonly fetch: typeof fetch;
}

function deployment(connected: readonly string[] = []): Deployment {
  const calls: Deployment['calls'] = [];
  return {
    calls,
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      expect(url.startsWith('http://127.0.0.1:3740/api/')).toBe(true);
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Convex convex-self-hosted|admin',
      );
      const body = JSON.parse(String(init?.body)) as {
        path: string;
        args: Record<string, unknown>;
      };
      calls.push({ kind: url.slice(url.lastIndexOf('/') + 1), path: body.path, args: body.args });
      if (body.path === 'organisationConnections:occupyingFor') {
        const system = String(body.args.system);
        return Response.json({
          status: 'success',
          value: connected.includes(system)
            ? {
                system,
                displayName: 'Slack',
                status: 'active',
                kind: 'slack-configuration',
                mode: 'per-employee',
                scopes: ['chat:write', 'im:write'],
                redirectUrl: 'https://day0.old.acme.test/api/oauth/slack',
              }
            : null,
        });
      }
      if (body.path === 'organisationConnections:landFromSetup') {
        return Response.json({ status: 'success', value: `conn-${String(body.args.system)}` });
      }
      if (body.path === 'organisationCorrections:correctFromSetup') {
        return Response.json({ status: 'success', value: null });
      }
      return Response.json({ status: 'error', errorMessage: `no such function ${body.path}` });
    },
  };
}

/** The documentation folder a customer linked, naming Slack, Linear and GitHub. */
function documentation(directory: string): void {
  mkdirSync(join(directory, 'docs-local', 'revops'), { recursive: true });
  writeFileSync(
    join(directory, 'docs-local', 'revops', 'slack.md'),
    'Integration: Slack Web API at `https://slack.com/api/`.\n',
  );
  writeFileSync(
    join(directory, 'docs-local', 'revops', 'tickets.md'),
    'Tickets are in Linear: https://linear.app/acme. Code on https://github.com/acme/app.\n',
  );
}

interface AccessBed {
  readonly bed: Harness;
  readonly deployment: Deployment;
  readonly record: string;
  run(args: readonly string[], stdin?: string): Promise<number>;
}

/** A vendor seam that refuses every call: no test reaches a vendor it did not stand up. */
const NO_VENDOR: OauthFetch = async (url: URL): Promise<Response> => {
  throw new Error(`no vendor answers ${url.href} in a test`);
};

function accessBed(
  options: HarnessOptions & {
    readonly connected?: readonly string[];
    readonly vendorFetch?: OauthFetch;
  } = {},
): AccessBed {
  const bed = harness({ envLocal: SIGNED_IN, ...options });
  documentation(bed.directory);
  const api = deployment(options.connected);
  const record = mkdtempSync(join(tmpdir(), 'day0-install-record-'));
  return {
    bed,
    deployment: api,
    record,
    run: async (args: readonly string[], stdin = STDIN): Promise<number> =>
      await runCommand(parseSetupArguments(['--mode', 'real', ...args]), {
        ...bed.io,
        fetch: api.fetch,
        vendorFetch: options.vendorFetch ?? NO_VENDOR,
        readStdin: async (): Promise<string> => stdin,
      }),
  };
}

const ACCESS = ['access', '--administrators', 'ines@acme.test', '--secrets-stdin'];

/** Every command a run made, each as one line. */
function ran(bed: Harness): string[] {
  return bed.commands.map((call) => [call.command, ...call.args].join(' '));
}

describe('setup: the access verb', (): void => {
  it('lands each documented system the kit connects, then runs check:access and exits with its status', async (): Promise<void> => {
    for (const checkStatus of [0, 1]) {
      const bed = accessBed({
        failing: checkStatus === 0 ? [] : [{ match: 'run check:access', status: 1, stderr: 'gap' }],
      });
      const status = await bed.run([...ACCESS, '--record', bed.record]);
      expect(status, `check exited ${checkStatus}`).toBe(checkStatus);

      const landings = bed.deployment.calls.filter(
        (call) => call.path === 'organisationConnections:landFromSetup',
      );
      expect(landings.map((call) => call.kind)).toEqual(['action', 'action']);
      expect(landings[0].args).toEqual({
        system: 'slack',
        displayName: 'Slack',
        kind: 'slack-configuration',
        mode: 'per-employee',
        scopes: [...SLACK_KIT_BOT_SCOPES],
        redirectUrl: 'https://day0.acme.test/api/oauth/slack',
        secret: SECRETS.SLACK_CONFIGURATION_TOKEN,
        refreshToken: SECRETS.SLACK_CONFIGURATION_REFRESH_TOKEN,
      });
      expect(landings[1].args).toEqual({
        system: 'linear',
        displayName: 'Linear',
        kind: 'oauth-app',
        mode: 'shared',
        scopes: ['read', 'write', 'app:assignable'],
        clientCredentialsScopes: ['read', 'write', 'app:assignable'],
        clientId: 'lin-client',
        redirectUrl: 'https://day0.acme.test/api/oauth/linear',
        secret: SECRETS.LINEAR_CLIENT_SECRET,
      });

      const lines = ran(bed.bed);
      const order = ['run sync:env', 'run check:access'].map((step) =>
        lines.findIndex((line) => line.includes(step)),
      );
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(readEnvValues(join(bed.bed.directory, '.env.local')).DAY0_ADMINISTRATORS).toBe(
        'ines@acme.test',
      );
    }
  });

  it('never puts a secret on a command line or the terminal, nor in the install record', async (): Promise<void> => {
    const bed = accessBed();
    await bed.run([...ACCESS, '--record', bed.record]);
    const everything = [
      ...ran(bed.bed),
      ...bed.bed.commands.map((call) => JSON.stringify(call.env ?? {})),
      ...bed.bed.output,
      ...readdirSync(bed.record).map((name) => readFileSync(join(bed.record, name), 'utf8')),
    ].join('\n');
    for (const secret of Object.values(SECRETS)) expect(everything).not.toContain(secret);
  });

  it('never prints a secret the deployment echoes back when it refuses a landing', async (): Promise<void> => {
    const bed = accessBed();
    const echoing = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as {
        path: string;
        args: Record<string, unknown>;
      };
      if (body.path === 'organisationConnections:landFromSetup') {
        return Response.json({
          status: 'error',
          errorMessage: `Value does not match validator. Object: ${JSON.stringify(body.args)}`,
        });
      }
      return await bed.deployment.fetch(input, init);
    };
    const status = await runCommand(parseSetupArguments(['--mode', 'real', ...ACCESS]), {
      ...bed.bed.io,
      fetch: echoing,
      readStdin: async (): Promise<string> => STDIN,
    });
    expect(status).toBe(1);
    const printed = bed.bed.output.join('\n');
    expect(printed).toContain('Value does not match validator');
    for (const secret of Object.values(SECRETS)) expect(printed).not.toContain(secret);
  });

  it('lists what the documentation names, and says a known system without an issuer keeps the pasted key', async (): Promise<void> => {
    const bed = accessBed();
    await bed.run(ACCESS);
    const printed = bed.bed.output.join('\n');
    expect(printed).toContain('Slack (revops/slack.md)');
    expect(printed).toContain('Linear (revops/tickets.md)');
    expect(printed).toMatch(/github .*keeps the pasted key/);
  });

  it('writes an install record of what was registered, where, with which scopes, and when each secret expires', async (): Promise<void> => {
    const bed = accessBed();
    await bed.run([...ACCESS, '--record', bed.record]);
    const [file] = readdirSync(bed.record);
    expect(file).toMatch(/^install-record-\d{4}-\d{2}-\d{2}\.md$/);
    const record = readFileSync(join(bed.record, file), 'utf8');
    expect(record).toContain('https://id.acme.test');
    expect(record).toContain('https://day0.acme.test/api/auth/oidc/callback');
    expect(record).toContain('ines@acme.test');
    expect(record).toContain('Slack, per employee');
    expect(record).toContain('https://day0.acme.test/api/oauth/slack');
    expect(record).toContain(SLACK_KIT_BOT_SCOPES.join(', '));
    expect(record).toContain('12 hours');
    expect(record).toContain('Linear, shared');
    expect(record).toContain('30 days');
  });

  it('adds a second run on the same day to the install record, never replacing the first (R41V-12)', async (): Promise<void> => {
    const bed = accessBed();
    // The walk: Linear per employee, then Slack later the same day.
    await bed.run([
      'access',
      '--administrators',
      'ines@acme.test',
      '--systems',
      'linear',
      '--connect-mode',
      'linear=per-employee',
      '--record',
      bed.record,
    ]);
    await bed.run([...ACCESS, '--systems', 'slack', '--record', bed.record]);

    const files = readdirSync(bed.record);
    expect(files).toHaveLength(1);
    const record = readFileSync(join(bed.record, files[0]!), 'utf8');
    expect(record).toContain('Linear, per employee');
    expect(record).toContain('Slack, per employee');
    expect(record.indexOf('Linear, per employee')).toBeLessThan(
      record.indexOf('Slack, per employee'),
    );
    expect(record.match(/^# Day0 install record/gm)).toHaveLength(1);
  });

  it('writes the record under HOME by default, and nowhere when HOME is unset and no --record is given', async (): Promise<void> => {
    const home = mkdtempSync(join(tmpdir(), 'day0-home-'));
    const withHome = accessBed({ environment: { HOME: home } });
    await withHome.run(ACCESS);
    expect(readdirSync(join(home, 'day0-install', 'day0-w11ai'))).toHaveLength(1);

    const homeless = accessBed();
    const status = await homeless.run(ACCESS);
    expect(status).toBe(0);
    expect(homeless.bed.output.join('\n')).toContain(
      'HOME is unset, so the install record has no default place',
    );
  });

  it('stops before writing or landing anything when an answer is missing, naming it', async (): Promise<void> => {
    const bed = accessBed();
    const status = await bed.run(ACCESS, STDIN.replace(/^LINEAR_CLIENT_SECRET=.*$/m, ''));
    expect(status).toBe(1);
    expect(bed.bed.output.join('\n')).toContain('LINEAR_CLIENT_SECRET');
    expect(bed.deployment.calls.filter((call) => call.kind === 'action')).toEqual([]);
    expect(ran(bed.bed).some((line) => line.includes('sync:env'))).toBe(false);
    expect(
      readEnvValues(join(bed.bed.directory, '.env.local')).DAY0_ADMINISTRATORS,
    ).toBeUndefined();
  });

  it('leaves a system already connected as it is, and says where to rotate or revoke it', async (): Promise<void> => {
    const bed = accessBed({ connected: ['slack'] });
    const status = await bed.run(ACCESS);
    expect(status).toBe(0);
    const landed = bed.deployment.calls
      .filter((call) => call.path === 'organisationConnections:landFromSetup')
      .map((call) => call.args.system);
    expect(landed).toEqual(['linear']);
    expect(bed.bed.output.join('\n')).toMatch(/Slack is already connected.*organisation page/);
  });

  it('records a connection already there as the deployment holds it, on a rerun the same day', async (): Promise<void> => {
    const bed = accessBed({ connected: ['slack'] });
    await bed.run([...ACCESS, '--record', bed.record]);
    const [file] = readdirSync(bed.record);
    const record = readFileSync(join(bed.record, file), 'utf8');
    expect(record).toContain('### Slack, per employee');
    expect(record).toContain('- This run: already connected');
    expect(record).toContain('- Scopes: chat:write, im:write');
    expect(record).toContain(
      '- Redirect URI registered: https://day0.old.acme.test/api/oauth/slack',
    );
  });

  it('takes the systems and their modes from flags, and lands Linear per employee with nothing handed over (join 2)', async (): Promise<void> => {
    const bed = accessBed();
    const status = await bed.run([
      ...ACCESS,
      '--systems',
      'slack,linear',
      '--connect-mode',
      'linear=per-employee',
      '--record',
      bed.record,
    ]);
    expect(status).toBe(0);
    const landings = bed.deployment.calls.filter(
      (call) => call.path === 'organisationConnections:landFromSetup',
    );
    expect(landings.map((call) => call.args.system)).toEqual(['slack', 'linear']);
    expect(landings[1].args).toEqual({
      system: 'linear',
      displayName: 'Linear',
      kind: 'oauth-app',
      mode: 'per-employee',
      scopes: ['read', 'write', 'app:assignable'],
      redirectUrl: 'https://day0.acme.test/api/oauth/linear',
    });
    expect(bed.bed.output.join('\n')).toContain('Linear: connect per employee. ');
    const [file] = readdirSync(bed.record);
    const record = readFileSync(join(bed.record, file), 'utf8');
    expect(record).toContain('### Linear, per employee');
    expect(record).not.toContain('not landed at install');
  });

  it('reads each MCP server’s answers under its own host’s names when stdin answers for several', async (): Promise<void> => {
    const bed = accessBed();
    const stdin = [
      'MCP_MCP_ACME_COM_CLIENT_ID=acme-client',
      'MCP_MCP_ACME_COM_CLIENT_SECRET=acme-test-secret',
      'MCP_MCP_ACME_COM_ISSUER=https://auth.acme.com',
      'MCP_CRM_ACME_COM_CLIENT_ID=crm-client',
      'MCP_CRM_ACME_COM_ISSUER=https://id.crm.acme.com',
      '',
    ].join('\n');
    const status = await bed.run(
      [...ACCESS, '--systems', 'https://mcp.acme.com/mcp,https://crm.acme.com/mcp'],
      stdin,
    );
    expect(status).toBe(0);
    const landed = bed.deployment.calls
      .filter((call) => call.path === 'organisationConnections:landFromSetup')
      .map((call) => [
        call.args.system,
        call.args.clientId,
        call.args.secret ?? null,
        call.args.issuer,
      ]);
    expect(landed).toEqual([
      ['mcp:mcp.acme.com', 'acme-client', 'acme-test-secret', 'https://auth.acme.com'],
      ['mcp:crm.acme.com', 'crm-client', null, 'https://id.crm.acme.com'],
    ]);
  });

  it("finds a public MCP client's issuer from the server's own metadata when IT leaves it blank, and says so (the review's m4)", async (): Promise<void> => {
    const issuer = createIssuer({
      issuer: 'https://auth.acme.test',
      clients: [{ id: 'docs-client', redirectUris: ['https://day0.acme.test/api/oauth/mcp'] }],
      protectedResource: { path: '/mcp', scopes: ['read'] },
    });
    const bed = accessBed({
      vendorFetch: async (url: URL, init: RequestInit): Promise<Response> =>
        await issuer.handle(new Request(url, init)),
    });
    const status = await bed.run(
      [...ACCESS, '--systems', 'https://auth.acme.test/mcp'],
      'MCP_CLIENT_ID=docs-client\n',
    );
    expect(status).toBe(0);
    const [landing] = bed.deployment.calls.filter(
      (call) => call.path === 'organisationConnections:landFromSetup',
    );
    expect(landing?.args).toMatchObject({
      system: 'mcp:auth.acme.test',
      clientId: 'docs-client',
      issuer: 'https://auth.acme.test',
    });
    expect(bed.bed.output.join('\n')).toContain(
      'The server names https://auth.acme.test as its authorisation server; the connection records it as the issuer.',
    );
  });

  it("never reads a confidential client's issuer from the server: IT names it, or nothing is landed (the code pass's M1)", async (): Promise<void> => {
    const issuer = createIssuer({
      issuer: 'https://auth.acme.test',
      clients: [{ id: 'docs-client', redirectUris: ['https://day0.acme.test/api/oauth/mcp'] }],
      protectedResource: { path: '/mcp', scopes: ['read'] },
    });
    const bed = accessBed({
      vendorFetch: async (url: URL, init: RequestInit): Promise<Response> =>
        await issuer.handle(new Request(url, init)),
    });
    const status = await bed.run(
      [...ACCESS, '--systems', 'https://auth.acme.test/mcp'],
      'MCP_CLIENT_ID=docs-client\nMCP_CLIENT_SECRET=docs-test-secret\n',
    );
    expect(status).toBe(1);
    expect(
      bed.deployment.calls.filter((call) => call.path === 'organisationConnections:landFromSetup'),
    ).toEqual([]);
    expect(bed.bed.output.join('\n')).toContain(
      "Nothing was written: https://auth.acme.test/mcp has a client secret and no issuer: give the issuer of the authorisation server IT registered the client with (the prompt's issuer, or MCP_ISSUER on stdin); Day0 sends the secret to that server alone.",
    );
  });

  it('writes and lands nothing when the server names no authorisation server it can read', async (): Promise<void> => {
    const bed = accessBed();
    const status = await bed.run(
      [...ACCESS, '--systems', 'https://auth.acme.test/mcp'],
      'MCP_CLIENT_ID=docs-client\n',
    );
    expect(status).toBe(1);
    expect(
      bed.deployment.calls.filter((call) => call.path === 'organisationConnections:landFromSetup'),
    ).toEqual([]);
    expect(bed.bed.output.join('\n')).toContain(
      'Nothing was written: https://auth.acme.test/mcp names no authorisation server Day0 could read',
    );
  });

  it('prints the plan on a dry run, asks no secret, writes and lands nothing', async (): Promise<void> => {
    const bed = accessBed();
    const status = await bed.run([...ACCESS, '--dry-run'], '');
    expect(status).toBe(0);
    expect(bed.deployment.calls.filter((call) => call.kind === 'action')).toEqual([]);
    expect(ran(bed.bed).some((line) => line.includes('sync:env'))).toBe(false);
    expect(bed.bed.output.join('\n')).toContain('Nothing was written and nothing was landed.');
  });

  it('prints the Slack manifest the issuer builds an employee’s app from', async (): Promise<void> => {
    const bed = accessBed();
    const status = await bed.run(['access', '--print-manifest', 'slack']);
    expect(status).toBe(0);
    const printed = bed.bed.output.join('\n');
    expect(JSON.parse(printed)).toEqual(JSON.parse(slackKitManifestTemplate()));
    expect(
      buildSlackManifest({
        agentName: 'Maya',
        publicUrl: 'https://day0.acme.test',
        template: printed,
      }),
    ).toEqual(
      buildSlackManifest({
        agentName: 'Maya',
        publicUrl: 'https://day0.acme.test',
        template: slackKitManifestTemplate(),
      }),
    );
  });

  it('prints the Linear app’s manifest and the link that pre-fills its create form', async (): Promise<void> => {
    const bed = accessBed();
    expect(await bed.run(['access', '--print-manifest', 'linear'])).toBe(0);
    const printed = bed.bed.output.join('\n');
    expect(printed).toContain('"client_credentials"');
    expect(printed).toContain('https://linear.app/settings/api/applications/new?manifest=');
  });

  it('prints an employee’s own Linear app’s form, pre-filled with its name and no client credentials (R41V-R5)', async (): Promise<void> => {
    const bed = accessBed();
    expect(await bed.run(['access', '--print-manifest', 'linear', '--employee', 'Leo'])).toBe(0);
    const printed = bed.bed.output.join('\n');
    const link = /https:\/\/linear\.app\/settings\/api\/applications\/new\?manifest=\S+/.exec(
      printed,
    )?.[0];
    expect(link).toBeDefined();
    const manifest = JSON.parse(new URL(link ?? '').searchParams.get('manifest') ?? '');
    expect(manifest.oauth).toMatchObject({
      client_name: 'Leo (Day0)',
      grant_types: ['authorization_code'],
    });
    expect(printed).not.toContain('"client_credentials"');
  });

  it('refuses --employee without --print-manifest linear, and an empty name, landing nothing', async (): Promise<void> => {
    const alone = accessBed();
    expect(await alone.run([...ACCESS, '--employee', 'Leo'])).toBe(1);
    expect(alone.bed.output.join('\n')).toContain('--employee names whose own app');
    expect(alone.deployment.calls.filter((call) => call.kind === 'action')).toEqual([]);

    const empty = accessBed();
    expect(await empty.run(['access', '--print-manifest', 'linear', '--employee', ' '])).toBe(1);
    expect(empty.bed.output.join('\n')).toContain("--employee needs the employee's name");
  });

  it('refuses an employee’s name for Slack, whose employees’ apps Day0 creates itself', async (): Promise<void> => {
    const bed = accessBed();
    expect(await bed.run(['access', '--print-manifest', 'slack', '--employee', 'Leo'])).toBe(1);
    expect(bed.bed.output.join('\n')).toContain("Day0 creates each employee's Slack app itself");
  });

  it("corrects a connection's recorded redirect and scopes to what Day0 returns to and the kit's list, revoking nothing (M12 e)", async (): Promise<void> => {
    const bed = accessBed({ connected: ['slack'] });
    expect(await bed.run(['access', '--correct', 'slack'])).toBe(0);
    expect(
      bed.deployment.calls
        .filter((call) => call.kind === 'mutation' || call.kind === 'action')
        .map((call) => [call.path, call.args]),
    ).toEqual([
      [
        'organisationCorrections:correctFromSetup',
        {
          system: 'slack',
          redirectUrl: 'https://day0.acme.test/api/oauth/slack',
          scopes: [...SLACK_KIT_BOT_SCOPES],
        },
      ],
    ]);
    const said = bed.bed.output.join('\n');
    expect(said).toContain(
      'Slack: the recorded redirect is now https://day0.acme.test/api/oauth/slack (it was https://day0.old.acme.test/api/oauth/slack)',
    );
    expect(said).toContain('No secret changed and no card ended.');
  });

  it('corrects one system at a time, refusing a list before it calls anything', async (): Promise<void> => {
    const bed = accessBed({ connected: ['slack'] });
    expect(await bed.run(['access', '--correct', 'slack,linear'])).toBe(1);
    expect(bed.deployment.calls).toEqual([]);
    expect(bed.bed.output.join('\n')).toContain('The kit corrects one system at a time: name one.');
  });

  it('refuses to correct a system with no connection, writing nothing', async (): Promise<void> => {
    const bed = accessBed();
    expect(await bed.run(['access', '--correct', 'slack'])).toBe(1);
    expect(bed.deployment.calls.map((call) => call.path)).not.toContain(
      'organisationCorrections:correctFromSetup',
    );
    expect(bed.bed.output.join('\n')).toContain(
      'Slack is not connected for the organisation: land it with ./setup.sh access first.',
    );
  });

  it('refuses an installation another checkout set up, as the lifecycle verbs do', async (): Promise<void> => {
    const bed = accessBed({ envLocal: `${SIGNED_IN}DAY0_SETUP_ROOT=/somewhere/else\n` });
    const status = await bed.run(ACCESS);
    expect(status).toBe(1);
    expect(bed.bed.output.join('\n')).toContain('belongs to another checkout');
    expect(bed.deployment.calls).toEqual([]);
  });
});
