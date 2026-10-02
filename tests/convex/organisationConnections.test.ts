/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { convexTest, type TestConvex } from 'convex-test';
import { ConvexError } from 'convex/values';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import * as organisationConnections from '../../convex/organisationConnections';
import {
  landingRefusal,
  recordOrRelease,
  storeSecrets,
  type Landing,
  type Registration,
} from '../../convex/organisationConnections';
import type { ActionCtx } from '../../convex/_generated/server';
import { NOT_AN_ADMINISTRATOR } from '../../src/lib/administrators';
import { ORGANISATION_HOLDER, ORGANISATION_OWNER_KEY } from '../../src/lib/organisation-key';
import { EMPLOYEE_NOT_YOURS } from '../../src/agent/employee-access';
import { allConvexModules } from './all-modules';
import { managerIdentity } from './fakes/manager-identity';

const CLERK_ISSUER = 'https://demo.clerk.accounts.dev';

/** Ines, the administrator IT named at install. */
const INES = managerIdentity('ines', { issuer: CLERK_ISSUER, email: 'ines@acme.test' });

/** Sam, a manager the list does not name. */
const SAM = managerIdentity('sam', { issuer: CLERK_ISSUER, email: 'sam@acme.test' });

/** A Slack configuration refresh token, in the tree's short fake shape. */
const REFRESH_TOKEN = 'xoxe-1234567890-abcdefghij';

/** A Slack configuration token, in the tree's short fake shape. */
const CONFIGURATION_TOKEN = 'xoxe.xoxp-1234567890-abcdefghij';

/** A Linear client secret, in a short fake shape. */
const CLIENT_SECRET = 'lin_oauth_secret_0123456789';

/** Slack's organisation connection as IT lands it: the configuration token and its refresh token. */
const SLACK: Landing = {
  system: 'slack',
  displayName: 'Slack',
  kind: 'slack-configuration',
  mode: 'per-employee',
  scopes: ['chat:write', 'channels:read'],
  secret: CONFIGURATION_TOKEN,
  refreshToken: REFRESH_TOKEN,
  providerWorkspaceId: 'T0ACME',
};

/** Linear's organisation connection: an OAuth app shared by the employees. */
const LINEAR: Landing = {
  system: 'linear',
  displayName: 'Linear',
  kind: 'oauth-app',
  mode: 'shared',
  scopes: ['read', 'write'],
  clientCredentialsScopes: ['read', 'write'],
  clientId: 'lin-client-1',
  secret: CLIENT_SECRET,
};

beforeEach((): void => {
  vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('DAY0_ADMINISTRATORS', 'ines@acme.test');
});

afterEach((): void => {
  vi.unstubAllEnvs();
});

/** A landing's registration: the landing without its secret and refresh token. */
function withoutSecrets(landing: Landing): Registration {
  return Object.fromEntries(
    Object.entries(landing).filter(([key]) => key !== 'secret' && key !== 'refreshToken'),
  ) as Registration;
}

/** Every row of the organisation's two tables and its credentials, as stored. */
async function organisationRows(harness: TestConvex<typeof schema>): Promise<{
  connections: Doc<'organisationConnections'>[];
  ledger: Doc<'connectionEvents'>[];
  credentials: Doc<'credentials'>[];
}> {
  return await harness.run(async (ctx) => ({
    connections: await ctx.db.query('organisationConnections').collect(),
    ledger: await ctx.db.query('connectionEvents').collect(),
    credentials: await ctx.db.query('credentials').collect(),
  }));
}

