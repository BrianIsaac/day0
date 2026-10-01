import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  HANDOVER_CREDENTIAL_LOCATION,
  HANDOVER_CUT_REASON,
  handOverSurfaces,
  surfaceHandoverOf,
} from '../../convex/surfaces';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

/** The fields every surface row in these tests shares. */
const SURFACE_BASE: Pick<
  Doc<'surfaces'>,
  'displayName' | 'class' | 'whereFound' | 'credentialLanded' | 'createdAt'
> = {
  displayName: 'Linear',
  class: 'kanban',
  whereFound: [],
  credentialLanded: false,
  createdAt: 1,
};

/** A surface row's fields the decision reads, with no approval and no credential. */
function bareSurface(
  verdict: Doc<'surfaces'>['verdict'],
): Pick<Doc<'surfaces'>, 'verdict' | 'credentialId' | 'provisioning' | 'managerApprovedAt'> {
  return { verdict };
}

describe('the per-surface decision at a handover (D5 (a), A25)', (): void => {
  it("cuts a surface bound to the old owner's credential or a Slack app's client secret", (): void => {
    const credentialId = 'credential' as Id<'credentials'>;
    expect(surfaceHandoverOf({ ...bareSurface('declared'), credentialId })).toBe('cut');
    expect(
      surfaceHandoverOf({
        ...bareSurface('declared'),
        provisioning: { clientSecretCredentialId: credentialId } as Doc<'surfaces'>['provisioning'],
      }),
    ).toBe('cut');
  });

  it('cuts a surface the old manager approved even when no credential is bound yet', (): void => {
    expect(surfaceHandoverOf(bareSurface('approved'))).toBe('cut');
    expect(surfaceHandoverOf({ ...bareSurface('proposed'), managerApprovedAt: 5 })).toBe('cut');
    for (const verdict of ['connected', 'ungranted', 'listed-dead'] as const) {
      expect(surfaceHandoverOf(bareSurface(verdict))).toBe('cut');
    }
  });

  it('carries a surface nothing of the old manager acts through', (): void => {
    for (const verdict of ['declared', 'proposed', 'absent'] as const) {
      expect(surfaceHandoverOf(bareSurface(verdict))).toBe('carry');
    }
  });
});

