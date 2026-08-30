import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

const OWNER = { subject: 'owner' };

describe('agent evaluation metrics', (): void => {
  it('computes every supervision, permission and audit number from a durable sequence', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1_000,
      });
      const charterId = await ctx.db.insert('charters', {
        agentId: id,
        version: '0.1',
        body: {},
        approved: true,
        approvedAt: 209_000,
        createdAt: 101_000,
      });
      const decisions = [
        {
          id: 'p1',
          kind: 'plan' as const,
          requestedAt: 300_000,
          decidedAt: 304_000,
          outcome: 'approved' as const,
          decidedVia: 'dashboard' as const,
        },
        {
          id: 'a1',
          kind: 'actions' as const,
          requestedAt: 400_000,
          decidedAt: 401_000,
          outcome: 'approved' as const,
          decidedVia: 'channel' as const,
        },
        {
          id: 'p2',
          kind: 'plan' as const,
          requestedAt: 500_000,
          decidedAt: 509_000,
          outcome: 'rejected' as const,
          decidedVia: 'channel' as const,
        },
        {
          id: 'a2',
          kind: 'actions' as const,
          requestedAt: 600_000,
          decidedAt: 620_000,
          outcome: 'rejected' as const,
          decidedVia: 'dashboard' as const,
        },
      ];
      const workItemIds: Id<'workItems'>[] = [];
      for (const [index, decision] of decisions.entries()) {
        workItemIds.push(
          await ctx.db.insert('workItems', {
            agentId: id,
            sourceCategory: 'ticket-queue',
            sourceSystem: 'linear',
            externalId: `REVOPS-${index + 1}`,
            title: `Evaluation item ${index + 1}`,
            contentSummary: 'Synthetic evaluation work.',
            contentRefs: [],
            state: decision.outcome === 'approved' ? 'completed' : 'failed',
            decision: {
              ...decision,
              channel: 'D0MANAGER',
              surfaceSlug: 'slack',
              surfaceName: 'Slack',
            },
            observedAt: 1,
            createdAt: 1,
          }),
        );
      }
      const ledgerOutput = {
        applied: [
          {
            tool: 'mcp.call',
            ok: true,
            authority: 'standing',
            effect: 'Read REVOPS-1',
            idempotencyKey: `${workItemIds[0]}:run-ledger:0`,
          },
          {
            tool: 'mcp.call',
            ok: true,
            authority: 'manager',
            effect: 'Commented on REVOPS-1',
            idempotencyKey: `${workItemIds[0]}:run-ledger:1`,
          },
          {
            tool: 'http.request',
            ok: true,
            authority: 'autonomous',
            effect: 'Sent manager update',
            idempotencyKey: `${workItemIds[0]}:run-ledger:2`,
          },
        ],
      };
      await ctx.db.patch(workItemIds[0], { output: ledgerOutput });
      const addEvent = async (type: string, payload: unknown, createdAt: number): Promise<void> => {
        await ctx.db.insert('events', { agentId: id, type, payload, createdAt });
      };
      await addEvent('agent.deployed', {}, 1_000);
      await addEvent('charter.drafted', { charterId }, 61_000);
      await addEvent('charter.request_changes', { charterId }, 70_000);
      await addEvent('charter.drafted', { charterId }, 101_000);
      await addEvent('charter.approved', { charterId }, 209_000);
      await addEvent(
        'work.decision-requesting',
        { workItemId: workItemIds[0], decisionId: 'p1', kind: 'plan' },
        300_000,
      );
      await addEvent(
        'work.plan-approved',
        { workItemId: workItemIds[0], decidedVia: 'dashboard' },
        304_000,
      );
      await addEvent(
        'work.decision-requesting',
        { workItemId: workItemIds[1], decisionId: 'a1', kind: 'actions' },
        400_000,
      );
      await addEvent(
        'work.actions-pending',
        {
          workItemId: workItemIds[1],
          runId: 'run-1',
          autoIndexes: [0],
          heldIndexes: [1, 2],
          refusedIndexes: [3],
          refusals: [{ index: 3, reason: 'malformed action' }],
        },
        400_100,
      );
      await addEvent(
        'work.actions-approved',
        {
          workItemId: workItemIds[1],
          runId: 'run-1',
          approvedIndexes: [1],
          rejectedIndexes: [2],
          refusedIndexes: [3],
          decidedVia: 'channel',
        },
        401_000,
      );
      await addEvent(
        'work.decision-requesting',
        { workItemId: workItemIds[2], decisionId: 'p2', kind: 'plan' },
        500_000,
      );
      await addEvent(
        'work.cancelled',
        { workItemId: workItemIds[2], decidedVia: 'channel' },
        509_000,
      );
      await addEvent(
        'work.decision-requesting',
        { workItemId: workItemIds[3], decisionId: 'a2', kind: 'actions' },
        600_000,
      );
      await addEvent(
        'work.actions-pending',
        {
          workItemId: workItemIds[3],
          runId: 'run-2',
          autoIndexes: [],
          heldIndexes: [0, 1],
          refusedIndexes: [],
        },
        600_100,
      );
      await addEvent(
        'work.actions-rejected',
        { workItemId: workItemIds[3], decidedVia: 'dashboard' },
        620_000,
      );
      await addEvent(
        'work.completed',
        { workItemId: workItemIds[0], output: ledgerOutput },
        650_000,
      );
      await addEvent('permission.revoked', { scope: 'linear:read', by: 'manager' }, 700_000);
      await addEvent(
        'work.actions-pending',
        {
          workItemId: workItemIds[0],
          runId: 'run-3',
          autoIndexes: [],
          heldIndexes: [],
          refusedIndexes: [0],
          refusals: [{ index: 0, reason: 'no grant (linear:read)' }],
        },
        702_500,
      );
      await addEvent('surface.approved', { surfaceId: 'surface-1' }, 710_000);
      await addEvent('surface.approved', { surfaceId: 'surface-2' }, 711_000);
      await addEvent('surface.rejected', { surfaceId: 'surface-3' }, 712_000);
      await addEvent('surface.oriented', { surfaceId: 'surface-4', verdict: 'absent' }, 713_000);
      await addEvent('skill.approved', { skillId: 'skill-1' }, 720_000);
      await addEvent('skill.approved', { skillId: 'skill-2' }, 721_000);
      await addEvent('skill.rejected', { skillId: 'skill-3' }, 722_000);
      await addEvent('agent.autonomy-changed', { from: false, to: true }, 730_000);
      await addEvent('agent.autonomy-changed', { from: true, to: false }, 731_000);
      return id;
    });

    await expect(
      harness.withIdentity({ subject: 'intruder' }).query(api.metrics.forAgent, { agentId }),
    ).rejects.toThrow('forbidden');
    const metrics = await harness.withIdentity(OWNER).query(api.metrics.forAgent, { agentId });
    expect(metrics).toEqual({
      charter: {
        timeToFirstDraftedMs: 60_000,
        timeToFirstApprovedMs: 208_000,
        revisions: 1,
        requestChanges: 1,
      },
      decisions: {
        requested: 4,
        approved: 2,
        rejected: 2,
        partiallyApproved: 1,
        cancelled: 1,
        medianLatencyMs: 6_500,
        p90LatencyMs: 20_000,
        byVia: {
          dashboard: { decided: 2, medianLatencyMs: 12_000, p90LatencyMs: 20_000 },
          channel: { decided: 2, medianLatencyMs: 5_000, p90LatencyMs: 9_000 },
        },
      },
      actions: {
        autoApplied: 2,
        held: 4,
        approved: 1,
        rejected: 3,
        refused: 2,
        blockedAfterRevocation: 1,
        firstBlockAfterRevocationMs: 2_500,
      },
      surfaces: { approved: 2, rejected: 1, absent: 1 },
      skills: { approved: 2, rejected: 1 },
      autonomyChanges: 2,
      auditTrail: { complete: 3, total: 3, fraction: 1 },
    });
  });

  it('returns null for timings and ratios that have not happened', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'New agent',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'agent.deployed',
        payload: {},
        createdAt: 1,
      });
      return id;
    });
    const metrics = await harness.withIdentity(OWNER).query(api.metrics.forAgent, { agentId });
    expect(metrics.charter.timeToFirstDraftedMs).toBeNull();
    expect(metrics.charter.timeToFirstApprovedMs).toBeNull();
    expect(metrics.decisions.medianLatencyMs).toBeNull();
    expect(metrics.actions.blockedAfterRevocation).toBeNull();
    expect(metrics.actions.firstBlockAfterRevocationMs).toBeNull();
    expect(metrics.auditTrail.fraction).toBeNull();
  });
});

