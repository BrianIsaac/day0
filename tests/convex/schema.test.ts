import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { DataModel, Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { GenericMutationCtx, WithoutSystemFields } from 'convex/server';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS } from './fakes/manager-identity';

describe('documentation schema', (): void => {
  it('stores owner-level sources, pages and agent source selections', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const result = await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Team folder',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const pageId = await ctx.db.insert('docPages', {
        sourceId,
        ref: 'onboarding.md',
        title: 'Onboarding',
        markdown: '# Onboarding',
        updatedAt: 1,
      });
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'schema test',
        userId: 'owner',
        excludedDocSourceIds: [sourceId],
        state: 'deployed',
        createdAt: 1,
      });
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'linear service token',
        ciphertext: 'ciphertext',
        iv: 'iv',
        source: { sourceId, ref: 'onboarding.md' },
        createdAt: 1,
      });
      return {
        source: await ctx.db.get(sourceId),
        page: await ctx.db.get(pageId),
        agent: await ctx.db.get(agentId),
        credential: await ctx.db.get(credentialId),
      };
    });
    expect(result.source?.kind).toBe('folder');
    expect(result.page?.ref).toBe('onboarding.md');
    expect(result.agent?.excludedDocSourceIds).toEqual([result.source?._id]);
    expect(result.credential?.source).toEqual({
      sourceId: result.source?._id,
      ref: 'onboarding.md',
    });
  });
});

describe('surface connection evidence persistence', (): void => {
  it('retains provider evidence while advancing intake checkpoints monotonically', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const surfaceId = await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Schema behaviour test',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      return await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        whereFound: [],
        managerDmChannelId: 'DMANAGER',
        providerIdentityId: 'UBOT',
        providerWorkspaceId: 'TWORKSPACE',
        toolAllowlist: ['conversations.history'],
        toolArguments: [{ tool: 'conversations.history', arguments: ['channel', 'oldest'] }],
        probeGeneration: 2,
        credentialLanded: true,
        lastVerifiedAt: 100,
        createdAt: 1,
      });
    });

    await harness.mutation(internal.surfaces.recordIntake, {
      surfaceId,
      waterfallPosition: 4,
      polledAt: 200,
    });
    await harness.mutation(internal.surfaces.recordIntake, {
      surfaceId,
      waterfallPosition: 2,
      skipReason: 'temporarily skipped',
      polledAt: 150,
    });

    const surface = await harness.run(
      async (ctx): Promise<Doc<'surfaces'> | null> => await ctx.db.get(surfaceId),
    );
    expect(surface).toMatchObject({
      managerDmChannelId: 'DMANAGER',
      providerIdentityId: 'UBOT',
      providerWorkspaceId: 'TWORKSPACE',
      toolAllowlist: ['conversations.history'],
      toolArguments: [{ tool: 'conversations.history', arguments: ['channel', 'oldest'] }],
      probeGeneration: 2,
      waterfallPosition: 2,
      intakeSkipReason: 'temporarily skipped',
      lastPolledAt: 200,
    });
  });

  it('keeps each approved intake bound with the page line that states it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const stored = await harness.run(async (ctx): Promise<Doc<'surfaces'> | null> => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Schema scope test',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const surfaceId = await ctx.db.insert('surfaces', {
        agentId,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'proposed',
        whereFound: [],
        credentialLanded: false,
        intakeScope: {
          team: { value: 'FIN', ref: 'finance/handbook.md', quote: '- Team: `FIN`' },
          project: {
            value: 'September close',
            ref: 'finance/handbook.md',
            quote: '- Project: `September close`',
          },
        },
        createdAt: 1,
      });
      return await ctx.db.get(surfaceId);
    });
    expect(stored?.intakeScope?.project).toEqual({
      value: 'September close',
      ref: 'finance/handbook.md',
      quote: '- Project: `September close`',
    });

    await expect(
      harness.run(async (ctx): Promise<void> => {
        const agentId = await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Schema scope test',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        });
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'slack',
          displayName: 'Slack',
          class: 'chat',
          verdict: 'proposed',
          whereFound: [],
          credentialLanded: false,
          intakeScope: {
            channels: [{ value: 'finance-close', ref: 'finance/handbook.md' }],
          } as unknown as Doc<'surfaces'>['intakeScope'],
          createdAt: 1,
        });
      }),
    ).rejects.toThrow();
  });
});

describe('exact-action gate schema', (): void => {
  it('stores a pending run with its run id, approved indexes and a surface-targeting skill', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const result = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'gate test',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const runId = await ctx.db.insert('events', {
        agentId,
        type: 'work.execution-claimed',
        payload: {},
        createdAt: 1,
      });
      const workItemId = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
        title: 'Gate',
        contentSummary: 'Gate',
        contentRefs: [],
        state: 'actions-pending',
        pendingRunId: runId,
        approvedIndexes: [0, 2],
        observedAt: 1,
        createdAt: 1,
      });
      const skillId = await ctx.db.insert('skills', {
        agentId,
        name: 'update-linear-ticket',
        description: 'd',
        body: '',
        sourceType: 'agent-authored',
        state: 'proposed',
        targetSurface: 'linear',
        createdAt: 1,
      });
      return { item: await ctx.db.get(workItemId), skill: await ctx.db.get(skillId), runId };
    });
    expect(result.item?.state).toBe('actions-pending');
    expect(result.item?.pendingRunId).toBe(result.runId);
    expect(result.item?.approvedIndexes).toEqual([0, 2]);
    expect(result.skill?.targetSurface).toBe('linear');
  });
});

