import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  HANDOVER_CREDENTIAL_LOCATION,
  HANDOVER_CUT_REASON,
  HANDOVER_CUT_REPROPOSE_REASON,
  handOverSurfaces,
  surfaceHandoversOf,
} from '../../convex/surfaces';
import { LINEAR_MCP_ENDPOINT } from '../../src/surfaces/fixed-endpoints';
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

describe('the bound on one handover’s surfaces', (): void => {
  it('refuses, in words a dialog can show, an employee with more surfaces than a handover reads', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      for (let index = 0; index <= 1_000; index += 1) {
        await ctx.db.insert('surfaces', {
          ...SURFACE_BASE,
          agentId,
          slug: `system-${index}`,
          verdict: 'declared',
        });
      }
      return agentId;
    });
    await expect(
      harness.run(async (ctx) => await surfaceHandoversOf(ctx.db, agentId)),
    ).rejects.toMatchObject({ data: expect.stringContaining('more than 1000 connections') });
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
        endpoint: LINEAR_MCP_ENDPOINT,
        pathCandidates: [
          { path: 'mcp', endpoint: LINEAR_MCP_ENDPOINT },
          { path: 'documented-api', endpoint: 'https://acme-fin.linear.app/api' },
        ],
        probeAttempts: [
          {
            path: 'mcp',
            endpoint: LINEAR_MCP_ENDPOINT,
            outcome: 'ungranted',
            reason: 'credential not in the docs; ask Priya Nair for the vault Finance Ops',
            attemptedAt: 3,
          },
        ],
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
          target: {
            system: 'Linear',
            chosenPath: 'mcp',
            reasoning: 'Documentation states journals over $50k need Tom Reyes (CFO).',
            ladder: [{ path: 'mcp', endpoint: LINEAR_MCP_ENDPOINT }],
          },
          evidence: [{ sourceId: String(handbook), ref: 'linear.md', quote: 'Use the token.' }],
          openQuestions: ['Tom Reyes signs journals over $50k; confirm before approving.'],
          blastRadius: 'Comments on the Finance Ops board.',
          rollback: 'Ask Priya Nair to rotate the token.',
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
        path: 'documented-api',
        endpoint: 'https://slack.com/api/',
        pathCandidates: [{ path: 'documented-api', endpoint: 'https://slack.com/api/' }],
        probeAttempts: [
          {
            path: 'documented-api',
            endpoint: 'https://slack.com/api/',
            outcome: 'ungranted',
            reason:
              'the manager email sam@company.com is not a member of this Slack workspace (users_not_found).',
            attemptedAt: 3,
          },
        ],
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
        verdict: 'proposed',
        reason: 'Rejected once: Priya Nair says not this quarter.',
        path: 'mcp',
        endpoint: 'https://acme-fin.notion.site/mcp',
        pathCandidates: [{ path: 'mcp', endpoint: 'https://acme-fin.notion.site/mcp' }],
        intakeScope: {
          project: {
            value: 'Finance Ops',
            sourceId: handbook,
            ref: 'notion.md',
            quote: 'Finance Ops',
          },
          notes: ['Priya Nair keeps the Finance Ops wiki'],
        },
        credentialLocation:
          'the Notion API key lives in the 1Password vault Finance Ops, ask Priya Nair',
        discoveryEvidence: [documentation],
        request: {
          target: {
            system: 'Notion',
            chosenPath: 'mcp',
            reasoning: 'The handbook says Priya Nair owns the Notion workspace.',
          },
          evidence: [{ sourceId: String(handbook), ref: 'notion.md', quote: 'Notion via MCP.' }],
          openQuestions: ['Priya Nair approves new integrations.'],
          blastRadius: 'Reads the Finance Ops wiki.',
          rollback: 'Priya Nair removes the integration.',
          scopeRequested: ['notion:read'],
        },
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
      // The address Day0 fixes itself stays, with only its own rung of the ladder.
      endpoint: LINEAR_MCP_ENDPOINT,
      pathCandidates: [{ path: 'mcp', endpoint: LINEAR_MCP_ENDPOINT }],
    });
    for (const field of [
      'probeAttempts',
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
    // The scope's notes were drafted from the departed pages, so they go with them.
    expect(cut?.intakeScope).toEqual({
      channels: [{ value: '#deals', ref: 'manager', quote: 'Watch #deals too.' }],
    });
    expect(cut?.request).toEqual({
      target: { system: 'Linear', chosenPath: 'mcp' },
      evidence: [],
      scopeRequested: ['linear:read', 'linear:write'],
      credential: {
        method: 'api-key',
        found: 'location',
        location: HANDOVER_CREDENTIAL_LOCATION,
      },
    });
    expect(carried).toMatchObject({ verdict: 'proposed' });
    expect(carried?.discoveryEvidence).toBeUndefined();
  });

  it("clears a cut card's probe history and the documented address its old owner's pages gave", async (): Promise<void> => {
    const { harness, agentId } = await seed();
    const salesforce = await harness.run(
      async (ctx) =>
        await ctx.db.insert('surfaces', {
          ...SURFACE_BASE,
          agentId,
          slug: 'salesforce',
          displayName: 'Salesforce',
          class: 'crm',
          verdict: 'approved',
          managerApprovedAt: 2,
          path: 'documented-api',
          endpoint: 'https://acme-fin.my.salesforce.com/services/data/',
          pathCandidates: [
            {
              path: 'documented-api',
              endpoint: 'https://acme-fin.my.salesforce.com/services/data/',
            },
          ],
          probeAttempts: [
            {
              path: 'documented-api',
              outcome: 'ungranted',
              reason: 'credential not in the docs; ask Priya Nair for the vault Finance Ops',
              attemptedAt: 3,
            },
          ],
          request: {
            target: {
              system: 'Salesforce',
              chosenPath: 'documented-api',
              reasoning: 'Documentation states journals over $50k need Tom Reyes (CFO).',
            },
            evidence: [{ sourceId: 'gone-source', ref: 'crm.md', quote: 'Use the REST API.' }],
          },
        }),
    );

    await harness.run(
      async (ctx) => await handOverSurfaces(ctx, { agentId, toOwnerKey: 'colleague', now: 50 }),
    );

    const row = await harness.run(async (ctx) => await ctx.db.get(salesforce));
    expect(row).toMatchObject({ verdict: 'proposed', reason: HANDOVER_CUT_REPROPOSE_REASON });
    expect(row?.probeAttempts).toBeUndefined();
    expect(row?.endpoint).toBeUndefined();
    expect(row?.pathCandidates).toBeUndefined();
    expect(JSON.stringify(row)).not.toMatch(/acme-fin|Priya|Tom Reyes/);
  });

  it("keeps a cut chat card on Slack's own Web API base, which is no owner's documentation", async (): Promise<void> => {
    const { harness, agentId, slack } = await seed();

    await harness.run(
      async (ctx) => await handOverSurfaces(ctx, { agentId, toOwnerKey: 'colleague', now: 50 }),
    );

    const row = await harness.run(async (ctx) => await ctx.db.get(slack));
    expect(row).toMatchObject({
      reason: HANDOVER_CUT_REASON,
      path: 'documented-api',
      endpoint: 'https://slack.com/api/',
      pathCandidates: [{ path: 'documented-api', endpoint: 'https://slack.com/api/' }],
    });
    expect(row?.probeAttempts).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('sam@company.com');
  });

  it("strips a carried card's credential location and the prose drafted from the old owner's pages", async (): Promise<void> => {
    const { harness, agentId, notion } = await seed();

    await harness.run(
      async (ctx) => await handOverSurfaces(ctx, { agentId, toOwnerKey: 'colleague', now: 50 }),
    );

    const row = await harness.run(async (ctx) => await ctx.db.get(notion));
    expect(row?.credentialLocation).toBeUndefined();
    expect(row?.reason).toBeUndefined();
    expect(row?.endpoint).toBeUndefined();
    expect(row?.pathCandidates).toBeUndefined();
    expect(row?.intakeScope).toEqual({});
    expect(row?.request).toEqual({
      target: { system: 'Notion', chosenPath: 'mcp' },
      evidence: [],
      scopeRequested: ['notion:read'],
    });
    expect(JSON.stringify(row)).not.toContain('Priya');
  });

  it("keeps a request's prose when every quote it was drawn from is one the new owner holds", async (): Promise<void> => {
    const { harness, agentId, notion } = await seed();
    const shared = await harness.run(async (ctx) => {
      const handbook = await ctx.db.insert('docSources', {
        userId: 'colleague',
        label: 'Colleague handbook',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const request = {
        target: { system: 'Notion', chosenPath: 'mcp', reasoning: 'Notion is documented.' },
        evidence: [{ sourceId: String(handbook), ref: 'notion.md', quote: 'Notion via MCP.' }],
        openQuestions: ['Confirm the workspace.'],
      };
      await ctx.db.patch(notion, { request });
      return request;
    });

    await harness.run(
      async (ctx) => await handOverSurfaces(ctx, { agentId, toOwnerKey: 'colleague', now: 50 }),
    );

    const row = await harness.run(async (ctx) => await ctx.db.get(notion));
    expect(row?.request).toEqual(shared);
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