/** The refusal's words a caller reads, or the error's message for anything else. */
async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof ConvexError ? String(error.data) : (error as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('the organisation connection module', (): void => {
  it('exposes land, rotate, revoke and the two reads publicly, and the CLI and activeFor internally', (): void => {
    for (const name of [
      'land',
      'rotate',
      'revoke',
      'listForAdministrator',
      'summaryForManager',
    ] as const) {
      expect(organisationConnections[name].isPublic, name).toBe(true);
    }
    for (const name of [
      'landFromSetup',
      'rotateFromSetup',
      'revokeFromSetup',
      'activeFor',
    ] as const) {
      expect(organisationConnections[name].isInternal, name).toBe(true);
    }
  });
});

describe('who manages an organisation connection (B8)', (): void => {
  it('refuses a manager who is not an administrator to land, rotate or revoke, writing nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sam = harness.withIdentity(SAM);
    expect(await refusalOf(sam.action(api.organisationConnections.land, SLACK))).toBe(
      NOT_AN_ADMINISTRATOR,
    );
    const connectionId = await harness
      .withIdentity(INES)
      .action(api.organisationConnections.land, SLACK);
    const before = await organisationRows(harness);
    expect(
      await refusalOf(
        sam.action(api.organisationConnections.rotate, {
          organisationConnectionId: connectionId,
          secret: 'xoxe.xoxp-2222222222-abcdefghij',
        }),
      ),
    ).toBe(NOT_AN_ADMINISTRATOR);
    expect(
      await refusalOf(
        sam.mutation(api.organisationConnections.revoke, {
          organisationConnectionId: connectionId,
          reason: 'not mine to revoke',
        }),
      ),
    ).toBe(NOT_AN_ADMINISTRATOR);
    expect(await refusalOf(sam.query(api.organisationConnections.listForAdministrator, {}))).toBe(
      NOT_AN_ADMINISTRATOR,
    );
    expect(await organisationRows(harness)).toEqual(before);
  });

  it('refuses an anonymous caller before anything is stored', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await expect(harness.action(api.organisationConnections.land, SLACK)).rejects.toThrow();
    expect((await organisationRows(harness)).credentials).toEqual([]);
  });
});

describe('landing an organisation connection', (): void => {
  it('seals its secrets for the organisation, records who landed it and writes one ledger line', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await harness
      .withIdentity(INES)
      .action(api.organisationConnections.land, SLACK);
    const { connections, ledger, credentials } = await organisationRows(harness);
    expect(connections).toEqual([
      expect.objectContaining({
        _id: connectionId,
        system: 'slack',
        displayName: 'Slack',
        kind: 'slack-configuration',
        mode: 'per-employee',
        scopes: ['chat:write', 'channels:read'],
        providerWorkspaceId: 'T0ACME',
        registeredBy: {
          via: 'organisation-page',
          address: 'ines@acme.test',
          at: expect.any(Number),
        },
        status: 'active',
      }),
    ]);
    const secret = credentials.find((row) => row._id === connections[0].secretCredentialId);
    const refresh = credentials.find((row) => row._id === secret?.refreshCredentialId);
    for (const row of [secret, refresh]) {
      expect(row).toMatchObject({ userId: ORGANISATION_OWNER_KEY, holder: ORGANISATION_HOLDER });
    }
    expect(secret?.label).toBe('Slack configuration token');
    expect(refresh?.label).toBe('Slack configuration refresh token');
    expect(JSON.stringify(credentials)).not.toContain(REFRESH_TOKEN);
    await expect(
      harness.action(internal.credentials.decrypt, { credentialId: refresh!._id }),
    ).resolves.toBe(REFRESH_TOKEN);
    expect(ledger).toEqual([
      expect.objectContaining({
        organisationConnectionId: connectionId,
        type: 'organisation.connection-landed',
        actorAddress: 'ines@acme.test',
        payload: {
          organisationConnectionId: connectionId,
          system: 'slack',
          displayName: 'Slack',
          via: 'organisation-page',
          kind: 'slack-configuration',
          mode: 'per-employee',
          scopes: ['chat:write', 'channels:read'],
        },
      }),
    ]);
    expect(JSON.stringify(ledger)).not.toContain(CONFIGURATION_TOKEN);
  });

  it('lands from the setup verb with no address, as the operator’s CLI', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await harness.action(
      internal.organisationConnections.landFromSetup,
      LINEAR,
    );
    const { connections, ledger } = await organisationRows(harness);
    expect(connections[0]).toMatchObject({
      _id: connectionId,
      registeredBy: { via: 'setup-cli' },
      clientCredentialsScopes: ['read', 'write'],
    });
    expect(connections[0].registeredBy).not.toHaveProperty('address');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).not.toHaveProperty('actorAddress');
    expect(ledger[0].payload).toMatchObject({ via: 'setup-cli' });
  });

  it('keeps one active connection per system, and leaves no secret of a refused second one live', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ines = harness.withIdentity(INES);
    await ines.action(api.organisationConnections.land, LINEAR);
    expect(
      await refusalOf(
        ines.action(api.organisationConnections.land, { ...LINEAR, secret: 'lin_oauth_other_000' }),
      ),
    ).toMatch(/Linear is already connected for the organisation/);
    const { connections, ledger, credentials } = await organisationRows(harness);
    expect(connections).toHaveLength(1);
    expect(ledger).toHaveLength(1);
    expect(credentials.filter((row) => row.revokedAt === undefined)).toHaveLength(1);
  });

  it('refuses a landing that is not one, storing nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ines = harness.withIdentity(INES);
    const landings: Landing[] = [
      { ...SLACK, system: 'Slack' },
      { ...SLACK, displayName: '  ' },
      { ...SLACK, secret: undefined },
      { ...SLACK, scopes: ['chat:write', ' '] },
      { ...SLACK, clientCredentialsScopes: ['chat:write'] },
      { ...LINEAR, mode: 'per-employee' },
      {
        ...LINEAR,
        system: 'mcp:mcp.linear.app',
        kind: 'mcp-client',
        clientCredentialsScopes: undefined,
        clientId: undefined,
      },
      { ...LINEAR, kind: 'mcp-client', clientCredentialsScopes: undefined },
      { ...LINEAR, issuer: 'https://issuer.acme.test' },
    ];
    for (const landing of landings) {
      // refusalOf throws when a landing is accepted, so each one here must be refused.
      expect(await refusalOf(ines.action(api.organisationConnections.land, landing))).toEqual(
        expect.any(String),
      );
    }
    expect(await organisationRows(harness)).toEqual({
      connections: [],
      ledger: [],
      credentials: [],
    });
  });
});