describe('manager transfer schema', (): void => {
  it('stores a request with its outcome and reads it back by each of its four indexes', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
      });
      const transferId = await ctx.db.insert('managerTransfers', {
        agentId,
        agentName: 'Maya',
        fromOwnerKey: 'owner',
        fromAddress: 'boss@day0.local',
        toAddress: 'lead@day0.local',
        note: 'Maya works the renewals queue.',
        state: 'accepted',
        requestedAt: 10,
        expiresAt: 20,
        decidedAt: 15,
        toOwnerKey: 'lead',
        outcome: {
          workItemsMoved: 3,
          surfacesCut: 1,
          credentialsRevoked: 1,
          credentialsKept: 0,
          scopesRevoked: 2,
          claimsMoved: 1,
          claimsReleased: 1,
          conflictingClaimKeys: ['linear:REVOPS-9'],
          decisionRequestsVoided: 1,
          plansReturned: 1,
          sessionsFailed: 0,
          notesDiscarded: 2,
          mirroredPagesHidden: 4,
          runsStopped: 0,
          charterDiscarded: false,
        },
      });
      const one = async (
        rows: Promise<Array<Doc<'managerTransfers'>>>,
      ): Promise<Id<'managerTransfers'> | undefined> => (await rows)[0]?._id;
      return {
        transferId,
        row: await ctx.db.get(transferId),
        byAgent: await one(
          ctx.db
            .query('managerTransfers')
            .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', 'accepted'))
            .collect(),
        ),
        byAddress: await one(
          ctx.db
            .query('managerTransfers')
            .withIndex('by_to_address_state', (q) =>
              q.eq('toAddress', 'lead@day0.local').eq('state', 'accepted'),
            )
            .collect(),
        ),
        byOwner: await one(
          ctx.db
            .query('managerTransfers')
            .withIndex('by_from_owner_state', (q) =>
              q.eq('fromOwnerKey', 'owner').eq('state', 'accepted'),
            )
            .collect(),
        ),
        byExpiry: await one(
          ctx.db
            .query('managerTransfers')
            .withIndex('by_state_expires', (q) => q.eq('state', 'accepted').lte('expiresAt', 20))
            .collect(),
        ),
      };
    });
    expect(read.row?.outcome?.conflictingClaimKeys).toEqual(['linear:REVOPS-9']);
    expect(read.row?.toOwnerKey).toBe('lead');
    expect([read.byAgent, read.byAddress, read.byOwner, read.byExpiry]).toEqual([
      read.transferId,
      read.transferId,
      read.transferId,
      read.transferId,
    ]);
  });

  it("keeps what an accepting request needs to finish the move later, and the notice's one send", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
      });
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'lead',
        label: 'Lead handbook',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const transferId = await ctx.db.insert('managerTransfers', {
        agentId,
        agentName: 'Maya',
        fromOwnerKey: 'owner',
        fromAddress: MANAGER_ADDRESS,
        toAddress: 'lead@day0.local',
        state: 'accepting',
        requestedAt: 10,
        expiresAt: 20,
        decidedAt: 15,
        toOwnerKey: 'lead',
        toZone: 'Asia/Singapore',
        toExcludedDocSourceIds: [sourceId],
        settleBy: 900,
        noticeSentAt: 11,
        noticeProviderTs: '1759300000.000100',
      });
      const due = await ctx.db
        .query('managerTransfers')
        .withIndex('by_state_settle', (q) => q.eq('state', 'accepting').lte('settleBy', 1_000))
        .collect();
      return { transferId, row: await ctx.db.get(transferId), due: due.map((row) => row._id) };
    });
    expect(read.row).toMatchObject({
      toZone: 'Asia/Singapore',
      noticeSentAt: 11,
      noticeProviderTs: '1759300000.000100',
    });
    expect(read.row?.toExcludedDocSourceIds).toHaveLength(1);
    expect(read.due).toEqual([read.transferId]);
  });

  it('refuses a state the request cannot be in', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await expect(
      harness.run(async (ctx) => {
        const agentId = await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Maya',
          userId: 'owner',
          state: 'deployed',
          createdAt: 1,
        });
        await ctx.db.insert('managerTransfers', {
          agentId,
          agentName: 'Maya',
          fromOwnerKey: 'owner',
          fromAddress: 'boss@day0.local',
          toAddress: 'lead@day0.local',
          state: 'reopened' as Doc<'managerTransfers'>['state'],
          requestedAt: 10,
          expiresAt: 20,
        });
      }),
    ).rejects.toThrow(/got `"reopened"`/);
  });

  it("marks a retire record as a transfer's departure, and an unsent note as discarded, while older rows keep reading", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
      });
      const transferId = await ctx.db.insert('managerTransfers', {
        agentId,
        agentName: 'Maya',
        fromOwnerKey: 'owner',
        fromAddress: 'boss@day0.local',
        toAddress: 'lead@day0.local',
        state: 'asked',
        requestedAt: 10,
        expiresAt: 20,
      });
      const record = {
        userId: 'owner',
        agentId,
        retiredAt: 30,
        rowCounts: {},
        revokedCredentials: 0,
        keptCredentials: 0,
        claims: [],
        rejections: [],
      };
      const departureId = await ctx.db.insert('retirements', {
        ...record,
        kind: 'transferred',
        transferId,
      });
      const olderId = await ctx.db.insert('retirements', record);
      const workItemId = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
        title: 'Note',
        contentSummary: 'Note',
        contentRefs: [],
        state: 'completed',
        observedAt: 1,
        createdAt: 1,
      });
      const noteId = await ctx.db.insert('managerNotes', {
        agentId,
        workItemId,
        kind: 'landed',
        text: 'Landed.',
        createdAt: 1,
        discardedAt: 40,
      });
      return {
        transferId,
        departure: await ctx.db.get(departureId),
        older: await ctx.db.get(olderId),
        note: await ctx.db.get(noteId),
      };
    });
    expect(read.departure?.kind).toBe('transferred');
    expect(read.departure?.transferId).toBe(read.transferId);
    expect(read.older?.kind).toBeUndefined();
    expect(read.note?.discardedAt).toBe(40);
  });
});

