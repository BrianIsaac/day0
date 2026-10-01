import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import {
  assembleTrace,
  ownerKeyDigest,
  type AgentTrace,
  type TracePage,
} from '../../src/export/trace';
import { EVENT_TYPES } from '../../src/events/contract';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

/** The whole trace of one agent, assembled from the paged export as the command line assembles it. */
async function exportedTrace(
  caller: { action: TestConvex<typeof schema>['action'] },
  agentId: Id<'agents'>,
  pages: TracePage[] = [],
): Promise<AgentTrace> {
  const { api } = await import('../../convex/_generated/api');
  return await assembleTrace(agentId, {
    head: async () => await caller.action(api.exportActions.exportForAgent, { agentId }),
    page: async (request) => {
      const page = await caller.action(api.exportActions.exportPage, {
        agentId,
        section: request.page.section,
        cursor: request.page.cursor,
      });
      pages.push(page);
      return page;
    },
  });
}

async function seedTracedAgent(harness: TestConvex<typeof schema>): Promise<Id<'agents'>> {
  return await harness.run(async (ctx): Promise<Id<'agents'>> => {
    const id = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      zone: 'Asia/Singapore',
      mode: 'real',
      createdAt: 1,
    });
    const credentialId = await ctx.db.insert('credentials', {
      userId: 'owner',
      kind: 'value',
      label: 'Linear service token',
      ciphertext: 'TOP-SECRET-CIPHERTEXT',
      iv: 'TOP-SECRET-IV',
      source: 'entered',
      createdAt: 1,
    });
    await ctx.db.insert('surfaces', {
      agentId: id,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'connected',
      whereFound: [],
      path: 'mcp',
      endpoint: 'https://mcp.linear.app/mcp',
      credentialId,
      credentialLanded: true,
      lastVerifiedAt: 1,
      createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId: id,
      version: '1.0',
      body: { whyThisHire: 'Keep the revenue queue moving.' },
      approved: true,
      approvedAt: 2,
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId: id,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-1',
      title: 'Close the loop',
      contentSummary: 'Synthetic evaluation work.',
      contentRefs: [],
      state: 'completed',
      observedAt: 1,
      createdAt: 1,
    });
    const output = {
      applied: [
        {
          tool: 'mcp.call',
          ok: true,
          authority: 'manager',
          effect: 'Commented on REVOPS-1',
          idempotencyKey: `${workItemId}:run-1:0`,
        },
      ],
    };
    await ctx.db.patch(workItemId, { output });
    await ctx.db.insert('events', {
      agentId: id,
      type: 'work.completed',
      payload: { workItemId, output },
      createdAt: 2,
    });
    await ctx.db.insert('events', {
      agentId: id,
      type: 'permission.revoked',
      payload: { scope: 'linear:read', by: 'manager' },
      createdAt: 3,
    });
    return id;
  });
}