describe("a confidential MCP client names its issuer (the wave 11 review's M12 f)", (): void => {
  const MCP: Landing = {
    system: 'mcp:docs.acme.test',
    displayName: 'Acme docs',
    kind: 'mcp-client',
    mode: 'per-employee',
    scopes: [],
    clientId: 'day0-docs',
  };

  it('refuses a client secret with no issuer, since every card on it would then be refused', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    expect(
      await refusalOf(
        harness
          .withIdentity(INES)
          .action(api.organisationConnections.land, { ...MCP, secret: 'mcp-secret-0123' }),
      ),
    ).toBe(
      "A confidential MCP client needs the issuer of the authorisation server IT registered it with: Day0 sends the secret to that server's token endpoint alone.",
    );
    expect((await organisationRows(harness)).credentials).toEqual([]);
  });

  it('lands a confidential client with its issuer, and a public client without one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ines = harness.withIdentity(INES);
    await ines.action(api.organisationConnections.land, {
      ...MCP,
      secret: 'mcp-secret-0123',
      issuer: 'https://auth.acme.test',
    });
    await ines.action(api.organisationConnections.land, {
      ...MCP,
      system: 'mcp:wiki.acme.test',
      displayName: 'Wiki',
    });
    expect((await organisationRows(harness)).connections).toHaveLength(2);
  });
});

describe('a per-employee OAuth app, which holds no organisation secret (AI5, join 2)', (): void => {
  /** Linear per employee as the setup verb lands it: each employee's own app brings its secret. */
  const PER_EMPLOYEE_LINEAR: Landing = {
    system: 'linear',
    displayName: 'Linear',
    kind: 'oauth-app',
    mode: 'per-employee',
    scopes: ['read', 'write', 'app:assignable'],
    redirectUrl: 'https://day0.acme.test/api/oauth/linear',
  };

  it('lands with no secret and no client id, storing no secret for the organisation', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await harness.action(
      internal.organisationConnections.landFromSetup,
      PER_EMPLOYEE_LINEAR,
    );
    const { connections, ledger, credentials } = await organisationRows(harness);
    expect(connections[0]).toMatchObject({
      _id: connectionId,
      system: 'linear',
      kind: 'oauth-app',
      mode: 'per-employee',
      status: 'active',
    });
    expect(connections[0]).not.toHaveProperty('secretCredentialId');
    expect(connections[0]).not.toHaveProperty('clientId');
    expect(credentials).toEqual([]);
    expect(ledger.map((row) => row.type)).toEqual(['organisation.connection-landed']);
  });

  it('refuses one handed a secret or a client id, which no employee’s app would ever use', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ines = harness.withIdentity(INES);
    for (const landing of [
      { ...PER_EMPLOYEE_LINEAR, secret: CLIENT_SECRET },
      { ...PER_EMPLOYEE_LINEAR, clientId: 'lin-client-1' },
    ]) {
      expect(await refusalOf(ines.action(api.organisationConnections.land, landing))).toBe(
        'A per-employee OAuth app holds no organisation secret or client id: each employee’s own app brings its own.',
      );
    }
    expect((await organisationRows(harness)).credentials).toEqual([]);
  });

  it('refuses a rotation, since there is no organisation secret to rotate', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ines = harness.withIdentity(INES);
    const connectionId = await ines.action(api.organisationConnections.land, PER_EMPLOYEE_LINEAR);
    expect(
      await refusalOf(
        ines.action(api.organisationConnections.rotate, {
          organisationConnectionId: connectionId,
          secret: 'lin_oauth_rotated_0001',
        }),
      ),
    ).toBe(
      'A per-employee OAuth app holds no organisation secret to rotate: each employee’s own app is rotated where it was created.',
    );
    const { connections, credentials } = await organisationRows(harness);
    expect(connections[0]).not.toHaveProperty('secretCredentialId');
    expect(credentials).toEqual([]);
  });
});

