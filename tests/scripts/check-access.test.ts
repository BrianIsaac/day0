import { describe, expect, it } from 'vitest';
import {
  accessChecks,
  accessExitCode,
  administratorsCheck,
  formatAccessChecks,
  parseConnectionRows,
  slackApiBaseForCheck,
  type AccessCheck,
  type ConnectionRow,
  type VendorProbes,
} from '../../scripts/check-access';
import { SLACK_KIT_BOT_SCOPES } from '../../src/surfaces/access-kit/slack';

const PUBLIC_URL = 'https://day0.acme.test';
const VALUES = {
  DAY0_PUBLIC_URL: PUBLIC_URL,
  DAY0_ADMINISTRATORS: 'ines@acme.test',
} as const;
/** Fakes in the tree's short shapes only. */
const CONFIGURATION_TOKEN = 'xoxe-1234567890-abcdefghij';
const LINEAR_SECRET = 'lin-test-client-secret';

const SLACK: ConnectionRow = {
  _id: 'conn-slack',
  system: 'slack',
  displayName: 'Slack',
  kind: 'slack-configuration',
  mode: 'per-employee',
  status: 'active',
  scopes: [...SLACK_KIT_BOT_SCOPES],
  redirectUrl: `${PUBLIC_URL}/api/oauth/slack`,
  secretCredentialId: 'cred-slack',
};

const LINEAR: ConnectionRow = {
  _id: 'conn-linear',
  system: 'linear',
  displayName: 'Linear',
  kind: 'oauth-app',
  mode: 'shared',
  status: 'active',
  scopes: ['read', 'write', 'app:assignable'],
  clientCredentialsScopes: ['read', 'write', 'app:assignable'],
  clientId: 'lin-client',
  redirectUrl: `${PUBLIC_URL}/api/oauth/linear`,
  secretCredentialId: 'cred-linear',
};

/** Slack and Linear as the check meets them, answering as a healthy install's would. */
function vendors(
  overrides: {
    readonly slack?: unknown;
    readonly linearToken?: { status: number; body: unknown };
    readonly linearViewer?: unknown;
    readonly opened?: Readonly<Record<string, string | Error>>;
  } = {},
): VendorProbes & { readonly calls: string[] } {
  const calls: string[] = [];
  const opened: Readonly<Record<string, string | Error>> = overrides.opened ?? {
    'cred-slack': CONFIGURATION_TOKEN,
    'cred-linear': LINEAR_SECRET,
  };
  return {
    calls,
    slackApiBase: new URL('https://slack.com/api/'),
    openSecret: async (credentialId: string): Promise<string> => {
      const value = opened[credentialId];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error('Credential is unavailable.');
      return value;
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      calls.push(`${request.method} ${request.url}`);
      if (request.url === 'https://slack.com/api/apps.manifest.validate') {
        expect(request.headers.get('authorization')).toBe(`Bearer ${CONFIGURATION_TOKEN}`);
        const manifest = JSON.parse(
          new URLSearchParams(await request.text()).get('manifest') ?? '',
        );
        expect(manifest.oauth_config.scopes.bot).toEqual(SLACK_KIT_BOT_SCOPES);
        return Response.json(overrides.slack ?? { ok: true });
      }
      if (request.url === 'https://api.linear.app/oauth/token') {
        const form = new URLSearchParams(await request.text());
        expect(form.get('grant_type')).toBe('client_credentials');
        expect(form.get('client_secret')).toBe(LINEAR_SECRET);
        // Linear's own answer to the set, 3 October: `scope: "app:assignable read write"`.
        const answer = overrides.linearToken ?? {
          status: 200,
          body: {
            access_token: 'lin-test-token',
            token_type: 'Bearer',
            scope: form.get('scope')?.split(',').sort().join(' '),
          },
        };
        return Response.json(answer.body, { status: answer.status });
      }
      if (request.url === 'https://api.linear.app/graphql') {
        return Response.json(
          overrides.linearViewer ?? {
            data: { viewer: { id: 'app-user-1', name: 'Day0', app: true } },
          },
        );
      }
      if (request.url === 'https://api.linear.app/oauth/revoke') {
        return new Response(null, { status: 200 });
      }
      throw new Error(`the check reached ${request.url}, which no vendor double answers`);
    },
  };
}