describe('skill library schema (10-K, N10: additive and optional)', (): void => {
  it("stores an owner's version and reads it back by shape, by name and version, and by author", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Runbooks',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const versionId = await ctx.db.insert('skillVersions', {
        userId: 'owner',
        name: 'kanban-comment-and-close',
        description: 'Comment on a ticket, then close it.',
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        version: 1,
        body: '# Comment and close',
        smokeTest: 'def run(inputs): return {"actions": []}',
        bodyHash: 'sha256:00',
        requiredScopes: ['linear:write'],
        harnessTools: ['save_comment'],
        harnessToolsBySurface: [
          { slug: 'linear', surfaceClass: 'kanban', tools: ['save_comment'] },
        ],
        targetSurface: 'linear',
        authorAgentId: agentId,
        authorName: 'Priya',
        readRefs: [{ sourceId, ref: 'linear.md', title: 'Linear runbook' }],
        verifiedAt: 2,
        createdAt: 2,
      });
      const byShape = await ctx.db
        .query('skillVersions')
        .withIndex('by_owner_shape', (q) =>
          q.eq('userId', 'owner').eq('surfaceClass', 'kanban').eq('operation', 'comment-and-close'),
        )
        .collect();
      const byName = await ctx.db
        .query('skillVersions')
        .withIndex('by_owner_name_version', (q) =>
          q.eq('userId', 'owner').eq('name', 'kanban-comment-and-close').eq('version', 1),
        )
        .unique();
      const byAuthor = await ctx.db
        .query('skillVersions')
        .withIndex('by_author', (q) => q.eq('authorAgentId', agentId))
        .collect();
      return { versionId, byShape, byName, byAuthor };
    });
    expect(read.byShape.map((row) => row._id)).toEqual([read.versionId]);
    expect(read.byShape[0]?.harnessToolsBySurface).toEqual([
      { slug: 'linear', surfaceClass: 'kanban', tools: ['save_comment'] },
    ]);
    expect(read.byName?._id).toBe(read.versionId);
    expect(read.byAuthor.map((row) => row._id)).toEqual([read.versionId]);
  });

  it('keeps a version registered before the check was kept, with no smoke test and no author', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const version = await harness.run(async (ctx) => {
      const id = await ctx.db.insert('skillVersions', {
        userId: 'owner',
        name: 'kanban-comment-and-close',
        description: 'Comment on a ticket, then close it.',
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        version: 1,
        body: '# Comment and close',
        bodyHash: 'sha256:00',
        requiredScopes: [],
        harnessTools: [],
        authorName: 'Priya',
        readRefs: [],
        verifiedAt: 2,
        createdAt: 2,
      });
      return await ctx.db.get(id);
    });
    expect(version?.smokeTest).toBeUndefined();
    expect(version?.authorAgentId).toBeUndefined();
  });

  it('gives a holder row its version, counts, re-check chip, retirement and revision, and the two new states', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Mateo',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const versionId = await ctx.db.insert('skillVersions', {
        userId: 'owner',
        name: 'kanban-comment-and-close',
        description: 'Comment on a ticket, then close it.',
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        version: 1,
        body: '# Comment and close',
        bodyHash: 'sha256:00',
        requiredScopes: [],
        harnessTools: [],
        authorName: 'Priya',
        readRefs: [],
        verifiedAt: 2,
        createdAt: 2,
      });
      const holder = {
        agentId,
        name: 'kanban-comment-and-close',
        description: 'Comment on a ticket, then close it.',
        body: '# Comment and close',
        sourceType: 'agent-authored' as const,
        createdAt: 3,
      };
      // A row v0.12.0 wrote carries none of the new fields and still reads.
      const olderId = await ctx.db.insert('skills', { ...holder, state: 'registered' });
      const retiredId = await ctx.db.insert('skills', {
        ...holder,
        state: 'retired',
        versionId,
        useCount: 2,
        lastUsedAt: 4,
        authoringAttempts: 1,
        recheckDueAt: 5,
        recheckReason: 'its check was not kept',
        retiredAt: 6,
        retiredReason: 'no longer needed',
        adoptedAt: 3,
      });
      const supersededId = await ctx.db.insert('skills', {
        ...holder,
        state: 'superseded',
        versionId,
      });
      const revisionId = await ctx.db.insert('skills', {
        ...holder,
        body: '',
        state: 'approved',
        revisionOf: supersededId,
      });
      const offeredId = await ctx.db.insert('skills', {
        ...holder,
        body: '',
        state: 'proposed',
        offeredVersionId: versionId,
      });
      // Re-pinned at 12-S3: by_version had no reader and is removed; rows written with no owner
      // key are read under an absent key, as `holdersOf` reads them.
      const holders = await ctx.db
        .query('skills')
        .withIndex('by_owner_version', (q) =>
          q.eq('ownerKey', undefined).eq('versionId', versionId),
        )
        .collect();
      return {
        older: await ctx.db.get(olderId),
        retired: await ctx.db.get(retiredId),
        revision: await ctx.db.get(revisionId),
        offered: await ctx.db.get(offeredId),
        holders: holders.map((row) => row._id),
        retiredId,
        supersededId,
        versionId,
      };
    });
    expect(read.older?.versionId).toBeUndefined();
    expect(read.retired).toMatchObject({ state: 'retired', useCount: 2, retiredAt: 6 });
    expect(read.revision?.revisionOf).toBe(read.supersededId);
    expect(read.offered?.offeredVersionId).toBe(read.versionId);
    expect(read.holders.sort()).toEqual([read.retiredId, read.supersededId].sort());
  });
});