describe('metrics under adversarial sequences', (): void => {
  it('counts a decision requested but never answered without inventing a latency', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Waiting',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const workItemId = await ctx.db.insert('workItems', {
        agentId: id,
        sourceCategory: 'inbox',
        sourceSystem: 'docs',
        externalId: 'REVOPS-9',
        title: 'Unanswered',
        contentSummary: 'A plan nobody decided.',
        contentRefs: [],
        state: 'plan-pending',
        observedAt: 1,
        createdAt: 1,
        decision: {
          id: 'd-open',
          kind: 'plan',
          requestedAt: 2_000,
          channel: 'D123',
          surfaceSlug: 'slack',
          surfaceName: 'Slack',
        },
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'work.decision-requesting',
        payload: { workItemId, kind: 'plan', decisionId: 'd-open' },
        createdAt: 2_000,
      });
      return id;
    });
    const metrics = await harness.withIdentity(OWNER).query(api.metrics.forAgent, { agentId });
    expect(metrics.decisions).toMatchObject({
      requested: 1,
      approved: 0,
      rejected: 0,
      medianLatencyMs: null,
      p90LatencyMs: null,
    });
    expect(metrics.decisions.byVia.dashboard.decided).toBe(0);
    expect(metrics.decisions.byVia.channel.decided).toBe(0);
  });

  it('pairs each refusal with the latest revocation of its own scope when two scopes were revoked', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Twice revoked',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const workItemId = await ctx.db.insert('workItems', {
        agentId: id,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-3',
        title: 'Two reads',
        contentSummary: 'One Linear read and one Slack DM.',
        contentRefs: [],
        state: 'failed',
        observedAt: 1,
        createdAt: 1,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'permission.revoked',
        payload: { scope: 'linear:read', by: 'manager' },
        createdAt: 10_000,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'permission.revoked',
        payload: { scope: 'slack:read', by: 'manager' },
        createdAt: 20_000,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'permission.revoked',
        payload: { scope: 'linear:read', by: 'manager' },
        createdAt: 30_000,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'work.actions-pending',
        payload: {
          workItemId,
          runId: 'run-3',
          autoIndexes: [],
          heldIndexes: [],
          refusedIndexes: [0, 1],
          refusals: [
            { index: 0, reason: 'no grant (linear:read)' },
            { index: 1, reason: 'no grant (slack:read)' },
          ],
        },
        createdAt: 31_000,
      });
      return id;
    });
    const metrics = await harness.withIdentity(OWNER).query(api.metrics.forAgent, { agentId });
    expect(metrics.actions.refused).toBe(2);
    expect(metrics.actions.blockedAfterRevocation).toBe(2);
    expect(metrics.actions.firstBlockAfterRevocationMs).toBe(1_000);
  });

  it('reports the request and the decided count from the row when the events are gone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Row only',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('workItems', {
        agentId: id,
        sourceCategory: 'inbox',
        sourceSystem: 'docs',
        externalId: 'REVOPS-10',
        title: 'Decided on the row',
        contentSummary: 'Events retention has passed.',
        contentRefs: [],
        state: 'completed',
        observedAt: 1,
        createdAt: 1,
        decision: {
          id: 'd-row',
          kind: 'actions',
          requestedAt: 5_000,
          channel: 'D123',
          surfaceSlug: 'slack',
          surfaceName: 'Slack',
          decidedAt: 8_000,
          outcome: 'approved',
          decidedVia: 'channel',
        },
      });
      return id;
    });
    const metrics = await harness.withIdentity(OWNER).query(api.metrics.forAgent, { agentId });
    expect(metrics.decisions).toMatchObject({ requested: 1, approved: 1, medianLatencyMs: 3_000 });
    expect(metrics.decisions.byVia.channel).toEqual({
      decided: 1,
      medianLatencyMs: 3_000,
      p90LatencyMs: 3_000,
    });
  });
});