describe('the paged trace export', (): void => {
  afterEach((): void => {
    vi.useRealTimers();
  });

  it('heads the trace with its format, the release and commit, and the export’s date in the agent’s zone', async (): Promise<void> => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 8, 27, 17, 0));
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedTracedAgent(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('deploymentVersions', {
        release: '0.4.0',
        commit: 'd71b1cf8',
        recordedAt: 1,
      });
    });
    const { api } = await import('../../convex/_generated/api');
    const head = await harness
      .withIdentity(managerIdentity())
      .action(api.exportActions.exportForAgent, { agentId });
    expect(head.manifest).toEqual({
      format: 'day0-trace',
      version: 4,
      exportedAt: Date.UTC(2026, 8, 27, 17, 0),
      exportedOn: '2026-09-28',
      zone: 'Asia/Singapore',
      release: '0.4.0',
      commit: 'd71b1cf8',
      pageRows: 100,
      eventTypes: [...EVENT_TYPES],
      handovers: [],
    });
    expect(head.agent).toMatchObject({
      id: agentId,
      name: 'Priya',
      mode: 'real',
      zone: 'Asia/Singapore',
      evaluation: false,
    });
    expect(head.next).toEqual({ section: 'charters', cursor: null });
    expect(head.credentialNames).toEqual([{ label: 'Linear service token' }]);
    expect(JSON.stringify(head)).not.toContain('boss@day0.local');
  });

  it('carries the employee’s accepted handovers in its manifest, oldest first, for a recompute to cut by tenure (the v0.12.0 walk)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedTracedAgent(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { userId: 'wei' });
      const request = {
        agentId,
        agentName: 'Priya',
        fromAddress: MANAGER_ADDRESS,
        toAddress: 'lead@day0.local',
        requestedAt: 1_000,
        expiresAt: 1_000 + 14 * 24 * 60 * 60 * 1000,
      };
      await ctx.db.insert('managerTransfers', {
        ...request,
        fromOwnerKey: 'priya',
        toOwnerKey: 'wei',
        state: 'accepted',
        decidedAt: 9_000,
      });
      await ctx.db.insert('managerTransfers', {
        ...request,
        fromOwnerKey: 'owner',
        toOwnerKey: 'priya',
        state: 'accepted',
        decidedAt: 5_000,
      });
      await ctx.db.insert('managerTransfers', {
        ...request,
        fromOwnerKey: 'wei',
        state: 'declined',
        decidedAt: 10_000,
      });
    });
    const trace = await exportedTrace(harness.withIdentity(managerIdentity('wei')), agentId);
    // Re-pinned (decision 2, M6): each owner key as its digest, salted with the export's time.
    const digest = (key: string): string => ownerKeyDigest(key, trace.manifest.exportedAt);
    expect(trace.manifest.handovers).toEqual([
      {
        agentId,
        fromOwnerDigest: digest('owner'),
        toOwnerDigest: digest('priya'),
        acceptedAt: 5_000,
      },
      {
        agentId,
        fromOwnerDigest: digest('priya'),
        toOwnerDigest: digest('wei'),
        acceptedAt: 9_000,
      },
    ]);
  });

  it('names no earlier manager’s account in its manifest: each handover carries digests of the two owner keys, salted with the export’s time (decision 2, the wave 10 review, M6)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedTracedAgent(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { userId: 'user_present_holder' });
      await ctx.db.insert('managerTransfers', {
        agentId,
        agentName: 'Priya',
        fromAddress: MANAGER_ADDRESS,
        toAddress: 'lead@day0.local',
        requestedAt: 1_000,
        expiresAt: 1_000 + 14 * 24 * 60 * 60 * 1000,
        fromOwnerKey: 'user_earlier_manager',
        toOwnerKey: 'user_present_holder',
        state: 'accepted',
        decidedAt: 5_000,
      });
    });

    const trace = await exportedTrace(
      harness.withIdentity(managerIdentity('user_present_holder')),
      agentId,
    );

    expect(JSON.stringify(trace.manifest)).not.toContain('user_earlier_manager');
    expect(JSON.stringify(trace)).not.toContain('user_earlier_manager');
    expect(trace.manifest.handovers).toEqual([
      {
        agentId,
        fromOwnerDigest: ownerKeyDigest('user_earlier_manager', trace.manifest.exportedAt),
        toOwnerDigest: ownerKeyDigest('user_present_holder', trace.manifest.exportedAt),
        acceptedAt: 5_000,
      },
    ]);
  });

  it('carries work items, charters, surfaces and events, and neither a stored secret nor the manager’s address', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedTracedAgent(harness);
    await expect(
      exportedTrace(harness.withIdentity(managerIdentity('intruder')), agentId),
    ).rejects.toThrow('forbidden');
    const trace = await exportedTrace(harness.withIdentity(managerIdentity()), agentId);
    expect(trace.sections.events.map((event) => event.type)).toEqual([
      'work.completed',
      'permission.revoked',
    ]);
    expect(trace.sections.workItems.map((item) => item.externalId)).toEqual(['REVOPS-1']);
    expect(trace.sections.charters.map((charter) => charter.version)).toEqual(['1.0']);
    expect(trace.sections.surfaces.map((surface) => surface.slug)).toEqual(['linear']);
    expect(trace.manifest.counts).toEqual({
      charters: 1,
      workItems: 1,
      skills: 0,
      questions: 0,
      corrections: 0,
      surfaces: 1,
      managerNotes: 0,
      decisionNotices: 0,
      events: 2,
    });
    const serialised = JSON.stringify(trace);
    expect(serialised).not.toContain('TOP-SECRET-CIPHERTEXT');
    expect(serialised).not.toContain('TOP-SECRET-IV');
    expect(serialised).not.toContain('boss@day0.local');
  });

  it('carries the delivery record of every message Day0 sent the manager, with the provider’s timestamp (Q14)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedTracedAgent(harness);
    await harness.run(async (ctx) => {
      const item = await ctx.db.query('workItems').first();
      const surface = await ctx.db.query('surfaces').first();
      if (!item || !surface) throw new Error('the seed made a work item and a surface');
      await ctx.db.insert('managerNotes', {
        agentId,
        workItemId: item._id,
        kind: 'landed',
        text: 'REVOPS-1 is done: the comment is on the ticket.',
        createdAt: 4,
        claimedAt: 5,
        providerTs: '1789000000.000100',
        keptFor: 'per-run',
      });
      await ctx.db.insert('managerNotes', {
        agentId,
        workItemId: item._id,
        kind: 'stopped',
        text: 'REVOPS-1 stopped.',
        createdAt: 6,
        claimedAt: 7,
        failure: 'channel_not_found',
      });
      await ctx.db.insert('managerDecisionNotices', {
        agentId,
        surfaceId: surface._id,
        workItemId: item._id,
        decisionId: 'D-7Q2',
        messageTs: '1789000000.000200',
        kind: 'received',
        text: 'Got it: approved.',
        createdAt: 8,
        claimedAt: 9,
        providerTs: '1789000000.000300',
      });
    });
    const trace = await exportedTrace(harness.withIdentity(managerIdentity()), agentId);
    expect(
      trace.sections.managerNotes.map((note) => [note.kind, note.providerTs, note.failure]),
    ).toEqual([
      ['landed', '1789000000.000100', undefined],
      ['stopped', undefined, 'channel_not_found'],
    ]);
    expect(
      trace.sections.decisionNotices.map((notice) => [notice.decisionId, notice.providerTs]),
    ).toEqual([['D-7Q2', '1789000000.000300']]);
    expect(trace.manifest.counts).toMatchObject({ managerNotes: 2, decisionNotices: 1 });
  });

  it('carries no live install claim and no manager identity on a surface', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedTracedAgent(harness);
    await harness.run(async (ctx) => {
      const credential = (await ctx.db.query('credentials').first())!;
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'team-chat',
        displayName: 'Team chat',
        class: 'chat',
        verdict: 'approved',
        whereFound: [],
        credentialLanded: false,
        managerName: 'Priya Raman',
        managerUserId: 'U0PRIYA',
        managerDmChannelId: 'D0MANAGER',
        provisioning: {
          appId: 'A0DAY0',
          appName: 'Day0',
          clientId: '123.456',
          clientSecretCredentialId: credential._id,
          installUrl: 'https://slack.com/oauth/v2/authorize?state=LIVE-NONCE-123',
          redirectUrl: 'https://day0.example/oauth',
          scopes: ['chat:write'],
          createdAt: 2,
          stateNonce: 'LIVE-NONCE-123',
          stateExpiresAt: 99,
        },
        createdAt: 2,
      });
    });
    const trace = await exportedTrace(harness.withIdentity(managerIdentity()), agentId);
    const serialised = JSON.stringify(trace);
    expect(serialised).not.toContain('LIVE-NONCE-123');
    expect(serialised).not.toContain('Priya Raman');
    expect(serialised).not.toContain('U0PRIYA');
    expect(trace.sections.surfaces.find((surface) => surface.slug === 'team-chat')).toMatchObject({
      managerDmChannelId: 'D0MANAGER',
    });
  });

  it('never returns more than one page of rows in a call, however many events the agent has', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedTracedAgent(harness);
    await harness.run(async (ctx) => {
      for (let index = 0; index < 250; index += 1) {
        await ctx.db.insert('events', {
          agentId,
          type: 'work.model-call',
          payload: { index },
          createdAt: 10 + index,
        });
      }
    });
    const pages: TracePage[] = [];
    const trace = await exportedTrace(harness.withIdentity(managerIdentity()), agentId, pages);
    expect(Math.max(...pages.map((page) => page.rows.length))).toBe(100);
    expect(
      pages.filter((page) => page.section === 'events').map((page) => page.rows.length),
    ).toEqual([100, 100, 52]);
    expect(trace.sections.events).toHaveLength(252);
    expect(trace.sections.events.at(-1)?.payload).toEqual({ index: 249 });
  });

  it('lists the owner’s retirements in its owner section, and no other owner’s', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedTracedAgent(harness);
    await harness.run(async (ctx) => {
      const retirement = (userId: string, agentName: string, retiredAt: number) => ({
        userId,
        agentName,
        retiredAt,
        rowCounts: { events: 3 },
        revokedCredentials: 1,
        keptCredentials: 0,
        claims: [],
        rejections: [],
      });
      const gone = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Mateo',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const elsewhere = await ctx.db.insert('agents', {
        bossEmail: 'x@day0.local',
        name: 'Other',
        userId: 'someone-else',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('retirements', { ...retirement('owner', 'Mateo', 7), agentId: gone });
      await ctx.db.insert('retirements', {
        ...retirement('someone-else', 'Other', 8),
        agentId: elsewhere,
      });
      await ctx.db.delete(gone);
      await ctx.db.delete(elsewhere);
    });
    const trace = await exportedTrace(harness.withIdentity(managerIdentity()), agentId);
    expect(trace.owner.retired).toEqual([
      expect.objectContaining({
        agentName: 'Mateo',
        retiredAt: 7,
        rowCounts: { events: 3 },
        revokedCredentials: 1,
        claims: [],
        rejections: [],
      }),
    ]);
    // The owner's identity subject never leaves with the row (wave 3.5 review m18).
    expect(trace.owner.retired[0]).not.toHaveProperty('userId');
  });

  it('flags an evaluation agent instead of carrying its reserved address', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: 'eval-day0-r1-1789588800000@day0.local',
          name: 'Day0 evaluation 1',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        }),
    );
    const trace = await exportedTrace(harness.withIdentity(managerIdentity()), agentId);
    expect(trace.agent.evaluation).toBe(true);
    expect(JSON.stringify(trace)).not.toContain('eval-day0-r1');
  });
});