describe('handOverSurfaces: the cut at a handover (transfer plan 6.3)', (): void => {
  interface Seeded {
    readonly harness: TestConvex<typeof schema>;
    readonly agentId: Id<'agents'>;
    readonly linear: Id<'surfaces'>;
    readonly notion: Id<'surfaces'>;
    readonly token: Id<'credentials'>;
    readonly secret: Id<'credentials'>;
    readonly slack: Id<'surfaces'>;
  }

  /**
   * Seed an employee of `owner` with a connected Linear surface on the owner's credential, a
   * connected Slack surface whose app's client secret the owner holds, and a declared Notion
   * surface, each carrying documentation evidence from the owner's handbook beside the charter's.
   */
  async function seed(): Promise<Seeded> {
    const harness = convexTest(schema, allConvexModules());
    const seeded = await harness.run(async (ctx) => {
      const handbook = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Owner handbook',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const credential = async (label: string): Promise<Id<'credentials'>> =>
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'value',
          label,
          ciphertext: 'sealed',
          iv: 'iv',
          source: 'entered',
          createdAt: 1,
        });
      const token = await credential('Linear service token');
      const secret = await credential('Slack client secret');
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const documentation = {
        kind: 'documentation' as const,
        sourceId: handbook,
        ref: 'linear.md',
        quote: 'The RevOps team triages in Linear with the service token.',
        current: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      };
      const charter = {
        kind: 'charter' as const,
        ref: 'charter',
        quote: 'Work the RevOps queue in Linear.',
        current: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      };
      const linear = await ctx.db.insert('surfaces', {
        ...SURFACE_BASE,
        agentId,
        slug: 'linear',
        path: 'mcp',
        endpoint: 'https://mcp.linear.app/mcp',
        verdict: 'connected',
        managerApprovedAt: 2,
        credentialId: token,
        credentialKind: 'value',
        credentialLocation: 'Ask IT for the token on the Linear page of the handbook.',
        credentialLanded: true,
        managerUserId: 'U-OWNER',
        managerDmChannelId: 'D-OWNER',
        managerName: 'Owner',
        providerIdentityId: 'linear-user',
        providerWorkspaceId: 'linear-workspace',
        approvedToolAllowlist: ['save_comment'],
        toolAllowlistApprovedAt: 3,
        toolAllowlist: ['save_comment'],
        expiresAt: 9,
        accessSetBy: 'approval',
        lastVerifiedAt: 4,
        probeGeneration: 7,
        probeStartedAt: 8,
        discoveryEvidence: [documentation, charter],
        whereFound: [
          { ref: 'manager 1:1', quote: 'Linear is where the queue lives.' },
          { sourceId: String(handbook), ref: 'linear.md', quote: 'Use the service token.' },
        ],
        intakeScope: {
          team: { value: 'REVOPS', sourceId: handbook, ref: 'linear.md', quote: 'Team: REVOPS' },
          channels: [
            { value: '#revops', sourceId: handbook, ref: 'slack.md', quote: 'Channels: #revops' },
            { value: '#deals', ref: 'manager', quote: 'Watch #deals too.' },
          ],
          notes: ['picked at orientation'],
        },
        request: {
          target: { system: 'Linear', chosenPath: 'mcp', reasoning: 'Linear is documented.' },
          evidence: [{ sourceId: String(handbook), ref: 'linear.md', quote: 'Use the token.' }],
          scopeRequested: ['linear:read', 'linear:write'],
          credential: {
            method: 'api-key',
            found: 'value',
            label: 'Linear service token',
            evidenceRef: 'linear.md',
          },
        },
      });
      const slack = await ctx.db.insert('surfaces', {
        ...SURFACE_BASE,
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        path: 'mcp',
        verdict: 'connected',
        managerApprovedAt: 2,
        credentialLanded: true,
        providerBotId: 'B-DAY0',
        provisioning: {
          appId: 'A0DAY0',
          appName: 'Day0',
          clientId: 'client',
          clientSecretCredentialId: secret,
          installUrl: 'https://slack.com/oauth/v2/authorize',
          redirectUrl: 'https://day0.local/api/slack/oauth',
          scopes: ['chat:write'],
          createdAt: 1,
        },
      });
      const notion = await ctx.db.insert('surfaces', {
        ...SURFACE_BASE,
        agentId,
        slug: 'notion',
        displayName: 'Notion',
        class: 'docs',
        verdict: 'declared',
        discoveryEvidence: [documentation],
      });
      const grant = async (scope: string, source: Doc<'permissionGrants'>['source']) =>
        await ctx.db.insert('permissionGrants', { agentId, scope, source, createdAt: 1 });
      await grant('linear:read', 'surface');
      await grant('slack:read', 'surface');
      await grant('linear:write', 'manager');
      await grant('docs:read', 'deploy');
      return { agentId, linear, notion, token, secret, slack };
    });
    return { harness, ...seeded };
  }

  it('returns each surface the old manager connected or approved to proposed, with nothing of theirs left on it', async (): Promise<void> => {
    const { harness, agentId, linear } = await seed();

    await harness.run(
      async (ctx) => await handOverSurfaces(ctx, { agentId, toOwnerKey: 'colleague', now: 50 }),
    );

    const row = await harness.run(async (ctx) => await ctx.db.get(linear));
    expect(row).toMatchObject({
      verdict: 'proposed',
      reason: HANDOVER_CUT_REASON,
      credentialLanded: false,
      probeGeneration: 8,
      path: 'mcp',
      endpoint: 'https://mcp.linear.app/mcp',
    });
    for (const field of [
      'credentialId',
      'credentialKind',
      'credentialLocation',
      'managerApprovedAt',
      'managerUserId',
      'managerDmChannelId',
      'managerName',
      'providerIdentityId',
      'providerWorkspaceId',
      'approvedToolAllowlist',
      'toolAllowlistApprovedAt',
      'toolAllowlist',
      'expiresAt',
      'accessSetBy',
      'lastVerifiedAt',
      'probeStartedAt',
      'provisioning',
    ] as const) {
      expect(row?.[field], field).toBeUndefined();
    }
  });

  it("drops every quote of the old owner's documentation, from every surface, and keeps the charter's", async (): Promise<void> => {
    const { harness, agentId, linear, notion } = await seed();

    await harness.run(
      async (ctx) => await handOverSurfaces(ctx, { agentId, toOwnerKey: 'colleague', now: 50 }),
    );

    const [cut, carried] = await harness.run(
      async (ctx) => await Promise.all([ctx.db.get(linear), ctx.db.get(notion)]),
    );
    expect(cut?.discoveryEvidence?.map((entry) => entry.kind)).toEqual(['charter']);
    expect(cut?.whereFound).toEqual([
      { ref: 'manager 1:1', quote: 'Linear is where the queue lives.' },
    ]);
    expect(cut?.intakeScope).toEqual({
      channels: [{ value: '#deals', ref: 'manager', quote: 'Watch #deals too.' }],
      notes: ['picked at orientation'],
    });
    expect(cut?.request).toEqual({
      target: { system: 'Linear', chosenPath: 'mcp', reasoning: 'Linear is documented.' },
      evidence: [],
      scopeRequested: ['linear:read', 'linear:write'],
      credential: {
        method: 'api-key',
        found: 'location',
        location: HANDOVER_CREDENTIAL_LOCATION,
      },
    });
    expect(carried).toMatchObject({ verdict: 'declared' });
    expect(carried?.discoveryEvidence).toBeUndefined();
  });

  it('revokes the read grants the cut connections gave and keeps every other grant', async (): Promise<void> => {
    const { harness, agentId } = await seed();

    const outcome = await harness.run(
      async (ctx) => await handOverSurfaces(ctx, { agentId, toOwnerKey: 'colleague', now: 50 }),
    );

    expect([...outcome.scopesRevoked].sort()).toEqual(['linear:read', 'slack:read']);
    const grants = await harness.run(async (ctx) =>
      (await ctx.db.query('permissionGrants').collect()).map((grant) => ({
        scope: grant.scope,
        revokedAt: grant.revokedAt,
      })),
    );
    expect(grants).toEqual(
      expect.arrayContaining([
        { scope: 'linear:read', revokedAt: 50 },
        { scope: 'slack:read', revokedAt: 50 },
        { scope: 'linear:write', revokedAt: undefined },
        { scope: 'docs:read', revokedAt: undefined },
      ]),
    );
  });

  it('names each cut surface with the credentials it bound, and asks the new manager for it', async (): Promise<void> => {
    const { harness, agentId, linear, slack, token, secret } = await seed();

    const outcome = await harness.run(
      async (ctx) => await handOverSurfaces(ctx, { agentId, toOwnerKey: 'colleague', now: 50 }),
    );

    expect(
      outcome.cut.map((surface) => ({
        surfaceId: surface.surfaceId,
        slug: surface.slug,
        bound: surface.boundCredentials,
      })),
    ).toEqual(
      expect.arrayContaining([
        { surfaceId: linear, slug: 'linear', bound: [token] },
        { surfaceId: slack, slug: 'slack', bound: [secret] },
      ]),
    );
    expect(outcome.cut).toHaveLength(2);
    const proposed = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect())
        .filter((event) => event.type === 'surface.proposed')
        .map((event) => (event.payload as { surfaceId: string }).surfaceId)
        .sort(),
    );
    expect(proposed).toEqual([linear, slack].sort());
  });
});