function only(checks: readonly AccessCheck[], subject: string, name: string): AccessCheck {
  const found = checks.find((one) => one.subject === subject && one.name === name);
  if (!found) throw new Error(`no ${name} check for ${subject}`);
  return found;
}

describe('check:access', (): void => {
  it('passes a healthy install: the administrators, and each connection’s status, secret, identity, scopes and redirect', async (): Promise<void> => {
    const probes = vendors();
    const checks = await accessChecks([SLACK, LINEAR], VALUES, probes);

    expect(checks.filter((one) => one.status !== 'ok')).toEqual([]);
    expect(checks.map((one) => `${one.subject} ${one.name}`)).toEqual([
      'deployment administrators',
      'slack status',
      'slack redirect',
      'slack scopes',
      'slack secret',
      'slack identity',
      'linear status',
      'linear redirect',
      'linear scopes',
      'linear secret',
      'linear identity',
    ]);
    expect(only(checks, 'linear', 'identity').detail).toContain('Day0');
    // The check's own token is revoked again: it leaves nothing usable behind.
    expect(probes.calls).toContain('POST https://api.linear.app/oauth/revoke');
    expect(accessExitCode(checks)).toBe(0);
  });

  it('reports a wrong redirect URI', async (): Promise<void> => {
    const checks = await accessChecks(
      [{ ...LINEAR, redirectUrl: 'https://old.acme.test/api/oauth/linear' }],
      VALUES,
      vendors(),
    );
    const redirect = only(checks, 'linear', 'redirect');
    expect(redirect.status).toBe('gap');
    expect(redirect.detail).toContain('https://old.acme.test/api/oauth/linear');
    expect(redirect.detail).toContain(`${PUBLIC_URL}/api/oauth/linear`);
    expect(accessExitCode(checks)).toBe(1);
  });

  it('reports a secret that does not open, and asks the vendor nothing with it', async (): Promise<void> => {
    const probes = vendors({
      opened: { 'cred-slack': new Error('The credential key changed since this row was sealed.') },
    });
    const checks = await accessChecks([SLACK], VALUES, probes);
    const secret = only(checks, 'slack', 'secret');
    expect(secret.status).toBe('gap');
    expect(secret.detail).toContain('does not open');
    expect(secret.detail).toContain('credential key changed');
    expect(only(checks, 'slack', 'identity')).toMatchObject({ status: 'gap' });
    expect(probes.calls).toEqual([]);
  });

  it('reports a missing scope, from the registration and from what the vendor granted', async (): Promise<void> => {
    const registered = await accessChecks(
      [{ ...SLACK, scopes: SLACK_KIT_BOT_SCOPES.filter((scope) => scope !== 'im:write') }],
      VALUES,
      vendors(),
    );
    expect(only(registered, 'slack', 'scopes')).toMatchObject({ status: 'gap' });
    expect(only(registered, 'slack', 'scopes').detail).toContain('im:write');

    const granted = await accessChecks(
      [LINEAR],
      VALUES,
      vendors({
        linearToken: {
          status: 200,
          body: { access_token: 'lin-test-token', token_type: 'Bearer', scope: 'read' },
        },
      }),
    );
    expect(only(granted, 'linear', 'scopes')).toMatchObject({ status: 'gap' });
    expect(only(granted, 'linear', 'scopes').detail).toContain('write');
  });

  it("notes a registration holding scopes Day0 does not use, and passes still (the review's m20)", async (): Promise<void> => {
    const checks = await accessChecks(
      [{ ...SLACK, scopes: [...SLACK_KIT_BOT_SCOPES, 'admin', 'files:write'] }],
      VALUES,
      vendors(),
    );
    const scopes = only(checks, 'slack', 'scopes');
    expect(scopes.status).toBe('warn');
    expect(scopes.detail).toContain('admin, files:write');
    expect(accessExitCode(checks)).toBe(0);
  });

  it('passes a shared Linear connection landed read, write, app:assignable, with no note to remove a scope (R41V-3)', async (): Promise<void> => {
    const checks = await accessChecks([LINEAR], VALUES, vendors());
    expect(only(checks, 'linear', 'scopes')).toMatchObject({
      status: 'ok',
      detail: 'Holds read, write, app:assignable.',
    });
  });

  it('says a shared Linear connection landed without app:assignable takes no delegated ticket, cured by revoke and land again', async (): Promise<void> => {
    const landedBefore = {
      ...LINEAR,
      scopes: ['read', 'write'],
      clientCredentialsScopes: ['read', 'write'],
    };
    const checks = await accessChecks([landedBefore], VALUES, vendors());
    const scopes = only(checks, 'linear', 'scopes');
    expect(scopes.status).toBe('gap');
    expect(scopes.detail).toContain('app:assignable');
    expect(scopes.detail).toContain('no ticket can be delegated');
    expect(scopes.detail).toContain('revoke');
    expect(scopes.detail).toContain('land it again');
    expect(scopes.detail).not.toContain('--correct');
    expect(accessExitCode(checks)).toBe(1);
  });

  it('says what Slack refused, and that an expired configuration token renews at the next app', async (): Promise<void> => {
    const refused = await accessChecks(
      [SLACK],
      VALUES,
      vendors({ slack: { ok: false, error: 'invalid_auth' } }),
    );
    expect(only(refused, 'slack', 'identity')).toMatchObject({ status: 'gap' });
    expect(only(refused, 'slack', 'identity').detail).toContain('invalid_auth');

    const expired = await accessChecks(
      [SLACK],
      VALUES,
      vendors({ slack: { ok: false, error: 'token_expired' } }),
    );
    expect(only(expired, 'slack', 'identity').status).toBe('warn');
    expect(only(expired, 'slack', 'identity').detail).toContain('refresh token');
  });

  it('says what Linear refused when the client id and secret do not open a token', async (): Promise<void> => {
    const checks = await accessChecks(
      [LINEAR],
      VALUES,
      vendors({ linearToken: { status: 401, body: { error: 'invalid_client' } } }),
    );
    expect(only(checks, 'linear', 'identity')).toMatchObject({ status: 'gap' });
    expect(only(checks, 'linear', 'identity').detail).toContain('invalid_client');
  });

  it('names a connection that needs IT’s attention, and never prints a secret', async (): Promise<void> => {
    const checks = await accessChecks(
      [{ ...SLACK, status: 'needs-attention', statusReason: 'Slack refused the refresh token.' }],
      VALUES,
      vendors(),
    );
    expect(only(checks, 'slack', 'status')).toMatchObject({ status: 'gap' });
    const printed = formatAccessChecks(checks).join('\n');
    expect(printed).toContain('Slack refused the refresh token.');
    expect(printed).not.toContain(CONFIGURATION_TOKEN);
    expect(printed).not.toContain(LINEAR_SECRET);
  });

  it('reports no administrators as a gap, and an entry that is not an address without echoing it', (): void => {
    expect(
      administratorsCheck({ DAY0_ADMINISTRATORS: 'ines@acme.test, Sam@Acme.test' }),
    ).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('ines@acme.test, sam@acme.test'),
    });
    expect(administratorsCheck({})).toMatchObject({ status: 'gap' });
    const odd = administratorsCheck({ DAY0_ADMINISTRATORS: 'not-an-address' });
    expect(odd.status).toBe('gap');
  });

  it('reads the connections the CLI lists, active and needing attention, the revoked left out', (): void => {
    const rows = parseConnectionRows(
      [
        JSON.stringify({
          ...SLACK,
          _creationTime: 1,
          registeredBy: { via: 'setup-cli', at: 1 },
          createdAt: 1,
        }),
        JSON.stringify({
          ...LINEAR,
          status: 'revoked',
          revokedAt: 2,
          registeredBy: { via: 'setup-cli', at: 1 },
          createdAt: 1,
        }),
        '',
      ].join('\n'),
    );
    expect(rows.map((row) => row.system)).toEqual(['slack']);
    expect(() => parseConnectionRows('{"system": 1}')).toThrow(/organisation connection/);
  });

  it('checks an MCP server’s authorisation server by its metadata, and a public client holds no secret', async (): Promise<void> => {
    const mcp: ConnectionRow = {
      _id: 'conn-mcp',
      system: 'mcp:mcp.acme.com',
      displayName: 'mcp.acme.com',
      kind: 'mcp-client',
      mode: 'per-employee',
      status: 'active',
      scopes: ['crm.read'],
      clientId: 'day0-mcp',
      issuer: 'https://auth.acme.com',
      redirectUrl: `${PUBLIC_URL}/api/oauth/mcp`,
    };
    const metadata = (scopes: readonly string[]): VendorProbes => ({
      slackApiBase: new URL('https://slack.com/api/'),
      openSecret: async (): Promise<string> => {
        throw new Error('a public client opens no secret');
      },
      fetch: async (input: RequestInfo | URL): Promise<Response> =>
        String(input) === 'https://auth.acme.com/.well-known/oauth-authorization-server'
          ? Response.json({
              issuer: 'https://auth.acme.com',
              token_endpoint: 'https://auth.acme.com/token',
              scopes_supported: scopes,
            })
          : new Response('not here', { status: 404 }),
    });

    const passing = await accessChecks([mcp], VALUES, metadata(['crm.read', 'crm.write']));
    expect(passing.filter((one) => one.status !== 'ok')).toEqual([]);
    expect(only(passing, 'mcp:mcp.acme.com', 'secret').detail).toContain('public client');

    const narrower = await accessChecks([mcp], VALUES, metadata(['crm.write']));
    expect(only(narrower, 'mcp:mcp.acme.com', 'scopes')).toMatchObject({ status: 'gap' });

    const undiscovered = await accessChecks([{ ...mcp, issuer: undefined }], VALUES, metadata([]));
    expect(only(undiscovered, 'mcp:mcp.acme.com', 'identity').status).toBe('warn');
  });

  it('requests no app-actor token for a connection that holds no scope set of its own (join 7)', async (): Promise<void> => {
    const probes = vendors();
    const checks = await accessChecks(
      [{ ...LINEAR, clientCredentialsScopes: undefined }],
      VALUES,
      probes,
    );
    expect(only(checks, 'linear', 'identity')).toMatchObject({ status: 'gap' });
    expect(only(checks, 'linear', 'identity').detail).toContain('no client-credentials scope set');
    expect(probes.calls).toEqual([]);
  });

  it('names a token that acts as a person, not as the app, as a gap (join 7)', async (): Promise<void> => {
    const probes = vendors({
      linearViewer: { data: { viewer: { id: 'person-1', name: 'Ines', app: false } } },
    });
    const checks = await accessChecks([LINEAR], VALUES, probes);
    expect(only(checks, 'linear', 'identity')).toMatchObject({ status: 'gap' });
    expect(only(checks, 'linear', 'identity').detail).toContain('acts as a person');
    expect(probes.calls).toContain('POST https://api.linear.app/oauth/revoke');
  });

  it('passes a per-employee Linear connection, which holds no organisation secret, and asks Linear nothing (join 2)', async (): Promise<void> => {
    const perEmployee: ConnectionRow = {
      _id: 'conn-linear',
      system: 'linear',
      displayName: 'Linear',
      kind: 'oauth-app',
      mode: 'per-employee',
      status: 'active',
      scopes: ['read', 'write', 'app:assignable'],
      redirectUrl: `${PUBLIC_URL}/api/oauth/linear`,
    };
    const probes = vendors();
    const checks = await accessChecks([perEmployee], VALUES, probes);
    expect(checks.filter((one) => one.status === 'gap')).toEqual([]);
    expect(only(checks, 'linear', 'secret')).toMatchObject({ status: 'ok' });
    expect(only(checks, 'linear', 'secret').detail).toContain('own app');
    expect(accessExitCode(checks)).toBe(0);
    expect(probes.calls).toEqual([]);
  });

  it('reaches the fake Slack a bed publishes on this machine, and Slack itself otherwise', (): void => {
    expect(slackApiBaseForCheck({}).href).toBe('https://slack.com/api/');
    expect(
      slackApiBaseForCheck({
        DAY0_TEST_SLACK_API_URL: 'http://fake-slack:8090/api/',
        DAY0_TEST_SLACK_AUTHORIZE_URL: 'http://127.0.0.1:3442/oauth/v2/authorize',
      }).href,
    ).toBe('http://127.0.0.1:3442/api/');
    expect(() =>
      slackApiBaseForCheck({
        DAY0_TEST_SLACK_API_URL: 'http://fake-slack:8090/api/',
        DAY0_TEST_SLACK_AUTHORIZE_URL: 'https://evil.example/oauth/v2/authorize',
      }),
    ).toThrow(/this machine/);
    // A loopback-looking prefix with credentials in it names another host.
    expect(() =>
      slackApiBaseForCheck({
        DAY0_TEST_SLACK_API_URL: 'http://fake-slack:8090/api/',
        DAY0_TEST_SLACK_AUTHORIZE_URL: 'http://127.0.0.1:1@evil.example/oauth/v2/authorize',
      }),
    ).toThrow(/this machine/);
  });
});
