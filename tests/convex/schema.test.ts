import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
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
      const holders = await ctx.db
        .query('skills')
        .withIndex('by_version', (q) => q.eq('versionId', versionId))
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