describe('event trace export on a deployed agent', (): void => {
  afterEach((): void => restoreSurfaceMode());

  it('carries neither the boss email the deploy event records nor a token shape a provider echoed', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { api: mockApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const bossEmail = 'priya.boss@day0.local';
    const owner = harness.withIdentity(managerIdentity('owner', { email: bossEmail }));
    const agentId = await owner.mutation(mockApi.agents.deploy, { name: 'Priya' });
    const token = ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-');
    await harness.run(async (ctx): Promise<void> => {
      const workItemId = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-2',
        title: 'Close the loop',
        contentSummary: 'Synthetic evaluation work.',
        contentRefs: [],
        state: 'failed',
        observedAt: 1,
        createdAt: 1,
      });
      const output = {
        applied: [
          {
            tool: 'http.request',
            ok: false,
            reason: `provider said: invalid_auth for Bearer ${token}`,
            idempotencyKey: `${workItemId}:run-2:0`,
          },
        ],
      };
      await ctx.db.patch(workItemId, { output });
      await ctx.db.insert('events', {
        agentId,
        type: 'work.failed',
        payload: { workItemId, reason: `transport refused ${token}`, output },
        createdAt: 5,
      });
    });
    const trace = await exportedTrace(owner, agentId);
    const serialised = JSON.stringify(trace);
    expect(trace.sections.events.map((event) => event.type)).toContain('agent.deployed');
    expect(trace.agent.mode).toBe('mock');
    expect(serialised).not.toContain(bossEmail);
    expect(serialised).not.toContain(token);
    expect(serialised).toContain('<redacted>');
  });
});

