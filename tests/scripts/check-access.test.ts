import { describe, expect, it } from 'vitest';
import {
  accessChecks,
  accessExitCode,
  administratorsCheck,
  formatAccessChecks,
  noConnectionLine,
  parseConnectionRows,
  linearBedRefusal,
  slackApiBaseForCheck,
  type AccessCheck,
  type ConnectionRow,
  type SocketBridgeReading,
  type HeartbeatsReading,
  type MessagesTabReading,
  type VendorProbes,
} from '../../scripts/check-access';
import type { ModelDial } from '../../scripts/model-reach';
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
    /** What the backend container's dial of an address finds; reached by default. */
    readonly backend?: (url: URL) => ModelDial | undefined;
    /** What the Slack socket service says of itself; running, with no app, by default. */
    readonly socket?: SocketBridgeReading;
    /** Whether the typed code reaches each employee app; none installed by default (W12V-7). */
    readonly messages?: MessagesTabReading;
    /** What the backend holds of the service's reports; not asked by default (13-FS). */
    readonly heartbeats?: HeartbeatsReading;
  } = {},
): VendorProbes & {
  readonly calls: string[];
  readonly fromTheBackend: string[];
  readonly requestedScopes: (string | null)[];
} {
  const calls: string[] = [];
  const fromTheBackend: string[] = [];
  const requestedScopes: (string | null)[] = [];
  const opened: Readonly<Record<string, string | Error>> = overrides.opened ?? {
    'cred-slack': CONFIGURATION_TOKEN,
    'cred-linear': LINEAR_SECRET,
  };
  return {
    calls,
    fromTheBackend,
    requestedScopes,
    slackApiBase: new URL('https://slack.com/api/'),
    socketBridge: async (): Promise<SocketBridgeReading> =>
      overrides.socket ?? { state: 'running', synced: true, apps: [] },
    messagesTab: async (): Promise<MessagesTabReading> =>
      overrides.messages ?? { state: 'read', apps: [] },
    ...(overrides.heartbeats === undefined
      ? {}
      : { heartbeats: async (): Promise<HeartbeatsReading> => overrides.heartbeats! }),
    fromBackend: async (url: URL): Promise<ModelDial> => {
      fromTheBackend.push(url.href);
      return overrides.backend?.(url) ?? { reach: 'reached', detail: 'HTTP 200' };
    },
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
        requestedScopes.push(form.get('scope'));
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
      'slack reach',
      // Re-pinned for 12-M: Slack's checks end with whether the socket service carries presses.
      'slack socket',
      // Re-pinned for W12V-7: and whether the typed code reaches each employee app.
      'slack messages',
      'linear status',
      'linear redirect',
      'linear scopes',
      'linear secret',
      'linear identity',
      'linear reach',
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
    const probes = vendors();
    const checks = await accessChecks([LINEAR], VALUES, probes);
    expect(only(checks, 'linear', 'scopes')).toMatchObject({
      status: 'ok',
      detail: 'Holds read, write, app:assignable.',
    });
    // The token is asked for with the set the connection landed, exactly: Linear revokes every
    // token of the app when one is asked for with another (L2; the round review's m20).
    expect(probes.requestedScopes).toEqual(['read,write,app:assignable']);
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

  it('says what a per-employee Linear registration without app:assignable costs (decision 5)', async (): Promise<void> => {
    const checks = await accessChecks(
      [
        {
          ...LINEAR,
          mode: 'per-employee',
          scopes: ['read', 'write'],
          clientCredentialsScopes: undefined,
          secretCredentialId: undefined,
        },
      ],
      VALUES,
      vendors(),
    );
    const scopes = only(checks, 'linear', 'scopes');
    expect(scopes.status).toBe('gap');
    expect(scopes.detail).toContain(
      'Missing scope app:assignable (no ticket can be delegated or assigned to the app user, so its employees take only unassigned tickets)',
    );
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
      fromBackend: async (): Promise<ModelDial> => ({ reach: 'reached', detail: 'HTTP 401' }),
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

    // Every card refuses a connection with no issuer since the review's m4, so the check calls it a
    // gap with its cure, where it once noted that the first sign-in would discover one. Since the
    // round review's m13 a public client's cure is a correction, which ends no card.
    const undiscovered = await accessChecks([{ ...mcp, issuer: undefined }], VALUES, metadata([]));
    expect(only(undiscovered, 'mcp:mcp.acme.com', 'identity')).toMatchObject({
      status: 'gap',
      detail:
        "No issuer is recorded, so every employee's authorisation is refused: ./setup.sh access --correct mcp:mcp.acme.com records the issuer the server's own metadata names, and ends no card.",
    });
    const confidential = await accessChecks(
      [{ ...mcp, issuer: undefined, secretCredentialId: 'secret-1' }],
      VALUES,
      { ...metadata([]), openSecret: async (): Promise<string> => 'mcp-test-secret' },
    );
    expect(only(confidential, 'mcp:mcp.acme.com', 'identity')).toMatchObject({
      status: 'gap',
      detail:
        "No issuer is recorded, so every employee's authorisation is refused: a client with a secret takes the issuer IT registered it with, so revoke the connection and land it again with that issuer.",
    });
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

  it("asks each vendor's address from inside the backend container, with no secret, so a pass says the deployment itself reaches it (the review's section 11, item 4)", async (): Promise<void> => {
    const mcp: ConnectionRow = {
      _id: 'conn-mcp',
      system: 'mcp:mcp.acme.com',
      displayName: 'mcp.acme.com',
      kind: 'mcp-client',
      mode: 'per-employee',
      status: 'active',
      scopes: [],
      clientId: 'day0-mcp',
      resource: 'https://mcp.acme.com/mcp',
      redirectUrl: `${PUBLIC_URL}/api/oauth/mcp`,
    };
    const probes = vendors();

    const checks = await accessChecks([SLACK, LINEAR, mcp], VALUES, probes);

    expect(probes.fromTheBackend).toEqual([
      'https://slack.com/api/api.test',
      'https://api.linear.app/graphql',
      'https://mcp.acme.com/mcp',
    ]);
    expect(only(checks, 'slack', 'reach')).toEqual({
      subject: 'slack',
      name: 'reach',
      status: 'ok',
      detail: 'The backend container reached https://slack.com/api/api.test (HTTP 200).',
    });
    expect(only(checks, 'mcp:mcp.acme.com', 'reach').status).toBe('ok');
  });

  it('reports a vendor the backend container cannot reach as a gap with the cure, and a dial that did not run as a note', async (): Promise<void> => {
    const probes = vendors({
      backend: (url: URL) =>
        url.hostname === 'slack.com'
          ? { reach: 'unreachable', detail: 'curl: (6) Could not resolve host: slack.com' }
          : { reach: 'unknown', detail: 'service "backend" is not running' },
    });

    const checks = await accessChecks([SLACK, LINEAR], VALUES, probes);

    expect(only(checks, 'slack', 'reach')).toMatchObject({
      status: 'gap',
      detail:
        'The backend container could not reach https://slack.com/api/api.test: curl: (6) Could not resolve host: slack.com. Every call the deployment makes to Slack starts there: open its way out (the proxy or firewall in front of the backend), then run the check again.',
    });
    expect(only(checks, 'linear', 'reach')).toMatchObject({
      status: 'warn',
      detail:
        'Not asked from the backend container: service "backend" is not running. Start it (`./setup.sh resume`) and run the check again.',
    });
    expect(accessExitCode(checks)).toBe(1);
  });

  it("stops an install whose backend dial did not run, where the access verb alone only notes it (the round review's m10)", async (): Promise<void> => {
    const probes = vendors({
      backend: () => ({ reach: 'unknown', detail: 'service "backend" is not running' }),
    });

    const alone = await accessChecks([LINEAR], VALUES, probes);
    const installing = await accessChecks([LINEAR], VALUES, probes, { install: true });

    expect(only(alone, 'linear', 'reach').status).toBe('warn');
    expect(only(installing, 'linear', 'reach')).toMatchObject({
      status: 'gap',
      detail:
        'Not asked from the backend container: service "backend" is not running. Start it (`./setup.sh resume`) and run the check again.',
    });
    expect(accessExitCode(installing)).toBe(1);
  });

  it("names the container's trust as the cure where its curl refuses the vendor's certificate (the code pass's m7)", async (): Promise<void> => {
    const probes = vendors({
      backend: () => ({
        reach: 'unreachable',
        detail: 'curl: (60) SSL certificate problem: unable to get local issuer certificate',
      }),
    });

    const checks = await accessChecks([SLACK], VALUES, probes);

    expect(only(checks, 'slack', 'reach')).toMatchObject({
      status: 'gap',
      detail:
        "The backend container could not reach https://slack.com/api/api.test: curl: (60) SSL certificate problem: unable to get local issuer certificate. The backend does not trust the certificate the address presents: give the backend container the customer's CA bundle (its SSL_CERT_FILE), then run the check again.",
    });
  });

  it('dials the fake Slack a bed names by the address the deployment itself uses', async (): Promise<void> => {
    const probes = vendors();
    await accessChecks(
      [SLACK],
      { ...VALUES, DAY0_TEST_SLACK_API_URL: 'http://fake-slack:8090/api/' },
      probes,
    );
    expect(probes.fromTheBackend).toEqual(['http://fake-slack:8090/api/api.test']);
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

describe('the check with nothing to check', (): void => {
  it('says none is connected, never "yet", since every connection may have been revoked (the re-walk, row 10)', (): void => {
    expect(noConnectionLine(undefined)).toBe(
      '  None is connected: `./setup.sh access` connects them with the customer’s IT.',
    );
    expect(noConnectionLine('linear')).toBe('  Nothing is connected for linear.');
  });
});

describe('check:access: the Slack socket service (wave 12, 12-M; RM7)', (): void => {
  it('passes when the service holds a connection for every app with an app-level token', async (): Promise<void> => {
    const checks = await accessChecks(
      [SLACK, LINEAR],
      VALUES,
      vendors({
        socket: { state: 'running', synced: true, apps: [{ appId: 'A0MATEO', connected: true }] },
      }),
    );
    expect(only(checks, 'slack', 'socket')).toMatchObject({
      status: 'ok',
      detail: expect.stringContaining('1 employee app'),
    });
    expect(checks.some((one) => one.subject === 'linear' && one.name === 'socket')).toBe(false);
  });

  it('notes a service that is not running: requests carry no buttons', async (): Promise<void> => {
    const checks = await accessChecks(
      [SLACK],
      VALUES,
      vendors({ socket: { state: 'absent', detail: 'service "slack-socket" is not running' } }),
    );
    const socket = only(checks, 'slack', 'socket');
    expect(socket.status).toBe('warn');
    // Re-pinned for W12V-7: the typed code does not always decide; an app that takes no messages
    // refuses it.
    expect(socket.detail).toContain('typed code where the employee app takes messages');
    expect(socket.detail).not.toContain('always decides');
    expect(socket.detail).toContain('pnpm convex:up --profile slack-socket');
    expect(accessExitCode(checks)).toBe(0);
  });

  it('names an app that holds no connection, and the way out it needs', async (): Promise<void> => {
    const checks = await accessChecks(
      [SLACK],
      VALUES,
      vendors({
        socket: {
          state: 'running',
          synced: true,
          apps: [
            { appId: 'A0MATEO', connected: true },
            { appId: 'A0PRIYA', connected: false },
          ],
        },
      }),
    );
    const socket = only(checks, 'slack', 'socket');
    expect(socket.status).toBe('gap');
    expect(socket.detail).toContain('A0PRIYA');
    expect(socket.detail).toContain('wss://');
  });

  it('names an app whose card holds another app’s token', async (): Promise<void> => {
    const socket = only(
      await accessChecks(
        [SLACK],
        VALUES,
        vendors({
          socket: {
            state: 'running',
            synced: true,
            apps: [{ appId: 'A0PRIYA', appName: 'Priya (Day0)', connected: false, mismatch: true }],
          },
        }),
      ),
      'slack',
      'socket',
    );
    expect(socket.status).toBe('gap');
    // Re-pinned for W12-R32: the card is named, and its verb agrees with it.
    expect(socket.detail).toContain("Priya (Day0)'s card holds the app-level token of another app");
  });

  it('names every card that holds another app’s token, with a verb for several, and an app id only where no name came (W12-R32)', async (): Promise<void> => {
    const socket = only(
      await accessChecks(
        [SLACK],
        VALUES,
        vendors({
          socket: {
            state: 'running',
            synced: true,
            apps: [
              { appId: 'A0PRIYA', appName: 'Priya (Day0)', connected: false, mismatch: true },
              { appId: 'A0MATEO', connected: false, mismatch: true },
            ],
          },
        }),
      ),
      'slack',
      'socket',
    );
    expect(socket.detail).toContain(
      'The cards of Priya (Day0) and app A0MATEO each hold the app-level token of another app',
    );
  });

  it('names the secret when the service cannot read the backend’s list', async (): Promise<void> => {
    const socket = only(
      await accessChecks(
        [SLACK],
        VALUES,
        vendors({ socket: { state: 'running', synced: false, apps: [] } }),
      ),
      'slack',
      'socket',
    );
    expect(socket.status).toBe('gap');
    expect(socket.detail).toContain('DAY0_SOCKET_BRIDGE_SECRET');
  });
});

describe('check:access: the Slack socket service’s reports to the backend (13-FS)', (): void => {
  const connected: SocketBridgeReading = {
    state: 'running',
    synced: true,
    apps: [
      { appId: 'A1', appName: 'Ana (Day0)', connected: true },
      { appId: 'A2', appName: 'Cara (Day0)', connected: true },
    ],
  };

  it('names each app the service holds whose live report the backend lacks, as a gap', async (): Promise<void> => {
    const checks = await accessChecks(
      [SLACK],
      VALUES,
      vendors({
        socket: connected,
        heartbeats: {
          state: 'read',
          apps: [
            { appId: 'A1', appName: 'Ana (Day0)', live: false },
            { appId: 'A2', appName: 'Cara (Day0)', live: true },
          ],
        },
      }),
    );
    expect(only(checks, 'slack', 'socket')).toEqual({
      subject: 'slack',
      name: 'socket',
      status: 'gap',
      detail:
        'The Slack socket service holds a connection for Ana (Day0), but the backend has no live report of it, so its card reads the buttons as off and its requests go without them: the service runs a release before v0.17.0, or cannot reach the backend’s heartbeat route. Restart it: pnpm exec tsx scripts/compose.ts --profile slack-socket restart slack-socket.',
    });
  });

  it('passes when the backend holds a live report of every app the service holds', async (): Promise<void> => {
    const checks = await accessChecks(
      [SLACK],
      VALUES,
      vendors({
        socket: connected,
        heartbeats: {
          state: 'read',
          apps: [
            { appId: 'A1', appName: 'Ana (Day0)', live: true },
            { appId: 'A2', appName: 'Cara (Day0)', live: true },
          ],
        },
      }),
    );
    expect(only(checks, 'slack', 'socket')).toMatchObject({
      status: 'ok',
      detail:
        'The Slack socket service holds a connection for 2 employee apps with an app-level token.',
    });
  });
});

describe('check:access: whether the typed code reaches each employee app (W12V-7)', (): void => {
  it('passes when every installed app takes messages', async (): Promise<void> => {
    const checks = await accessChecks(
      [SLACK],
      VALUES,
      vendors({ messages: { state: 'read', apps: [{ appName: 'Iris (Day0)', reach: 'open' }] } }),
    );
    expect(only(checks, 'slack', 'messages')).toMatchObject({
      status: 'ok',
      detail: 'The typed code reaches every employee app (1).',
    });
  });

  it('notes an app Day0 opens at its card’s next check', async (): Promise<void> => {
    const checks = await accessChecks(
      [SLACK],
      VALUES,
      vendors({
        messages: { state: 'read', apps: [{ appName: 'Iris (Day0)', reach: 'day0-opens' }] },
      }),
    );
    expect(only(checks, 'slack', 'messages')).toEqual({
      subject: 'slack',
      name: 'messages',
      status: 'warn',
      detail:
        "Iris (Day0) takes no messages yet, so no typed code reaches it: Day0 tries to open its messages tab at its card's next check (Check the connection on the card tries now).",
    });
    expect(accessExitCode(checks)).toBe(0);
  });

  it('names each app only a person can open, and the one toggle, as a gap', async (): Promise<void> => {
    const checks = await accessChecks(
      [SLACK],
      VALUES,
      vendors({
        messages: {
          state: 'read',
          apps: [
            { appName: 'Otto (Day0)', reach: 'needs-toggle' },
            { appName: 'Vela (Day0)', reach: 'needs-toggle' },
            { appName: 'Iris (Day0)', reach: 'open' },
          ],
        },
      }),
    );
    expect(only(checks, 'slack', 'messages')).toEqual({
      subject: 'slack',
      name: 'messages',
      status: 'gap',
      detail:
        'Otto (Day0) and Vela (Day0) take no messages, so no typed code reaches them, and Day0 cannot change their settings: someone who manages each in Slack turns on App Home, “Allow users to send Slash commands and messages from the messages tab”, and the manager says so on its card (It is on in Slack).',
    });
  });

  it('names each app whose opening Slack refused as a gap, with what a person can do (13-FS)', async (): Promise<void> => {
    const checks = await accessChecks(
      [SLACK],
      VALUES,
      vendors({
        messages: {
          state: 'read',
          apps: [
            { appName: 'Iris (Day0)', reach: 'refused' },
            { appName: 'Vela (Day0)', reach: 'day0-opens' },
          ],
        },
      }),
    );
    expect(only(checks, 'slack', 'messages')).toEqual({
      subject: 'slack',
      name: 'messages',
      status: 'gap',
      detail:
        'Iris (Day0) takes no messages: Slack refused Day0’s opening of its messages tab, so no typed code reaches it, and Day0 does not try again on its own. Someone who manages it in Slack turns on App Home, “Allow users to send Slash commands and messages from the messages tab”, and the manager says so on its card (It is on in Slack), or presses Check the connection there for Day0 to try again.',
    });
  });

  it('says what could not be read, as a note', async (): Promise<void> => {
    const checks = await accessChecks(
      [SLACK],
      VALUES,
      vendors({ messages: { state: 'absent', detail: 'the deployment did not answer' } }),
    );
    expect(only(checks, 'slack', 'messages')).toMatchObject({
      status: 'warn',
      detail: 'Not read: the deployment did not answer.',
    });
  });
});

describe('the bed guard for Linear (W13-R48)', (): void => {
  const BED = { DAY0_TEST_SLACK_API_URL: 'http://fake-slack:8090/api/' };
  const PRELOAD = '--import /checkout/fake-linear/host-preload.mjs';

  it('refuses to reach Linear from a bed unless the fake Linear preload is loaded', (): void => {
    expect(linearBedRefusal(BED, {})).toMatch(
      /^DAY0_TEST_SLACK_API_URL names a fake Slack, so this is a bed, and a bed never calls Linear itself/,
    );
    expect(linearBedRefusal(BED, { FAKE_LINEAR_HOST_URL: 'https://127.0.0.1:3694' })).toMatch(
      /host-preload\.mjs/,
    );
    expect(linearBedRefusal(BED, { NODE_OPTIONS: PRELOAD })).toMatch(/FAKE_LINEAR_HOST_URL/);
    expect(
      linearBedRefusal(BED, {
        FAKE_LINEAR_HOST_URL: 'https://127.0.0.1:3694',
        NODE_OPTIONS: PRELOAD,
      }),
    ).toBeUndefined();
  });

  it('leaves a deployment that names no fake Slack to reach Linear itself', (): void => {
    expect(linearBedRefusal({}, {})).toBeUndefined();
    expect(linearBedRefusal({ DAY0_TEST_SLACK_API_URL: ' ' }, {})).toBeUndefined();
  });
});