describe('rotating and revoking an organisation connection', (): void => {
  it('writes one ledger line for every land, rotate and revoke, in order', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ines = harness.withIdentity(INES);
    const connectionId = await ines.action(api.organisationConnections.land, LINEAR);
    await ines.action(api.organisationConnections.rotate, {
      organisationConnectionId: connectionId,
      secret: 'lin_oauth_rotated_0001',
      scopes: ['read', 'write', 'issues:create'],
    });
    await ines.mutation(api.organisationConnections.revoke, {
      organisationConnectionId: connectionId,
      reason: 'the app was replaced',
    });
    const { ledger } = await organisationRows(harness);
    expect(ledger.map((row) => row.type)).toEqual([
      'organisation.connection-landed',
      'organisation.connection-rotated',
      'organisation.connection-revoked',
    ]);
    expect(ledger.every((row) => row.organisationConnectionId === connectionId)).toBe(true);
    expect(ledger[1].payload).toMatchObject({
      scopes: ['read', 'write', 'issues:create'],
      previousScopes: ['read', 'write'],
    });
    expect(ledger[2].payload).toMatchObject({ reason: 'the app was replaced' });
  });

  it('rotates the secret, revokes the old one and never changes the client-credentials scopes (L2)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ines = harness.withIdentity(INES);
    const connectionId = await ines.action(api.organisationConnections.land, LINEAR);
    const [landed] = (await organisationRows(harness)).connections;
    await ines.action(api.organisationConnections.rotate, {
      organisationConnectionId: connectionId,
      secret: 'lin_oauth_rotated_0001',
      scopes: ['read'],
    });
    const { connections, credentials } = await organisationRows(harness);
    expect(connections[0]).toMatchObject({
      scopes: ['read'],
      clientCredentialsScopes: ['read', 'write'],
      status: 'active',
      lastRotatedAt: expect.any(Number),
    });
    expect(connections[0].secretCredentialId).not.toBe(landed.secretCredentialId);
    const old = credentials.find((row) => row._id === landed.secretCredentialId);
    expect(old?.revokedAt).toEqual(expect.any(Number));
    // An app's client secret has no call that ends it at the vendor, so its value goes at once
    // (the wave 11 review's M6); only an MCP client's waits out its card revocations.
    expect(old?.ciphertext).toBeUndefined();
    await expect(
      harness.action(internal.credentials.decrypt, {
        credentialId: connections[0].secretCredentialId!,
      }),
    ).resolves.toBe('lin_oauth_rotated_0001');
  });

  it('revokes the connection and every secret under it, and frees its system for a new landing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ines = harness.withIdentity(INES);
    const connectionId = await ines.action(api.organisationConnections.land, SLACK);
    await ines.mutation(api.organisationConnections.revoke, {
      organisationConnectionId: connectionId,
      reason: 'the workspace moved',
    });
    const { connections, credentials } = await organisationRows(harness);
    expect(connections[0]).toMatchObject({
      status: 'revoked',
      statusReason: 'the workspace moved',
      revokedAt: expect.any(Number),
    });
    expect(credentials).toHaveLength(2);
    expect(credentials.every((row) => row.revokedAt !== undefined)).toBe(true);
    await expect(
      harness.query(internal.organisationConnections.activeFor, { system: 'slack' }),
    ).resolves.toBeNull();
    expect(
      await refusalOf(
        ines.action(api.organisationConnections.rotate, {
          organisationConnectionId: connectionId,
          secret: 'xoxe.xoxp-3333333333-abcdefghij',
        }),
      ),
    ).toMatch(/revoked/);
    await ines.action(api.organisationConnections.land, SLACK);
    await expect(
      harness.query(internal.organisationConnections.activeFor, { system: 'slack' }),
    ).resolves.toMatchObject({ system: 'slack', status: 'active' });
  });

  it('revokes from the setup verb, its ledger line carrying no address', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await harness.action(
      internal.organisationConnections.landFromSetup,
      LINEAR,
    );
    await harness.action(internal.organisationConnections.rotateFromSetup, {
      organisationConnectionId: connectionId,
      secret: 'lin_oauth_rotated_0002',
    });
    await harness.mutation(internal.organisationConnections.revokeFromSetup, {
      organisationConnectionId: connectionId,
      reason: 'decommissioned',
    });
    const { ledger } = await organisationRows(harness);
    expect(ledger).toHaveLength(3);
    for (const row of ledger) {
      expect(row).not.toHaveProperty('actorAddress');
      expect(row.payload).toMatchObject({ via: 'setup-cli' });
    }
  });
});