describe('the flips of the autonomous-actions switch', (): void => {
  it("returns the employee's own flips oldest first, past any feed window, to the owner only", async (): Promise<void> => {
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const [priya, mateo] = await harness.run(async (ctx): Promise<Array<Id<'agents'>>> => {
      const ids: Array<Id<'agents'>> = [];
      for (const name of ['Priya', 'Mateo']) {
        ids.push(
          await ctx.db.insert('agents', {
            bossEmail: MANAGER_ADDRESS,
            name,
            userId: 'owner',
            state: 'active',
            createdAt: 1,
          }),
        );
      }
      const flip = { reason: 'set by the manager' };
      // The rehearsal's two flips (19 Sep 2026), then enough feed to roll past them.
      await ctx.db.insert('events', {
        agentId: ids[0]!,
        type: 'agent.autonomy-changed',
        payload: { from: false, to: true, ...flip },
        createdAt: 1789788458102,
      });
      await ctx.db.insert('events', {
        agentId: ids[1]!,
        type: 'agent.autonomy-changed',
        payload: { from: false, to: true, ...flip },
        createdAt: 1789788477973,
      });
      for (let index = 0; index < 40; index += 1) {
        await ctx.db.insert('events', {
          agentId: ids[0]!,
          type: 'work.model-call',
          payload: {},
          createdAt: 1789788460000 + index,
        });
      }
      await ctx.db.insert('events', {
        agentId: ids[0]!,
        type: 'agent.autonomy-changed',
        payload: { from: true, to: false, ...flip },
        createdAt: 1789788500000,
      });
      return ids;
    });

    const owner = harness.withIdentity(managerIdentity());
    expect(await owner.query(api.events.autonomyChanges, { agentId: priya! })).toEqual([
      { at: 1789788458102, on: true },
      { at: 1789788500000, on: false },
    ]);
    expect(await owner.query(api.events.autonomyChanges, { agentId: mateo! })).toEqual([
      { at: 1789788477973, on: true },
    ]);
    await expect(
      harness
        .withIdentity(managerIdentity('intruder'))
        .query(api.events.autonomyChanges, { agentId: priya! }),
    ).rejects.toThrow('forbidden');
  });
});

