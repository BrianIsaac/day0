import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { assembleTrace, type AgentTrace, type TracePage } from '../../src/export/trace';

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
      bossEmail: 'boss@day0.local',
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
      await ctx.db.insert('deploymentVersions', { release: '0.4.0', commit: 'd71b1cf8', recordedAt: 1 });
    });
    const { api } = await import('../../convex/_generated/api');
    const head = await harness
      .withIdentity({ subject: 'owner' })
      .action(api.exportActions.exportForAgent, { agentId });
    expect(head.manifest).toEqual({
      format: 'day0-trace',
      version: 2,
      exportedAt: Date.UTC(2026, 8, 27, 17, 0),
      exportedOn: '2026-09-28',
      zone: 'Asia/Singapore',
      release: '0.4.0',
      commit: 'd71b1cf8',
      pageRows: 100,
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

  it('carries work items, charters, surfaces and events, and neither a stored secret nor the manager’s address', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedTracedAgent(harness);
    await expect(
      exportedTrace(harness.withIdentity({ subject: 'intruder' }), agentId),
    ).rejects.toThrow('forbidden');
    const trace = await exportedTrace(harness.withIdentity({ subject: 'owner' }), agentId);
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
      events: 2,
    });
    const serialised = JSON.stringify(trace);
    expect(serialised).not.toContain('TOP-SECRET-CIPHERTEXT');
    expect(serialised).not.toContain('TOP-SECRET-IV');
    expect(serialised).not.toContain('boss@day0.local');
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
    const trace = await exportedTrace(harness.withIdentity({ subject: 'owner' }), agentId);
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
        await ctx.db.insert('events', { agentId, type: 'work.model-call', payload: { index }, createdAt: 10 + index });
      }
    });
    const pages: TracePage[] = [];
    const trace = await exportedTrace(harness.withIdentity({ subject: 'owner' }), agentId, pages);
    expect(Math.max(...pages.map((page) => page.rows.length))).toBe(100);
    expect(pages.filter((page) => page.section === 'events').map((page) => page.rows.length)).toEqual([100, 100, 52]);
    expect(trace.sections.events).toHaveLength(252);
    expect(trace.sections.events.at(-1)?.payload).toEqual({ index: 249 });
  });

  it('names the owner’s retired employees from their tombstones, and no other owner’s', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedTracedAgent(harness);
    await harness.run(async (ctx) => {
      const gone = await ctx.db.insert('agents', { bossEmail: 'boss@day0.local', name: 'Mateo', userId: 'owner', state: 'active', createdAt: 1 });
      const elsewhere = await ctx.db.insert('agents', { bossEmail: 'x@day0.local', name: 'Other', userId: 'someone-else', state: 'active', createdAt: 1 });
      await ctx.db.insert('events', { agentId: gone, type: 'agent.retired', payload: { userId: 'owner', agentId: gone, retiredAt: 7, rowCounts: { events: 3 } }, createdAt: 7 });
      await ctx.db.insert('events', { agentId: elsewhere, type: 'agent.retired', payload: { userId: 'someone-else', agentId: elsewhere, retiredAt: 8, rowCounts: {} }, createdAt: 8 });
      await ctx.db.delete(gone);
      await ctx.db.delete(elsewhere);
    });
    const trace = await exportedTrace(harness.withIdentity({ subject: 'owner' }), agentId);
    expect(trace.owner.retired).toEqual([
      expect.objectContaining({ retiredAt: 7, payload: expect.objectContaining({ rowCounts: { events: 3 } }) }),
    ]);
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
    const trace = await exportedTrace(harness.withIdentity({ subject: 'owner' }), agentId);
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
    const owner = harness.withIdentity({ subject: 'owner' });
    const bossEmail = 'priya.boss@day0.local';
    const agentId = await owner.mutation(mockApi.agents.deploy, { bossEmail, name: 'Priya' });
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
  it('returns the employee\'s own flips oldest first, past any feed window, to the owner only', async (): Promise<void> => {
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const [priya, mateo] = await harness.run(async (ctx): Promise<Array<Id<'agents'>>> => {
      const ids: Array<Id<'agents'>> = [];
      for (const name of ['Priya', 'Mateo']) {
        ids.push(
          await ctx.db.insert('agents', {
            bossEmail: 'boss@day0.local',
            name,
            userId: 'owner',
            state: 'active',
            createdAt: 1,
          }),
        );
      }
      const flip = { reason: 'set by the manager' };
      // The rehearsal's two flips (19 Sep 2026), then enough feed to roll past them.
      await ctx.db.insert('events', { agentId: ids[0]!, type: 'agent.autonomy-changed', payload: { from: false, to: true, ...flip }, createdAt: 1789788458102 });
      await ctx.db.insert('events', { agentId: ids[1]!, type: 'agent.autonomy-changed', payload: { from: false, to: true, ...flip }, createdAt: 1789788477973 });
      for (let index = 0; index < 40; index += 1) {
        await ctx.db.insert('events', { agentId: ids[0]!, type: 'work.model-call', payload: {}, createdAt: 1789788460000 + index });
      }
      await ctx.db.insert('events', { agentId: ids[0]!, type: 'agent.autonomy-changed', payload: { from: true, to: false, ...flip }, createdAt: 1789788500000 });
      return ids;
    });

    const owner = harness.withIdentity({ subject: 'owner' });
    expect(await owner.query(api.events.autonomyChanges, { agentId: priya! })).toEqual([
      { at: 1789788458102, on: true },
      { at: 1789788500000, on: false },
    ]);
    expect(await owner.query(api.events.autonomyChanges, { agentId: mateo! })).toEqual([{ at: 1789788477973, on: true }]);
    await expect(
      harness.withIdentity({ subject: 'intruder' }).query(api.events.autonomyChanges, { agentId: priya! }),
    ).rejects.toThrow('forbidden');
  });
});

describe('the dashboard ticker', (): void => {
  it('leaves the intake listings out and still fills the window with what the agent did', async (): Promise<void> => {
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('events', { agentId: id, type: 'work.discovered', payload: {}, createdAt: 1 });
      await ctx.db.insert('events', { agentId: id, type: 'work.completed', payload: {}, createdAt: 2 });
      for (let index = 0; index < 12; index += 1) {
        await ctx.db.insert('events', { agentId: id, type: 'work.listed', payload: {}, createdAt: 3 + index });
      }
      return id;
    });
    const recent = await harness
      .withIdentity({ subject: 'owner' })
      .query(api.events.recent, { agentId, limit: 2 });
    expect(recent.map((event) => event.type)).toEqual(['work.completed', 'work.discovered']);
  });
});

describe('export redaction', (): void => {
  it('drops the assignee’s address as it drops the manager’s', async (): Promise<void> => {
    const { redactForExport } = await import('../../convex/events');
    expect(
      redactForExport({ tracker: { assigneeEmail: 'aiko@example.com', state: 'Todo' } }),
    ).toEqual({ tracker: { state: 'Todo' } });
  });
});