describe('what the organisation page and a manager read', (): void => {
  /** An employee of Sam's whose Linear card is on the organisation's connection. */
  async function seedSamsEmployee(
    harness: TestConvex<typeof schema>,
    connectionId: Id<'organisationConnections'>,
  ): Promise<{ agentId: Id<'agents'>; surfaceId: Id<'surfaces'> }> {
    return await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'sam@acme.test',
        name: 'Maya',
        userId: 'sam',
        state: 'deployed',
        createdAt: 1,
      });
      const surfaceId = await ctx.db.insert('surfaces', {
        agentId,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'connected',
        whereFound: [],
        credentialLanded: true,
        endpoint: 'https://api.linear.app/graphql',
        organisationConnectionId: connectionId,
        actsAs: { kind: 'shared-app', label: 'Day0' },
        createdAt: 1,
      });
      return { agentId, surfaceId };
    });
  }

  it('shows the administrator every connection and no employee’s card, nor any secret', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ines = harness.withIdentity(INES);
    const connectionId = await ines.action(api.organisationConnections.land, LINEAR);
    const { agentId, surfaceId } = await seedSamsEmployee(harness, connectionId);
    const listed = await ines.query(api.organisationConnections.listForAdministrator, {});
    expect(listed).toEqual([
      expect.objectContaining({
        _id: connectionId,
        system: 'linear',
        displayName: 'Linear',
        mode: 'shared',
        status: 'active',
        hasSecret: true,
        clientId: 'lin-client-1',
      }),
    ]);
    const text = JSON.stringify(listed);
    for (const hidden of [agentId, surfaceId, 'Maya', 'sam@acme.test', CLIENT_SECRET]) {
      expect(text).not.toContain(hidden);
    }
    expect(listed[0]).not.toHaveProperty('secretCredentialId');
    // The organisation page is the administrator's only way in: the employee stays Sam's.
    expect(await refusalOf(ines.query(api.agents.get, { agentId }))).toBe(EMPLOYEE_NOT_YOURS);
  });

  it('tells a manager which systems are connected for the organisation, never a secret or a revoked one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ines = harness.withIdentity(INES);
    await ines.action(api.organisationConnections.land, LINEAR);
    const slackId = await ines.action(api.organisationConnections.land, SLACK);
    await ines.mutation(api.organisationConnections.revoke, {
      organisationConnectionId: slackId,
      reason: 'moved',
    });
    const summary = await harness
      .withIdentity(SAM)
      .query(api.organisationConnections.summaryForManager, {});
    expect(summary).toEqual({
      callerIsAdministrator: false,
      systems: [
        {
          system: 'linear',
          displayName: 'Linear',
          mode: 'shared',
          status: 'active',
          connectedAt: expect.any(Number),
        },
      ],
    });
    await expect(
      ines.query(api.organisationConnections.summaryForManager, {}),
    ).resolves.toMatchObject({ callerIsAdministrator: true });
  });
});