describe('the dashboard ticker', (): void => {
  it('leaves the intake listings out and still fills the window with what the agent did', async (): Promise<void> => {
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'work.discovered',
        payload: {},
        createdAt: 1,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'work.completed',
        payload: {},
        createdAt: 2,
      });
      for (let index = 0; index < 12; index += 1) {
        await ctx.db.insert('events', {
          agentId: id,
          type: 'work.listed',
          payload: {},
          createdAt: 3 + index,
        });
      }
      return id;
    });
    const recent = await harness
      .withIdentity(managerIdentity())
      .query(api.events.recent, { agentId, limit: 2 });
    expect(recent.map((event) => event.type)).toEqual(['work.completed', 'work.discovered']);
  });

  it('walks no more than its scan bound however large a window the caller asks for', async (): Promise<void> => {
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      for (let index = 0; index < 520; index += 1) {
        await ctx.db.insert('events', {
          agentId: id,
          type: 'work.completed',
          payload: {},
          createdAt: index,
        });
      }
      return id;
    });
    const owner = harness.withIdentity(managerIdentity());
    for (const limit of [20_000, Number.POSITIVE_INFINITY]) {
      expect(await owner.query(api.events.recent, { agentId, limit })).toHaveLength(500);
    }
    expect(await owner.query(api.events.recent, { agentId, limit: 0 })).toHaveLength(1);
  });
});