describe('access schema (11-AK, N10: additive and optional)', (): void => {
  /** A Linear app IT registered at install, shared by every employee. */
  const linearApp: WithoutSystemFields<Doc<'organisationConnections'>> = {
    system: 'linear',
    displayName: 'Linear',
    kind: 'oauth-app',
    mode: 'shared',
    clientId: 'lin_client_1234567890',
    appId: 'app-0001',
    providerWorkspaceId: 'org-0001',
    redirectUrl: 'http://localhost:3000/api/oauth/linear',
    scopes: ['read', 'write', 'app:assignable'],
    clientCredentialsScopes: ['read', 'write'],
    registeredBy: { via: 'setup-cli', at: 1 },
    status: 'active',
    createdAt: 1,
  };

  it('stores an organisation connection with its mode and fixed scope set, read by system and status, and its ledger by connection and by time', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const linear = await ctx.db.insert('organisationConnections', linearApp);
      const mcp = await ctx.db.insert('organisationConnections', {
        system: 'mcp:mcp.notion.com',
        displayName: 'Notion',
        kind: 'mcp-client',
        mode: 'per-employee',
        clientId: 'notion-client',
        issuer: 'https://mcp.notion.com',
        resource: 'https://mcp.notion.com/mcp',
        clientRegistration: 'pre-registered',
        authorisationEndpoints: {
          authorisation: 'https://mcp.notion.com/authorize',
          token: 'https://mcp.notion.com/token',
          revocation: 'https://mcp.notion.com/revoke',
          discoveredAt: 2,
        },
        scopes: [],
        registeredBy: { via: 'organisation-page', address: 'ines@day0.local', at: 2 },
        status: 'needs-attention',
        statusReason: 'the client secret expires in 9 days',
        lastRotatedAt: 3,
        createdAt: 2,
      });
      await ctx.db.insert('connectionEvents', {
        organisationConnectionId: linear,
        type: 'organisation.connection-landed',
        payload: { system: 'linear' },
        createdAt: 1,
      });
      await ctx.db.insert('connectionEvents', {
        organisationConnectionId: mcp,
        type: 'organisation.connection-rotated',
        payload: { system: 'mcp:mcp.notion.com' },
        actorAddress: 'ines@day0.local',
        createdAt: 3,
      });
      return {
        activeLinear: await ctx.db
          .query('organisationConnections')
          .withIndex('by_system_status', (q) => q.eq('system', 'linear').eq('status', 'active'))
          .collect(),
        linearLedger: await ctx.db
          .query('connectionEvents')
          .withIndex('by_connection', (q) => q.eq('organisationConnectionId', linear))
          .collect(),
        since: await ctx.db
          .query('connectionEvents')
          .withIndex('by_created', (q) => q.gt('createdAt', 2))
          .collect(),
      };
    });
    expect(read.activeLinear).toEqual([expect.objectContaining(linearApp)]);
    expect(read.linearLedger.map((event) => event.type)).toEqual([
      'organisation.connection-landed',
    ]);
    expect(read.since).toEqual([
      expect.objectContaining({
        type: 'organisation.connection-rotated',
        actorAddress: 'ines@day0.local',
      }),
    ]);
  });

  it('refuses an organisation connection without its mode, and a mode it cannot have', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const modeless = Object.fromEntries(
      Object.entries(linearApp).filter(([field]) => field !== 'mode'),
    );
    await expect(
      harness.run(async (ctx) => {
        await ctx.db.insert(
          'organisationConnections',
          modeless as unknown as Doc<'organisationConnections'>,
        );
      }),
    ).rejects.toThrow(/Missing required field `mode`/);
    await expect(
      harness.run(async (ctx) => {
        await ctx.db.insert('organisationConnections', {
          ...linearApp,
          mode: 'per-team' as Doc<'organisationConnections'>['mode'],
        });
      }),
    ).rejects.toThrow(/got `"per-team"`/);
  });

  it('gives a credential its holder, issuer, expiry, refresh pair, generation, store and revocation at source, read by revocation state; and keeps an older row with none of them', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const connection = await ctx.db.insert('organisationConnections', linearApp);
      const base = { kind: 'oauth', label: 'Linear app token', source: 'oauth' } as const;
      const older = await ctx.db.insert('credentials', {
        ...base,
        userId: 'owner',
        ciphertext: 'sealed',
        iv: 'iv',
        createdAt: 1,
      });
      const refresh = await ctx.db.insert('credentials', {
        ...base,
        userId: 'owner',
        label: 'Linear refresh token',
        ciphertext: 'sealed',
        iv: 'iv',
        issuedBy: { system: 'linear', grant: 'authorisation-code' },
        createdAt: 2,
      });
      const appSecret = await ctx.db.insert('credentials', {
        ...base,
        kind: 'value',
        userId: 'owner',
        label: 'Maya (Day0) client secret',
        ciphertext: 'sealed',
        iv: 'iv',
        createdAt: 2,
      });
      const access = await ctx.db.insert('credentials', {
        ...base,
        userId: 'owner',
        ciphertext: 'sealed',
        iv: 'iv',
        // The app it was issued to outlives the card a retire deletes, for the vendor's call.
        issuedBy: {
          system: 'linear',
          grant: 'authorisation-code',
          appId: 'app-maya',
          clientId: 'lin_client_maya',
          clientSecretCredentialId: appSecret,
        },
        expiresAt: 2 + 24 * 3_600_000,
        refreshCredentialId: refresh,
        generation: 3,
        tokenStore: 'native',
        revokedAt: 10,
        sourceRevocation: {
          state: 'pending',
          attempts: 1,
          lastError: 'HTTP 503',
          at: 11,
          end: 'disconnect',
        },
        createdAt: 2,
      });
      const shared = await ctx.db.insert('credentials', {
        ...base,
        userId: 'day0:organisation',
        holder: 'organisation',
        issuedBy: {
          system: 'linear',
          grant: 'client-credentials',
          organisationConnectionId: connection,
        },
        expiresAt: 30 * 86_400_000,
        tokenStore: 'nango',
        createdAt: 3,
      });
      return {
        older: await ctx.db.get(older),
        access: await ctx.db.get(access),
        shared: await ctx.db.get(shared),
        pending: await ctx.db
          .query('credentials')
          .withIndex('by_source_revocation_state', (q) =>
            q.eq('sourceRevocation.state', 'pending').lt('revokedAt', 11),
          )
          .collect(),
      };
    });
    for (const field of [
      'holder',
      'issuedBy',
      'expiresAt',
      'refreshCredentialId',
      'generation',
      'tokenStore',
      'sourceRevocation',
    ]) {
      expect(read.older, field).not.toHaveProperty(field);
    }
    expect(read.access?.issuedBy).toMatchObject({ appId: 'app-maya', clientId: 'lin_client_maya' });
    expect(read.access?.sourceRevocation).toEqual({
      state: 'pending',
      attempts: 1,
      lastError: 'HTTP 503',
      at: 11,
      end: 'disconnect',
    });
    expect(read.shared).toMatchObject({ holder: 'organisation', tokenStore: 'nango' });
    expect(read.pending.map((row) => row._id)).toEqual([read.access?._id]);
  });

  it('gives a surface its organisation connection, whom it acts as, its access request and its pending authorisation, read by connection; an older card keeps none', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const connection = await ctx.db.insert('organisationConnections', linearApp);
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const clientSecret = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Maya (Day0) client secret',
        source: 'oauth',
        ciphertext: 'sealed',
        iv: 'iv',
        createdAt: 1,
      });
      const card: WithoutSystemFields<Doc<'surfaces'>> = {
        agentId,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'approved',
        whereFound: [],
        credentialLanded: false,
        createdAt: 1,
      };
      const older = await ctx.db.insert('surfaces', { ...card, slug: 'notion' });
      const linked = await ctx.db.insert('surfaces', {
        ...card,
        organisationConnectionId: connection,
        actsAs: { kind: 'shared-app', label: 'Day0', providerIdentityId: 'app-user-1' },
        accessRequest: {
          reason: 'scope-widening',
          scopes: ['write'],
          organisationConnectionId: connection,
          draftedAt: 2,
          copiedAt: 3,
          emailedAt: 4,
          messagedAt: 5,
          messageProviderTs: '1700000000.000100',
        },
        pendingAuthorisation: {
          stateNonce: 'nonce-1',
          stateExpiresAt: 600_002,
          clientId: 'linear-mcp-client',
          verifierCiphertext: 'sealed-verifier',
          verifierIv: 'iv',
          verifierKeyId: 'key-1',
          issuer: 'https://mcp.linear.app',
          resource: 'https://mcp.linear.app/mcp',
          redirectUrl: 'http://localhost:3000/api/oauth/mcp',
          organisationConnectionId: connection,
          startedAt: 2,
        },
        provisioning: {
          appId: 'A0DAY0',
          appName: 'Maya (Day0)',
          clientId: 'client-1',
          clientSecretCredentialId: clientSecret,
          installUrl: 'https://slack.com/oauth/v2/authorize',
          redirectUrl: 'http://localhost:3000/api/oauth/slack',
          scopes: ['chat:write'],
          createdAt: 2,
          organisationConnectionId: connection,
        },
      });
      return {
        older: await ctx.db.get(older),
        onConnection: await ctx.db
          .query('surfaces')
          .withIndex('by_organisation_connection', (q) =>
            q.eq('organisationConnectionId', connection),
          )
          .collect(),
        linked,
      };
    });
    for (const field of [
      'organisationConnectionId',
      'actsAs',
      'accessRequest',
      'pendingAuthorisation',
    ]) {
      expect(read.older, field).not.toHaveProperty(field);
    }
    expect(read.onConnection.map((row) => row._id)).toEqual([read.linked]);
    // The PKCE verifier is sealed in the authorisation's own row, never a credential an owner lists.
    expect(read.onConnection[0]?.pendingAuthorisation).toMatchObject({
      clientId: 'linear-mcp-client',
      verifierCiphertext: 'sealed-verifier',
    });
    expect(read.onConnection[0]?.actsAs).toEqual({
      kind: 'shared-app',
      label: 'Day0',
      providerIdentityId: 'app-user-1',
    });
  });

  it('refuses an identity a card cannot act as', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await expect(
      harness.run(async (ctx) => {
        const agentId = await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Maya',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        });
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'linear',
          displayName: 'Linear',
          class: 'kanban',
          verdict: 'connected',
          whereFound: [],
          credentialLanded: true,
          actsAs: { kind: 'the-manager', label: 'Sam' } as unknown as Doc<'surfaces'>['actsAs'],
          createdAt: 1,
        });
      }),
    ).rejects.toThrow(/got `"the-manager"`/);
  });

  it('ends a handover with its own cancel reason and counts its failed settles', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const transfer = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const id = await ctx.db.insert('managerTransfers', {
        agentId,
        agentName: 'Maya',
        fromOwnerKey: 'owner',
        fromAddress: 'boss@day0.local',
        toAddress: 'lead@day0.local',
        state: 'cancelled',
        cancelReason: 'handover-ended',
        settleFailures: 5,
        requestedAt: 10,
        expiresAt: 20,
      });
      return await ctx.db.get(id);
    });
    expect(transfer).toMatchObject({ cancelReason: 'handover-ended', settleFailures: 5 });
  });
});