describe("a manager's deletion and the organisation's connections", (): void => {
  it('never touches the connections, their ledger or the secrets under the reserved key, as SECURITY.md says', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ines = harness.withIdentity(INES);
    await ines.action(api.organisationConnections.land, SLACK);
    const before = await organisationRows(harness);
    // Ines is a manager too: her own deletion, with her documentation unlinked, leaves the organisation's rows.
    await ines.mutation(api.reset.deleteMyData, { alsoUnlinkDocumentation: true });
    await harness
      .withIdentity(SAM)
      .mutation(api.reset.deleteMyData, { alsoUnlinkDocumentation: true });
    expect(await organisationRows(harness)).toEqual(before);
    const security = readFileSync(new URL('../../SECURITY.md', import.meta.url), 'utf8');
    expect(security).toContain(
      "The deletion never touches the organisation's connections (`organisationConnections`), their ledger (`connectionEvents`) or the secrets stored under the organisation's reserved key: they are the organisation's, which only an administrator revokes.",
    );
  });
});

describe('the second pass on landing, rotating and the system key (11-AO review)', (): void => {
  /** One organisation secret stored as a landing would, before anything names it. */
  async function storedSecret(
    harness: TestConvex<typeof schema>,
    plaintext: string,
  ): Promise<Id<'credentials'>> {
    return await harness.action(internal.credentials.store, {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'value',
      label: 'Linear client secret',
      plaintext,
      source: 'entered',
    });
  }

  it('revokes the secrets of a landing the record refuses, when the system was connected since the check', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await harness.action(internal.organisationConnections.landFromSetup, LINEAR);
    const late = await storedSecret(harness, 'lin_oauth_late_000');
    const registration = withoutSecrets(LINEAR);
    await expect(
      harness.mutation(internal.organisationConnections.recordLanded, {
        landing: registration,
        secrets: { secretCredentialId: late },
        registrar: { via: 'setup-cli' },
      }),
    ).resolves.toMatchObject({ recorded: false });
    const row = await harness.run(async (ctx) => await ctx.db.get(late));
    expect(row?.revokedAt).toEqual(expect.any(Number));
  });

  it('revokes the secrets of a rotation the record refuses, when the connection was revoked since', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await harness.action(
      internal.organisationConnections.landFromSetup,
      LINEAR,
    );
    await harness.mutation(internal.organisationConnections.revokeFromSetup, {
      organisationConnectionId: connectionId,
      reason: 'replaced',
    });
    const late = await storedSecret(harness, 'lin_oauth_late_001');
    await expect(
      harness.mutation(internal.organisationConnections.recordRotated, {
        organisationConnectionId: connectionId,
        secrets: { secretCredentialId: late },
        registrar: { via: 'setup-cli' },
      }),
    ).resolves.toMatchObject({ recorded: false });
    const row = await harness.run(async (ctx) => await ctx.db.get(late));
    expect(row?.revokedAt).toEqual(expect.any(Number));
  });

  it('revokes what it stored when one of a landing’s two stores fails, leaving no secret live', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const stored = await storedSecret(harness, 'lin_oauth_half_000');
    const revoked: unknown[] = [];
    const fake = {
      runAction: async (_reference: unknown, args: { label: string }): Promise<unknown> => {
        if (args.label.includes('refresh')) throw new Error('the backend went away');
        return stored;
      },
      runMutation: async (_reference: unknown, args: unknown): Promise<unknown> => {
        revoked.push(args);
        return await harness.mutation(
          internal.organisationConnections.releaseStoredSecrets,
          args as never,
        );
      },
    } as unknown as ActionCtx;
    await expect(
      storeSecrets(fake, SLACK, { secret: 'xoxe.xoxp-1-a', refreshToken: 'xoxe-1-a' }),
    ).rejects.toThrow('the backend went away');
    expect(revoked).toEqual([{ credentialIds: [stored] }]);
    const row = await harness.run(async (ctx) => await ctx.db.get(stored));
    expect(row?.revokedAt).toEqual(expect.any(Number));
  });

  it('refuses a refresh token without the secret it renews', async (): Promise<void> => {
    expect(
      landingRefusal({
        ...LINEAR,
        kind: 'mcp-client',
        system: 'mcp:mcp.acme.test',
        secret: undefined,
        clientCredentialsScopes: undefined,
        refreshToken: 'r-1',
      }),
    ).toMatch(/refresh token renews a secret/);
  });

  it('keeps a system that needs IT’s attention occupied, so no second connection is landed beside it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const connectionId = await harness.action(
      internal.organisationConnections.landFromSetup,
      LINEAR,
    );
    await harness.run(async (ctx) => {
      await ctx.db.patch(connectionId, {
        status: 'needs-attention',
        statusReason: 'secret expired',
      });
    });
    expect(
      await refusalOf(harness.action(internal.organisationConnections.landFromSetup, LINEAR)),
    ).toMatch(/Linear is already connected/);
  });
});