describe('export redaction', (): void => {
  it('drops the assignee’s address as it drops the manager’s', async (): Promise<void> => {
    const { redactForExport } = await import('../../convex/events');
    expect(
      redactForExport({ tracker: { assigneeEmail: 'aiko@example.com', state: 'Todo' } }),
    ).toEqual({ tracker: { state: 'Todo' } });
  });

  it('drops every key that names a person: the ticket’s author and requester, the branch name, the charter’s manager and colleagues, and the manager a change replaced', async (): Promise<void> => {
    const { redactForExport } = await import('../../convex/events');
    expect(
      redactForExport({
        issue: { createdBy: 'Aiko Tanaka', gitBranchName: 'aiko/revops-9', title: 'Refresh' },
        requester: 'Aman',
        charter: {
          boss: 'Priya Raman',
          namedCollaborators: [{ name: 'Wei', topic: 'close' }],
          whyThisHire: 'Pipeline hygiene',
        },
        payload: { managerUserId: 'U2', previousManagerUserId: 'U1', reason: 'manager left' },
      }),
    ).toEqual({
      issue: { title: 'Refresh' },
      charter: { whyThisHire: 'Pipeline hygiene' },
      payload: { reason: 'manager left' },
    });
  });

  it('drops both addresses of a handover request and keeps what happened to it', async (): Promise<void> => {
    const { redactForExport } = await import('../../convex/events');
    expect(
      redactForExport({
        type: 'manager.transfer-asked',
        payload: {
          transferId: 'transfer-1',
          fromAddress: 'sam@company.com',
          toAddress: 'priya@company.com',
          hasNote: true,
        },
      }),
    ).toEqual({
      type: 'manager.transfer-asked',
      payload: { transferId: 'transfer-1', hasNote: true },
    });
  });

  it('drops the author of an adopted or offered skill, a colleague of whoever managed then (decision 4, the wave 10 review, M8)', async (): Promise<void> => {
    const { redactForExport } = await import('../../convex/events');
    expect(
      redactForExport({
        type: 'skill.adopted',
        payload: { name: 'kanban-comment-and-close', version: 1, authorName: 'Priya' },
      }),
    ).toEqual({
      type: 'skill.adopted',
      payload: { name: 'kanban-comment-and-close', version: 1 },
    });
  });
});