describe('the round after wave 11 schema step (R-S, N10: additive and optional)', (): void => {
  it('gives an access token its refresh lease, and keeps an older row with none', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const token = {
        userId: 'day0:organisation',
        kind: 'oauth' as const,
        label: 'Linear access token',
        source: 'oauth' as const,
        ciphertext: 'sealed',
        iv: 'iv',
        createdAt: 1,
      };
      const older = await ctx.db.insert('credentials', token);
      const leased = await ctx.db.insert('credentials', {
        ...token,
        generation: 2,
        refreshingUntil: 90_001,
      });
      return { older: await ctx.db.get(older), leased: await ctx.db.get(leased) };
    });
    expect(read.older).not.toHaveProperty('refreshingUntil');
    expect(read.leased).toMatchObject({ generation: 2, refreshingUntil: 90_001 });
  });

  it("records with a pending authorisation what the issuer's metadata said at its start, and keeps an older one without it", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Maya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const pending = {
        stateNonce: 'nonce-1',
        stateExpiresAt: 600_002,
        clientId: 'mcp-client',
        verifierCiphertext: 'sealed-verifier',
        verifierIv: 'iv',
        issuer: 'https://auth.example.com',
        resource: 'https://mcp.example.com/mcp',
        redirectUrl: 'http://localhost:3000/api/oauth/mcp',
        startedAt: 2,
      };
      const card: WithoutSystemFields<Doc<'surfaces'>> = {
        agentId,
        slug: 'example',
        displayName: 'Example',
        class: 'kanban',
        verdict: 'approved',
        whereFound: [],
        credentialLanded: false,
        createdAt: 1,
      };
      const older = await ctx.db.insert('surfaces', { ...card, pendingAuthorisation: pending });
      const recorded = await ctx.db.insert('surfaces', {
        ...card,
        slug: 'example-2',
        pendingAuthorisation: {
          ...pending,
          issuerMetadata: {
            issParameterSupported: true,
            tokenEndpoint: 'https://auth.example.com/token',
            tokenEndpointAuthMethods: ['client_secret_post'],
          },
        },
      });
      return { older: await ctx.db.get(older), recorded: await ctx.db.get(recorded) };
    });
    expect(read.older?.pendingAuthorisation).not.toHaveProperty('issuerMetadata');
    expect(read.recorded?.pendingAuthorisation?.issuerMetadata).toEqual({
      issParameterSupported: true,
      tokenEndpoint: 'https://auth.example.com/token',
      tokenEndpointAuthMethods: ['client_secret_post'],
    });
  });

  it("gives a skill row its owner's key, read with its version by owner first; an older row keeps none", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Mateo',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const versionId = await ctx.db.insert('skillVersions', {
        userId: 'owner',
        name: 'kanban-comment-and-close',
        description: 'Comment on a ticket, then close it.',
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        version: 1,
        body: '# Comment and close',
        bodyHash: 'sha256:00',
        requiredScopes: [],
        harnessTools: [],
        authorName: 'Mateo',
        readRefs: [],
        verifiedAt: 2,
        createdAt: 2,
      });
      const holder = {
        agentId,
        name: 'kanban-comment-and-close',
        description: 'Comment on a ticket, then close it.',
        body: '# Comment and close',
        sourceType: 'agent-authored' as const,
        state: 'registered' as const,
        versionId,
        createdAt: 3,
      };
      const older = await ctx.db.insert('skills', holder);
      const keyed = await ctx.db.insert('skills', { ...holder, ownerKey: 'owner' });
      await ctx.db.insert('skills', { ...holder, ownerKey: 'another-owner' });
      const holders = await ctx.db
        .query('skills')
        .withIndex('by_owner_version', (q) => q.eq('ownerKey', 'owner').eq('versionId', versionId))
        .collect();
      return { older: await ctx.db.get(older), holders: holders.map((row) => row._id), keyed };
    });
    expect(read.older).not.toHaveProperty('ownerKey');
    expect(read.holders).toEqual([read.keyed]);
  });
});