describe('the re-review of the release path and the page reads (11-AO)', (): void => {
  it('revokes the stored secrets when the recording throws, and rethrows its error', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const stored = await harness.action(internal.credentials.store, {
      userId: ORGANISATION_OWNER_KEY,
      holder: ORGANISATION_HOLDER,
      kind: 'value',
      label: 'Linear client secret',
      plaintext: 'lin_oauth_thrown_000',
      source: 'entered',
    });
    const fake = {
      runMutation: async (_reference: unknown, args: unknown): Promise<unknown> =>
        await harness.mutation(
          internal.organisationConnections.releaseStoredSecrets,
          args as never,
        ),
    } as unknown as ActionCtx;
    await expect(
      recordOrRelease(fake, { secretCredentialId: stored }, async (): Promise<never> => {
        throw new ConvexError('the recording refused');
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ConvexError && error.data === 'the recording refused',
    );
    const row = await harness.run(async (ctx) => await ctx.db.get(stored));
    expect(row?.revokedAt).toEqual(expect.any(Number));
  });

  it('keeps the original error when the release itself fails', async (): Promise<void> => {
    const fake = {
      runMutation: async (): Promise<never> => {
        throw new Error('the release failed too');
      },
    } as unknown as ActionCtx;
    vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    await expect(
      recordOrRelease(fake, { secretCredentialId: 'c1' as Id<'credentials'> }, async () => {
        throw new ConvexError('the recording refused');
      }),
    ).rejects.toSatisfy((error: unknown) => error instanceof ConvexError);
  });

  it('never releases a secret a connection already names, as a recording committed before its call failed would', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await harness.action(internal.organisationConnections.landFromSetup, SLACK);
    const [connection] = (await organisationRows(harness)).connections;
    const secret = await harness.run(
      async (ctx) => await ctx.db.get(connection.secretCredentialId!),
    );
    await harness.mutation(internal.organisationConnections.releaseStoredSecrets, {
      credentialIds: [connection.secretCredentialId!, secret!.refreshCredentialId!],
    });
    const { credentials } = await organisationRows(harness);
    expect(credentials.every((row) => row.revokedAt === undefined)).toBe(true);
  });

  it('hands the recording mutation no secret: it refuses a landing that carries one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const withSecret = { ...withoutSecrets(SLACK), secret: SLACK.secret };
    await expect(
      harness.mutation(internal.organisationConnections.recordLanded, {
        landing: withSecret as never,
        secrets: {},
        registrar: { via: 'setup-cli' },
      }),
    ).rejects.toThrow(/secret/);
  });

  it('lists the newest connections when the history passes the read’s bound', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await harness.run(async (ctx) => {
      for (let index = 0; index < 201; index += 1) {
        await ctx.db.insert('organisationConnections', {
          system: 'linear',
          displayName: 'Linear',
          kind: 'oauth-app',
          mode: 'shared',
          scopes: ['read'],
          registeredBy: { via: 'setup-cli', at: index },
          status: 'revoked',
          revokedAt: index,
          createdAt: index,
        });
      }
    });
    await harness.action(internal.organisationConnections.landFromSetup, SLACK);
    const listed = await harness
      .withIdentity(INES)
      .query(api.organisationConnections.listForAdministrator, {});
    expect(listed.some((row) => row.system === 'slack')).toBe(true);
    const summary = await harness
      .withIdentity(SAM)
      .query(api.organisationConnections.summaryForManager, {});
    expect(summary.systems.map((row) => row.system)).toEqual(['slack']);
  });
});