describe('the Record tab reader', (): void => {
  /** An employee of `owner` with a work item and five events, oldest first. */
  async function seedRecord(harness: TestConvex<typeof schema>): Promise<Id<'agents'>> {
    return await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const workItemId = await ctx.db.insert('workItems', {
        agentId: id,
        title: 'Refresh the pipeline view',
        contentSummary: 'Refresh it.',
        sourceSystem: 'linear',
        sourceCategory: 'ticket-queue',
        externalId: 'REVOPS-1',
        observedAt: 1,
        contentRefs: [],
        state: 'discovered',
        createdAt: 1,
      });
      const events: Array<{ type: string; payload: unknown }> = [
        { type: 'charter.approved', payload: { charterId: 'c', version: '0.1' } },
        { type: 'work.listed', payload: { workItemId } },
        { type: 'work.discovered', payload: { workItemId, title: 'Refresh the pipeline view' } },
        { type: 'work.actions-rejected', payload: { workItemId, reason: 'wrong owner' } },
        { type: 'work.completed', payload: { workItemId: 'not-an-id' } },
      ];
      for (const [index, event] of events.entries()) {
        await ctx.db.insert('events', { agentId: id, ...event, createdAt: index + 1 });
      }
      return id;
    });
  }

  it('pages the whole record newest first, intake listings included, each with the title of the item it names', async (): Promise<void> => {
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedRecord(harness);
    const owner = harness.withIdentity(managerIdentity());
    const first = await owner.query(api.events.record, {
      agentId,
      paginationOpts: { numItems: 3, cursor: null },
    });
    expect(first.page.map((entry) => entry.event.type)).toEqual([
      'work.completed',
      'work.actions-rejected',
      'work.discovered',
    ]);
    expect(first.page.map((entry) => entry.itemTitle)).toEqual([
      undefined,
      'Refresh the pipeline view',
      'Refresh the pipeline view',
    ]);
    const rest = await owner.query(api.events.record, {
      agentId,
      paginationOpts: { numItems: 3, cursor: first.continueCursor },
    });
    expect(rest.page.map((entry) => entry.event.type)).toEqual(['work.listed', 'charter.approved']);
    expect(rest.isDone).toBe(true);
  });

  it('shows only the types a filter names', async (): Promise<void> => {
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedRecord(harness);
    const owner = harness.withIdentity(managerIdentity());
    const types = async (filter: 'writes' | 'decisions' | 'reads' | 'refused' | 'charter') =>
      (
        await owner.query(api.events.record, {
          agentId,
          filter,
          paginationOpts: { numItems: 10, cursor: null },
        })
      ).page.map((entry) => entry.event.type);
    expect(await types('charter')).toEqual(['charter.approved']);
    expect(await types('reads')).toEqual(['work.discovered', 'work.listed']);
    expect(await types('refused')).toEqual(['work.actions-rejected']);
    expect(await types('writes')).toEqual(['work.completed', 'work.actions-rejected']);
    expect(await types('decisions')).toEqual(['work.actions-rejected', 'charter.approved']);
  });

  it('refuses a caller who does not own the employee', async (): Promise<void> => {
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedRecord(harness);
    await expect(
      harness.withIdentity(managerIdentity('intruder')).query(api.events.record, {
        agentId,
        paginationOpts: { numItems: 3, cursor: null },
      }),
    ).rejects.toThrow();
  });
});

describe('the Record tab reader over a long record', (): void => {
  it('reads at most its scan bound per page, so a selective filter comes back short with a cursor and reaches the oldest line page by page', async (): Promise<void> => {
    const { api } = await import('../../convex/_generated/api');
    const { RECORD_SCAN_ROWS } = await import('../../convex/events');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'charter.approved',
        payload: { version: '0.1' },
        createdAt: 1,
      });
      for (let index = 0; index < RECORD_SCAN_ROWS + 200; index += 1) {
        await ctx.db.insert('events', {
          agentId: id,
          type: 'work.model-call',
          payload: { stage: 'execution', outcome: 'ok' },
          createdAt: index + 2,
        });
      }
      return id;
    });
    const owner = harness.withIdentity(managerIdentity());
    const first = await owner.query(api.events.record, {
      agentId,
      filter: 'charter',
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(first.page).toEqual([]);
    expect(first.isDone).toBe(false);
    expect(first).not.toHaveProperty('pageStatus');
    const second = await owner.query(api.events.record, {
      agentId,
      filter: 'charter',
      paginationOpts: { numItems: 50, cursor: first.continueCursor },
    });
    expect(second.page.map((entry) => entry.event.type)).toEqual(['charter.approved']);
    expect(second.isDone).toBe(true);
  });

  it('names the connection an event is about', async (): Promise<void> => {
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const surfaceId = await ctx.db.insert('surfaces', {
        agentId: id,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'connected',
        whereFound: [],
        path: 'mcp',
        credentialLanded: true,
        createdAt: 1,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'surface.approved',
        payload: { surfaceId },
        createdAt: 2,
      });
      return id;
    });
    const page = await harness
      .withIdentity(managerIdentity())
      .query(api.events.record, { agentId, paginationOpts: { numItems: 5, cursor: null } });
    expect(page.page.map((entry) => entry.connection)).toEqual(['Linear']);
  });
});