describe('the wave 12 schema step (12-S3, N10)', (): void => {
  /** The names of a table's indexes, as the push declares them. */
  const indexNames = (table: keyof typeof schema.tables): string[] =>
    schema.tables[table][' indexes']().map((index) => index.indexDescriptor);

  /** An owned employee, the row every test below hangs its rows on. */
  async function employee(ctx: GenericMutationCtx<DataModel>): Promise<Id<'agents'>> {
    return await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
  }

  /** A work item of the employee, with the fields a test gives it. */
  const item = (
    agentId: Id<'agents'>,
    fields: Partial<WithoutSystemFields<Doc<'workItems'>>> = {},
  ): WithoutSystemFields<Doc<'workItems'>> => ({
    agentId,
    sourceCategory: 'ticket',
    sourceSystem: 'linear',
    externalId: 'REVOPS-1',
    title: 'Close the renewal ticket',
    contentSummary: 'Close it.',
    contentRefs: [],
    state: 'failed',
    observedAt: 1,
    createdAt: 1,
    ...fields,
  });

  it('pauses an employee with who paused it, when and why, and keeps an older row unpaused (12-P)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const older = await employee(ctx);
      const paused = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Mateo',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
        pausedAt: 2,
        pausedBy: 'owner',
        pauseReason: 'Quarter close',
      });
      return { older: await ctx.db.get(older), paused: await ctx.db.get(paused) };
    });
    expect(read.older).not.toHaveProperty('pausedAt');
    expect(read.paused).toMatchObject({
      pausedAt: 2,
      pausedBy: 'owner',
      pauseReason: 'Quarter close',
    });
  });

  it("gives a work item its waiting stamp, its step's scheduled job and per-entry reconciliation answers; an older row keeps none (12-W)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const agentId = await employee(ctx);
      const jobId = await ctx.scheduler.runAfter(60_000, internal.migrations.runPending, {});
      const entry = {
        phase: 'single' as const,
        actionIndex: 0,
        tool: 'linear.save_comment',
        outcome: 'outcome-unknown' as const,
      };
      const older = await ctx.db.insert(
        'workItems',
        item(agentId, {
          providerReconciliation: { actor: 'owner', confirmedAt: 3, entries: [entry] },
        }),
      );
      const stamped = await ctx.db.insert(
        'workItems',
        item(agentId, {
          externalId: 'REVOPS-2',
          state: 'plan-pending',
          waitingSince: 4,
          stepJobId: jobId,
          providerReconciliation: {
            actor: 'owner',
            confirmedAt: 3,
            entries: [
              { ...entry, answer: 'landed' },
              { ...entry, actionIndex: 1, answer: 'not-sent' },
            ],
          },
        }),
      );
      return { older: await ctx.db.get(older), stamped: await ctx.db.get(stamped), jobId };
    });
    expect(read.older).not.toHaveProperty('waitingSince');
    expect(read.older?.providerReconciliation?.entries[0]).not.toHaveProperty('answer');
    expect(read.stamped).toMatchObject({ waitingSince: 4, stepJobId: read.jobId });
    expect(read.stamped?.providerReconciliation?.entries.map((row) => row.answer)).toEqual([
      'landed',
      'not-sent',
    ]);
  });

  it('refuses a reconciliation answer the card does not offer', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await expect(
      harness.run(async (ctx) => {
        const agentId = await employee(ctx);
        await ctx.db.insert(
          'workItems',
          item(agentId, {
            providerReconciliation: {
              actor: 'owner',
              confirmedAt: 3,
              entries: [
                {
                  phase: 'single',
                  actionIndex: 0,
                  tool: 'linear.save_comment',
                  outcome: 'outcome-unknown',
                  answer: 'maybe' as 'landed',
                },
              ],
            },
          }),
        );
      }),
    ).rejects.toThrow();
  });

  it("records a decision request's buttons and its close's result, and reads open claims by employee (12-W, 12-M)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const agentId = await employee(ctx);
      const decision = {
        id: 'abc234',
        kind: 'plan' as const,
        requestedAt: 2,
        channel: 'D0123',
        surfaceSlug: 'slack',
        surfaceName: 'Slack',
        ts: '1700000000.000100',
        decidedAt: 3,
        outcome: 'approved' as const,
        withButtons: true,
      };
      const closing = await ctx.db.insert(
        'workItems',
        item(agentId, { decision: { ...decision, closeClaimedAt: 4 } }),
      );
      const closed = await ctx.db.insert(
        'workItems',
        item(agentId, {
          externalId: 'REVOPS-2',
          decision: { ...decision, id: 'abc235', closeClaimedAt: 4, closedAt: 5 },
        }),
      );
      const failed = await ctx.db.insert(
        'workItems',
        item(agentId, {
          externalId: 'REVOPS-3',
          decision: {
            ...decision,
            id: 'abc236',
            closeClaimedAt: 4,
            closeFailure: 'message_not_found',
          },
        }),
      );
      const noticing = await ctx.db.insert(
        'workItems',
        item(agentId, {
          externalId: 'REVOPS-4',
          decision: { ...decision, id: 'abc237', duplicateNoticeClaimedAt: 6 },
        }),
      );
      const openCloses = await ctx.db
        .query('workItems')
        .withIndex('by_agent_close_open', (q) =>
          q
            .eq('agentId', agentId)
            .eq('decision.closedAt', undefined)
            .eq('decision.closeFailure', undefined)
            .gt('decision.closeClaimedAt', 0),
        )
        .collect();
      const openNotices = await ctx.db
        .query('workItems')
        .withIndex('by_agent_duplicate_notice_open', (q) =>
          q
            .eq('agentId', agentId)
            .eq('decision.duplicateNoticeTs', undefined)
            .eq('decision.duplicateNoticeFailure', undefined)
            .gt('decision.duplicateNoticeClaimedAt', 0),
        )
        .collect();
      return {
        closed: await ctx.db.get(closed),
        failed: await ctx.db.get(failed),
        openCloses: openCloses.map((row) => row._id),
        openNotices: openNotices.map((row) => row._id),
        closing,
        noticing,
      };
    });
    expect(read.closed?.decision).toMatchObject({ withButtons: true, closedAt: 5 });
    expect(read.failed?.decision?.closeFailure).toBe('message_not_found');
    expect(read.openCloses).toEqual([read.closing]);
    expect(read.openNotices).toEqual([read.noticing]);
  });

  it('reads the unsent claims of manager notes and decision notices by employee, and takes a replaced notice (12-W, 12-M)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const agentId = await employee(ctx);
      const workItemId = await ctx.db.insert('workItems', item(agentId));
      const note = { agentId, workItemId, kind: 'landed' as const, text: 'Done.', createdAt: 1 };
      const claimedNote = await ctx.db.insert('managerNotes', { ...note, claimedAt: 2 });
      await ctx.db.insert('managerNotes', { ...note, claimedAt: 2, providerTs: '1.1' });
      await ctx.db.insert('managerNotes', { ...note, claimedAt: 2, failure: 'not sent' });
      await ctx.db.insert('managerNotes', { ...note, claimedAt: 2, discardedAt: 3 });
      await ctx.db.insert('managerNotes', note);
      const surfaceId = await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        whereFound: [],
        credentialLanded: true,
        createdAt: 1,
      });
      const notice = {
        agentId,
        surfaceId,
        workItemId,
        decisionId: 'abc234',
        messageTs: '1.2',
        kind: 'replaced' as const,
        text: 'That request was replaced by abc235.',
        createdAt: 1,
      };
      const claimedNotice = await ctx.db.insert('managerDecisionNotices', {
        ...notice,
        claimedAt: 2,
      });
      await ctx.db.insert('managerDecisionNotices', {
        ...notice,
        messageTs: '1.3',
        claimedAt: 2,
        providerTs: '1.4',
      });
      const notes = await ctx.db
        .query('managerNotes')
        .withIndex('by_agent_claim_open', (q) =>
          q
            .eq('agentId', agentId)
            .eq('providerTs', undefined)
            .eq('failure', undefined)
            .eq('discardedAt', undefined)
            .gt('claimedAt', 0)
            .lt('claimedAt', 3),
        )
        .collect();
      const notices = await ctx.db
        .query('managerDecisionNotices')
        .withIndex('by_agent_claim_open', (q) =>
          q
            .eq('agentId', agentId)
            .eq('providerTs', undefined)
            .eq('failure', undefined)
            .gt('claimedAt', 0),
        )
        .collect();
      return {
        notes: notes.map((row) => row._id),
        notices: notices.map((row) => row._id),
        claimedNote,
        claimedNotice,
      };
    });
    expect(read.notes).toEqual([read.claimedNote]);
    expect(read.notices).toEqual([read.claimedNotice]);
  });

  it("remembers a replaced decision request by its code, with the code that replaced it and its edit's claim (12-M, F2 D14)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const agentId = await employee(ctx);
      const workItemId = await ctx.db.insert('workItems', item(agentId, { state: 'claimed' }));
      const replaced = {
        agentId,
        workItemId,
        decisionId: 'abc234',
        kind: 'plan' as const,
        surfaceSlug: 'slack',
        channel: 'D0123',
        replacedAt: 5,
      };
      const delivered = await ctx.db.insert('replacedDecisionRequests', {
        ...replaced,
        replacedBy: 'abc235',
        ts: '1700000000.000100',
        requestText: 'Approve the plan? Reply approve abc234.',
        withButtons: true,
        editClaimedAt: 6,
      });
      await ctx.db.insert('replacedDecisionRequests', {
        ...replaced,
        decisionId: 'abc233',
        editClaimedAt: 6,
        editedAt: 7,
      });
      const byCode = await ctx.db
        .query('replacedDecisionRequests')
        .withIndex('by_agent_decision', (q) => q.eq('agentId', agentId).eq('decisionId', 'abc234'))
        .unique();
      const ofItem = await ctx.db
        .query('replacedDecisionRequests')
        .withIndex('by_work_item', (q) => q.eq('workItemId', workItemId))
        .collect();
      const openEdits = await ctx.db
        .query('replacedDecisionRequests')
        .withIndex('by_agent_edit_open', (q) =>
          q
            .eq('agentId', agentId)
            .eq('editedAt', undefined)
            .eq('editFailure', undefined)
            .gt('editClaimedAt', 0),
        )
        .collect();
      return {
        byCode,
        ofItem: ofItem.length,
        openEdits: openEdits.map((row) => row._id),
        delivered,
      };
    });
    expect(read.byCode).toMatchObject({ replacedBy: 'abc235', withButtons: true });
    expect(read.ofItem).toBe(2);
    expect(read.openEdits).toEqual([read.delivered]);
  });

  it('gives a provisioned app its app-level token and a kept card its marker; an older card keeps neither (12-M, m16)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const agentId = await employee(ctx);
      const credential = {
        userId: 'day0:organisation',
        kind: 'oauth' as const,
        label: 'Priya app client secret',
        source: 'oauth' as const,
        createdAt: 1,
      };
      const secret = await ctx.db.insert('credentials', credential);
      const token = await ctx.db.insert('credentials', {
        ...credential,
        kind: 'value',
        label: 'Priya app-level token',
        source: 'entered',
      });
      const provisioning = {
        appId: 'A0123',
        appName: 'Day0 Priya',
        clientId: '123.456',
        clientSecretCredentialId: secret,
        installUrl: 'https://slack.com/oauth/v2/authorize',
        redirectUrl: 'http://localhost:3000/api/oauth/slack',
        scopes: ['chat:write'],
        createdAt: 1,
      };
      const card = {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat' as const,
        verdict: 'proposed' as const,
        whereFound: [],
        credentialLanded: false,
        createdAt: 1,
      };
      const older = await ctx.db.insert('surfaces', { ...card, provisioning });
      const recorded = await ctx.db.insert('surfaces', {
        ...card,
        slug: 'slack-2',
        provisioning: { ...provisioning, appLevelTokenCredentialId: token },
        keptIdentitySince: 8,
      });
      return { older: await ctx.db.get(older), recorded: await ctx.db.get(recorded), token };
    });
    expect(read.older?.provisioning).not.toHaveProperty('appLevelTokenCredentialId');
    expect(read.older).not.toHaveProperty('keptIdentitySince');
    expect(read.recorded?.provisioning?.appLevelTokenCredentialId).toBe(read.token);
    expect(read.recorded?.keptIdentitySince).toBe(8);
  });

  it("gives a skill its waiting stamp, and reads an employee's events by when they happened (12-W)", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const read = await harness.run(async (ctx) => {
      const agentId = await employee(ctx);
      const skill = await ctx.db.insert('skills', {
        agentId,
        name: 'kanban-comment-and-close',
        description: 'Comment on a ticket, then close it.',
        body: '',
        sourceType: 'agent-authored',
        state: 'proposed',
        createdAt: 1,
        waitingSince: 2,
      });
      for (const createdAt of [30, 10, 20]) {
        await ctx.db.insert('events', { agentId, type: 'work.retry', payload: {}, createdAt });
      }
      const events = await ctx.db
        .query('events')
        .withIndex('by_agent_created', (q) => q.eq('agentId', agentId).gte('createdAt', 15))
        .order('desc')
        .collect();
      return { skill: await ctx.db.get(skill), times: events.map((event) => event.createdAt) };
    });
    expect(read.skill?.waitingSince).toBe(2);
    expect(read.times).toEqual([30, 20]);
  });

  it('removes the two indexes nothing reads: agents.by_bossEmail and skills.by_version', (): void => {
    expect(indexNames('agents')).not.toContain('by_bossEmail');
    expect(indexNames('agents')).toContain('by_userId');
    expect(indexNames('skills')).not.toContain('by_version');
    expect(indexNames('skills')).toContain('by_owner_version');
  });
});
