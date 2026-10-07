import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import {
  computeAgentMetrics,
  computeCompanyMetrics,
  handoversFromTransfers,
  isEvaluationAgent,
} from '../../convex/metrics';
import type { OwnerMetrics } from '../../src/metrics/types';
import { RETRIEVAL_RECALL } from '../../src/metrics/retrieval-recall';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { guardRefusal } from './fakes/anonymous-caller';

const OWNER = managerIdentity();

describe('agent evaluation metrics', (): void => {
  it('computes every supervision, permission and audit number from a durable sequence', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
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
      harness.withIdentity(managerIdentity('intruder')).query(api.metrics.forAgent, { agentId }),
    ).rejects.toThrow('This employee is not yours.');
    const metrics = await harness.withIdentity(OWNER).query(api.metrics.forAgent, { agentId });
    expect(metrics).toEqual({
      // The first write row that landed, carried by the run's completion; never the approval at
      // 401_000, whose apply could yet have failed (re-pinned: X finding 5).
      writeLanded: true,
      workingSince: 650_000,
      charter: {
        timeToFirstDraftedMs: 60_000,
        timeToFirstApprovedMs: 208_000,
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
        automatic: { reads: 0, managerMessages: 0, writes: 2 },
        sessionRestores: 0,
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
      // The ask is the rows' observedAt (1); the three items that ended did
      // so at 509 s, 620 s and 650 s, and only the last completed.
      pilot: {
        skillReuse: { runs: 0, reused: 0, adopted: 0, rate: null },
        cycleTime: {
          ended: 3,
          medianToEndMs: 619_999,
          completed: 1,
          medianToCompletionMs: 649_999,
          p90ToCompletionMs: 649_999,
        },
        reorientation: { answered: 0, amended: 0, rate: null },
        hoursSaved: { estimatedItems: 0, hours: null },
        retrieval: { tokens: null, recall: RETRIEVAL_RECALL },
      },
    });
  });

  it('returns null for timings and ratios that have not happened', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
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
        bossEmail: MANAGER_ADDRESS,
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
        bossEmail: MANAGER_ADDRESS,
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
        bossEmail: MANAGER_ADDRESS,
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

  it('counts a resent request once, timing the decision from the first ask', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Resent',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const workItemId = await ctx.db.insert('workItems', {
        agentId: id,
        sourceCategory: 'inbox',
        sourceSystem: 'docs',
        externalId: 'REVOPS-11',
        title: 'Asked twice',
        contentSummary: 'The first DM never arrived.',
        contentRefs: [],
        state: 'completed',
        observedAt: 1,
        createdAt: 1,
        decision: {
          id: 'd-second',
          kind: 'plan',
          requestedAt: 6_000,
          channel: 'D123',
          surfaceSlug: 'slack',
          surfaceName: 'Slack',
          ts: '1.2',
          decidedAt: 9_000,
          outcome: 'approved',
          decidedVia: 'channel',
        },
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'work.decision-requesting',
        payload: { workItemId, kind: 'plan', decisionId: 'd-first' },
        createdAt: 2_000,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'work.decision-request-resent',
        payload: {
          workItemId,
          kind: 'plan',
          decisionId: 'd-first',
          reason: 'request not delivered',
        },
        createdAt: 5_000,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'work.decision-requesting',
        payload: { workItemId, kind: 'plan', decisionId: 'd-second', supersedes: 'd-first' },
        createdAt: 6_000,
      });
      await ctx.db.insert('events', {
        agentId: id,
        type: 'work.plan-approved',
        payload: { workItemId, decidedVia: 'channel' },
        createdAt: 9_000,
      });
      return id;
    });
    const metrics = await harness.withIdentity(OWNER).query(api.metrics.forAgent, { agentId });
    expect(metrics.decisions).toMatchObject({ requested: 1, approved: 1, medianLatencyMs: 7_000 });
    expect(metrics.decisions.byVia.channel.decided).toBe(1);
  });
});

describe('a browser session re-established before an apply invocation', (): void => {
  const step = (key: string, replayOf: string, tool: string) => ({
    tool: 'mcp.call',
    ok: true,
    authority: 'autonomous',
    effect: `${tool} on looker · ok`,
    idempotencyKey: key,
    replayOf,
  });
  const item = (id: string, applied: unknown[]): Doc<'workItems'> =>
    ({ _id: id, state: 'completed', output: { applied } }) as unknown as Doc<'workItems'>;

  it('counts each replayed transport call toward the audit trail and not toward autoApplied', (): void => {
    const restored = item('wi', [
      {
        tool: 'mcp.call',
        ok: true,
        authority: 'autonomous',
        effect: 'browser_fill_form on looker · ok',
        idempotencyKey: 'wi:run:4',
        sessionRestore: {
          steps: [
            step('wi:run:4.session-0', 'wi:run:0', 'browser_navigate'),
            step('wi:run:4.session-1', 'wi:run:1', 'browser_fill_form'),
            step('wi:run:4.session-2', 'wi:run:2', 'browser_click'),
          ],
        },
      },
      {
        tool: 'mcp.call',
        ok: true,
        authority: 'autonomous',
        effect: 'browser_click on looker · ok',
        idempotencyKey: 'wi:run:5',
      },
    ]);
    const refused = item('wi2', [
      {
        tool: 'mcp.call',
        ok: false,
        reason:
          'browser session could not be re-established: browser_fill_form no grant (looker:write)',
        idempotencyKey: 'wi2:run2:4',
        sessionRestore: {
          steps: [
            step('wi2:run2:4.session-0', 'wi2:run2:0', 'browser_navigate'),
            {
              tool: 'mcp.call',
              ok: false,
              reason: 'no grant (looker:write)',
              idempotencyKey: 'wi2:run2:4.session-1',
              replayOf: 'wi2:run2:1',
            },
          ],
        },
      },
    ]);
    const metrics = computeAgentMetrics([], [restored, refused], []);
    expect(metrics.actions).toMatchObject({ autoApplied: 2, sessionRestores: 4, refused: 1 });
    expect(metrics.auditTrail).toEqual({ complete: 6, total: 6, fraction: 1 });
  });
});

describe('supervision figures for a company of employees', (): void => {
  const COMPANY_OWNER = managerIdentity('company-owner');

  interface EmployeeSpec {
    name: string;
    deployedAt: number;
    bossEmail?: string;
    userId?: string;
    arm?: 'day0' | 'baseline';
    charterApprovedAt?: number;
    decisions?: Array<{
      requestedAt: number;
      decidedAt: number;
      via: 'dashboard' | 'channel';
      outcome: 'approved' | 'rejected';
    }>;
    ledger?: (workItemId: Id<'workItems'>) => unknown[];
    /** When the ledger's run completed: its rows are then on a `work.completed` event too, as the product writes them. */
    completedAt?: number;
    autonomyChanges?: number;
  }

  async function deployEmployee(
    harness: ReturnType<typeof convexTest>,
    spec: EmployeeSpec,
  ): Promise<Id<'agents'>> {
    return await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: spec.bossEmail ?? 'boss@day0.local',
        name: spec.name,
        userId: spec.userId ?? COMPANY_OWNER.subject,
        state: spec.charterApprovedAt === undefined ? 'charter-pending' : 'active',
        arm: spec.arm ?? 'day0',
        createdAt: spec.deployedAt,
      });
      const addEvent = async (type: string, payload: unknown, createdAt: number): Promise<void> => {
        await ctx.db.insert('events', { agentId, type, payload, createdAt });
      };
      await addEvent('agent.deployed', {}, spec.deployedAt);
      const charterId = await ctx.db.insert('charters', {
        agentId,
        version: '0.1',
        body: {},
        approved: spec.charterApprovedAt !== undefined,
        ...(spec.charterApprovedAt === undefined ? {} : { approvedAt: spec.charterApprovedAt }),
        createdAt: spec.deployedAt + 500,
      });
      if (spec.charterApprovedAt !== undefined) {
        await addEvent('charter.approved', { charterId }, spec.charterApprovedAt);
      }
      for (const [index, decision] of (spec.decisions ?? []).entries()) {
        const workItemId = await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: `${spec.name.toUpperCase()}-${index + 1}`,
          title: `${spec.name} item ${index + 1}`,
          contentSummary: 'Synthetic company work.',
          contentRefs: [],
          state: decision.outcome === 'approved' ? 'completed' : 'failed',
          observedAt: 1,
          createdAt: 1,
        });
        await addEvent(
          'work.decision-requesting',
          { workItemId, decisionId: `${spec.name}-${index}`, kind: 'plan' },
          decision.requestedAt,
        );
        await addEvent(
          decision.outcome === 'approved' ? 'work.plan-approved' : 'work.cancelled',
          { workItemId, decidedVia: decision.via },
          decision.decidedAt,
        );
      }
      if (spec.ledger) {
        const workItemId = await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: `${spec.name.toUpperCase()}-LEDGER`,
          title: `${spec.name} ledger`,
          contentSummary: 'Synthetic landed rows.',
          contentRefs: [],
          state: 'completed',
          observedAt: 1,
          createdAt: 1,
        });
        const output = { applied: spec.ledger(workItemId) };
        await ctx.db.patch(workItemId, { output });
        if (spec.completedAt !== undefined) {
          await addEvent('work.completed', { workItemId, output }, spec.completedAt);
        }
      }
      for (let change = 0; change < (spec.autonomyChanges ?? 0); change += 1) {
        await addEvent('agent.autonomy-changed', { from: false, to: true }, spec.deployedAt + 900);
      }
      return agentId;
    });
  }

  async function companyFigures(harness: ReturnType<typeof convexTest>): Promise<OwnerMetrics> {
    const figures = await harness.withIdentity(COMPANY_OWNER).query(api.metrics.forOwner, {});
    if (!figures) throw new Error('forOwner returned nothing to the owner');
    return figures;
  }

  const landedRow = (
    workItemId: Id<'workItems'>,
    index: number,
    authority: 'standing' | 'manager' | 'autonomous',
    effect?: string,
  ): Record<string, unknown> => ({
    tool: 'mcp.call',
    ok: true,
    authority,
    ...(effect === undefined ? {} : { effect }),
    idempotencyKey: `${workItemId}:run-${index}:${index}`,
  });

  const THREE_EMPLOYEES: EmployeeSpec[] = [
    {
      name: 'Priya',
      deployedAt: 1_000,
      charterApprovedAt: 61_000,
      decisions: [
        { requestedAt: 100_000, decidedAt: 101_000, via: 'dashboard', outcome: 'approved' },
        { requestedAt: 110_000, decidedAt: 112_000, via: 'channel', outcome: 'approved' },
        { requestedAt: 120_000, decidedAt: 123_000, via: 'dashboard', outcome: 'rejected' },
      ],
      ledger: (workItemId) => [
        landedRow(workItemId, 0, 'standing', 'Read REVOPS-1'),
        landedRow(workItemId, 1, 'manager', 'Commented on REVOPS-1'),
      ],
    },
    {
      name: 'Mateo',
      deployedAt: 2_000,
      charterApprovedAt: 182_000,
      decisions: [
        { requestedAt: 200_000, decidedAt: 210_000, via: 'channel', outcome: 'approved' },
      ],
      // A browser row whose session was re-established: two replayed calls
      // land before it, each a row of the audit trail, neither an automatic action.
      ledger: (workItemId) => [
        {
          ...landedRow(workItemId, 4, 'autonomous', 'browser_fill_form on looker · ok'),
          sessionRestore: {
            steps: [0, 1].map((step) => ({
              tool: 'mcp.call',
              ok: true,
              authority: 'autonomous',
              effect: `replayed step ${step} · ok`,
              idempotencyKey: `${workItemId}:run-4:4.session-${step}`,
              replayOf: `${workItemId}:run-4:${step}`,
            })),
          },
        },
      ],
      autonomyChanges: 1,
    },
    {
      name: 'Aiko',
      deployedAt: 3_000,
      charterApprovedAt: 123_000,
      decisions: [
        { requestedAt: 300_000, decidedAt: 304_000, via: 'dashboard', outcome: 'approved' },
        { requestedAt: 310_000, decidedAt: 315_000, via: 'channel', outcome: 'approved' },
      ],
      // Landed without an effect: on the trail, not complete.
      ledger: (workItemId) => [landedRow(workItemId, 0, 'autonomous')],
    },
  ];

  const SET_ASIDE: EmployeeSpec[] = [
    {
      name: 'Day0 revocation evaluation',
      bossEmail: 'eval-revocation-2026-09-18t08-00-00z@day0.local',
      deployedAt: 4_000,
      charterApprovedAt: 5_000,
      decisions: [
        { requestedAt: 400_000, decidedAt: 1_399_000, via: 'channel', outcome: 'approved' },
      ],
      ledger: (workItemId) => [landedRow(workItemId, 0, 'autonomous')],
    },
    {
      name: 'Ordinary agent evaluation 1',
      arm: 'baseline',
      deployedAt: 5_000,
      charterApprovedAt: 6_000,
      decisions: [
        { requestedAt: 500_000, decidedAt: 1_277_000, via: 'dashboard', outcome: 'rejected' },
      ],
    },
    {
      name: 'Another manager’s employee',
      userId: 'another-owner',
      deployedAt: 6_000,
      charterApprovedAt: 7_000,
      decisions: [
        { requestedAt: 600_000, decidedAt: 1_155_000, via: 'channel', outcome: 'approved' },
      ],
    },
  ];

  it('pools one manager’s decisions across employees and keeps each employee’s own row', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const employeeIds: Id<'agents'>[] = [];
    for (const spec of THREE_EMPLOYEES) employeeIds.push(await deployEmployee(harness, spec));
    for (const spec of SET_ASIDE) await deployEmployee(harness, spec);

    const figures = await companyFigures(harness);

    expect(figures.employees.map((row) => row.name)).toEqual(['Priya', 'Mateo', 'Aiko']);
    for (const [index, agentId] of employeeIds.entries()) {
      const own = await harness
        .withIdentity(COMPANY_OWNER)
        .query(api.metrics.forAgent, { agentId });
      expect(figures.employees[index]).toEqual({
        agentId,
        name: THREE_EMPLOYEES[index].name,
        deployedAt: THREE_EMPLOYEES[index].deployedAt,
        metrics: own,
      });
    }
    // The employees' own medians are 2 s, 10 s and 4.5 s, so a median of the
    // medians would read 4.5 s; the manager's own distribution is the six
    // pooled waits, 1, 2, 3, 4, 5 and 10 s, whose median is 3.5 s.
    expect(figures.employees.map((row) => row.metrics.decisions.medianLatencyMs)).toEqual([
      2_000, 10_000, 4_500,
    ]);
    expect(figures.company).toEqual({
      employees: 3,
      charter: {
        timesToFirstApprovedMs: [60_000, 180_000, 120_000],
        medianTimeToFirstApprovedMs: 120_000,
        approvedEmployees: 3,
      },
      decisions: {
        requested: 6,
        approved: 5,
        rejected: 1,
        partiallyApproved: 0,
        cancelled: 1,
        medianLatencyMs: 3_500,
        p90LatencyMs: 10_000,
        byVia: {
          dashboard: { decided: 3, medianLatencyMs: 3_000, p90LatencyMs: 4_000 },
          channel: { decided: 3, medianLatencyMs: 5_000, p90LatencyMs: 10_000 },
        },
      },
      actions: {
        autoApplied: 3,
        automatic: { reads: 0, managerMessages: 0, writes: 3 },
        sessionRestores: 2,
        held: 0,
        approved: 0,
        rejected: 0,
        refused: 0,
        blockedAfterRevocation: null,
        firstBlockAfterRevocationMs: null,
      },
      surfaces: { approved: 0, rejected: 0, absent: 0 },
      skills: { approved: 0, rejected: 0 },
      autonomyChanges: 1,
      auditTrail: { complete: 5, total: 6, fraction: 5 / 6 },
      pilot: {
        skillReuse: { runs: 0, reused: 0, adopted: 0, rate: null },
        cycleTime: {
          ended: 1,
          medianToEndMs: 122_999,
          completed: 0,
          medianToCompletionMs: null,
          p90ToCompletionMs: null,
        },
        reorientation: { answered: 0, amended: 0, rate: null },
        hoursSaved: { estimatedItems: 0, hours: null },
        retrieval: { tokens: null, recall: RETRIEVAL_RECALL },
      },
    });
    expect(figures.excludedAgents).toBe(2);
    expect(figures.omittedEmployees).toBe(0);
  });

  it('quotes each employee’s time to an approved charter and a median only over the approved ones', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await deployEmployee(harness, { name: 'Priya', deployedAt: 1_000, charterApprovedAt: 61_000 });
    await deployEmployee(harness, { name: 'Mateo', deployedAt: 2_000 });
    await deployEmployee(harness, { name: 'Aiko', deployedAt: 3_000, charterApprovedAt: 183_000 });
    const figures = await companyFigures(harness);
    expect(figures.company.charter).toEqual({
      timesToFirstApprovedMs: [60_000, null, 180_000],
      medianTimeToFirstApprovedMs: 120_000,
      approvedEmployees: 2,
    });
  });

  it('counts a revocation block only for the employee whose scope was revoked', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const revoked = await deployEmployee(harness, { name: 'Priya', deployedAt: 1_000 });
    await deployEmployee(harness, { name: 'Mateo', deployedAt: 2_000 });
    await harness.run(async (ctx): Promise<void> => {
      const workItemId = await ctx.db.insert('workItems', {
        agentId: revoked,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-3',
        title: 'After the revocation',
        contentSummary: 'A read the manager revoked.',
        contentRefs: [],
        state: 'failed',
        observedAt: 1,
        createdAt: 1,
      });
      await ctx.db.insert('events', {
        agentId: revoked,
        type: 'permission.revoked',
        payload: { scope: 'linear:read', by: 'manager' },
        createdAt: 10_000,
      });
      await ctx.db.insert('events', {
        agentId: revoked,
        type: 'work.actions-pending',
        payload: {
          workItemId,
          runId: 'run-1',
          autoIndexes: [],
          heldIndexes: [],
          refusedIndexes: [0],
          refusals: [{ index: 0, reason: 'no grant (linear:read)' }],
        },
        createdAt: 12_000,
      });
    });
    const figures = await companyFigures(harness);
    expect(figures.employees.map((row) => row.metrics.actions.blockedAfterRevocation)).toEqual([
      1,
      null,
    ]);
    expect(figures.company.actions).toMatchObject({
      refused: 1,
      blockedAfterRevocation: 1,
      firstBlockAfterRevocationMs: 2_000,
    });
  });

  it('reports the employees it leaves out when the company is larger than the roster', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    for (let index = 0; index < 21; index += 1) {
      await deployEmployee(harness, { name: `Employee ${index + 1}`, deployedAt: 1_000 + index });
    }
    const figures = await companyFigures(harness);
    expect(figures.company.employees).toBe(20);
    expect(figures.omittedEmployees).toBe(1);
    expect(figures.employees[0].name).toBe('Employee 2');
    expect(figures.employees.at(-1)?.name).toBe('Employee 21');
  });

  /** The new manager of a handover, signed in with a verified address of their own. */
  const SUCCESSOR = managerIdentity('successor');

  /**
   * Hand an employee over as an accepted request leaves it: the accepted row
   * (inserted directly; the move is 9-U3a's) and the row's new owner. While
   * `accepting`, the row waits for runs in flight and the employee has not moved.
   */
  async function handOver(
    harness: ReturnType<typeof convexTest>,
    agentId: Id<'agents'>,
    acceptedAt: number,
    state: 'accepted' | 'accepting' = 'accepted',
  ): Promise<Id<'managerTransfers'>> {
    return await harness.run(async (ctx): Promise<Id<'managerTransfers'>> => {
      const transferId = await ctx.db.insert('managerTransfers', {
        agentId,
        agentName: 'Priya',
        fromOwnerKey: COMPANY_OWNER.subject,
        fromAddress: COMPANY_OWNER.email ?? '',
        toAddress: SUCCESSOR.email ?? '',
        state,
        requestedAt: acceptedAt - 60_000,
        expiresAt: acceptedAt + 1_209_600_000,
        decidedAt: acceptedAt,
        toOwnerKey: SUCCESSOR.subject,
      });
      if (state === 'accepted') {
        await ctx.db.patch(agentId, { userId: SUCCESSOR.subject, bossEmail: SUCCESSOR.email });
      }
      return transferId;
    });
  }

  it('counts the decisions on the employee page by the spans the reader held it, so a handover never credits the new manager with the old one’s (the v0.13.0 walk; D12)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priyaId = await deployEmployee(harness, {
      name: 'Priya',
      deployedAt: 100_000,
      charterApprovedAt: 110_000,
      decisions: [
        { requestedAt: 200_000, decidedAt: 210_000, via: 'dashboard', outcome: 'approved' },
        { requestedAt: 300_000, decidedAt: 305_000, via: 'dashboard', outcome: 'approved' },
        { requestedAt: 400_000, decidedAt: 430_000, via: 'channel', outcome: 'rejected' },
      ],
    });
    const before = await harness
      .withIdentity(COMPANY_OWNER)
      .query(api.metrics.forAgent, { agentId: priyaId });
    expect(before.decisions).toMatchObject({ approved: 2, rejected: 1 });

    await handOver(harness, priyaId, 500_000);
    const atAcceptance = await harness
      .withIdentity(SUCCESSOR)
      .query(api.metrics.forAgent, { agentId: priyaId });
    expect(atAcceptance.decisions).toMatchObject({
      requested: 0,
      approved: 0,
      rejected: 0,
      medianLatencyMs: null,
    });
    // What describes the employee rather than its manager's decisions stays its whole record.
    expect(atAcceptance.charter).toEqual(before.charter);

    // The new manager decides one plan, on an item the old manager's span left open.
    await harness.run(async (ctx): Promise<void> => {
      const workItemId = await ctx.db.insert('workItems', {
        agentId: priyaId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'PRIYA-OPEN',
        title: 'Priya item open at the handover',
        contentSummary: 'Synthetic company work.',
        contentRefs: [],
        state: 'plan-approved',
        observedAt: 450_000,
        createdAt: 450_000,
      });
      await ctx.db.insert('events', {
        agentId: priyaId,
        type: 'work.decision-requesting',
        payload: { workItemId, decisionId: 'successor-0', kind: 'plan' },
        createdAt: 600_000,
      });
      await ctx.db.insert('events', {
        agentId: priyaId,
        type: 'work.plan-approved',
        payload: { workItemId, decidedVia: 'dashboard' },
        createdAt: 612_000,
      });
    });
    const after = await harness
      .withIdentity(SUCCESSOR)
      .query(api.metrics.forAgent, { agentId: priyaId });
    expect(after.decisions).toMatchObject({
      requested: 1,
      approved: 1,
      rejected: 0,
      medianLatencyMs: 12_000,
    });
  });

  it('counts both of the reader’s spans when the employee was handed over and back (D12)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priyaId = await deployEmployee(harness, {
      name: 'Priya',
      deployedAt: 100_000,
      charterApprovedAt: 110_000,
      decisions: [
        { requestedAt: 200_000, decidedAt: 210_000, via: 'dashboard', outcome: 'approved' },
      ],
    });
    await handOver(harness, priyaId, 300_000);
    await harness.run(async (ctx): Promise<void> => {
      const workItemId = await ctx.db.insert('workItems', {
        agentId: priyaId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'PRIYA-SUCCESSOR',
        title: 'Decided by the successor',
        contentSummary: 'Synthetic company work.',
        contentRefs: [],
        state: 'failed',
        observedAt: 400_000,
        createdAt: 400_000,
      });
      await ctx.db.insert('events', {
        agentId: priyaId,
        type: 'work.cancelled',
        payload: { workItemId, decidedVia: 'dashboard' },
        createdAt: 410_000,
      });
      // The successor hands Priya back.
      await ctx.db.insert('managerTransfers', {
        agentId: priyaId,
        agentName: 'Priya',
        fromOwnerKey: SUCCESSOR.subject,
        fromAddress: SUCCESSOR.email ?? '',
        toAddress: COMPANY_OWNER.email ?? '',
        state: 'accepted',
        requestedAt: 440_000,
        expiresAt: 1_500_000_000,
        decidedAt: 500_000,
        toOwnerKey: COMPANY_OWNER.subject,
      });
      await ctx.db.patch(priyaId, {
        userId: COMPANY_OWNER.subject,
        bossEmail: COMPANY_OWNER.email,
      });
    });

    const back = await harness
      .withIdentity(COMPANY_OWNER)
      .query(api.metrics.forAgent, { agentId: priyaId });
    expect(back.decisions).toMatchObject({ approved: 1, rejected: 0 });
  });

  it('cuts nothing, rather than every decision, when the reader holds no span its handovers name', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priyaId = await deployEmployee(harness, {
      name: 'Priya',
      deployedAt: 100_000,
      decisions: [
        { requestedAt: 200_000, decidedAt: 210_000, via: 'dashboard', outcome: 'approved' },
      ],
    });
    await handOver(harness, priyaId, 300_000);
    // A row that disagrees with its handovers: the employee is on a third owner's key.
    const stranger = managerIdentity('stranger');
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(priyaId, { userId: stranger.subject, bossEmail: stranger.email });
    });

    const figures = await harness.withIdentity(stranger).query(api.metrics.forAgent, {
      agentId: priyaId,
    });
    expect(figures.decisions).toMatchObject({ approved: 1 });
  });

  it('keeps an item the old owner completed in their figures when the new owner retries it (D12)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priyaId = await deployEmployee(harness, { ...THREE_EMPLOYEES[0], completedAt: 130_000 });
    const doneId = await harness.run(async (ctx): Promise<Id<'workItems'>> => {
      const workItemId = await ctx.db.insert('workItems', {
        agentId: priyaId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'PRIYA-DONE',
        title: 'Priya item finished before the handover',
        contentSummary: 'Synthetic company work.',
        contentRefs: [],
        state: 'completed',
        manualEstimateMinutes: 30,
        observedAt: 140_000,
        createdAt: 140_000,
      });
      await ctx.db.insert('events', {
        agentId: priyaId,
        type: 'work.completed',
        payload: { workItemId },
        createdAt: 150_000,
      });
      return workItemId;
    });
    const before = await companyFigures(harness);
    expect(before.company.pilot.hoursSaved).toEqual({ estimatedItems: 1, hours: 0.5 });

    await handOver(harness, priyaId, 500_000);
    // The new manager retries it and the retry fails.
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(doneId, { state: 'failed', skipReason: 'the retry failed' });
      for (const [type, createdAt] of [
        ['work.retry', 700_000],
        ['work.failed', 710_000],
      ] as const) {
        await ctx.db.insert('events', {
          agentId: priyaId,
          type,
          payload: { workItemId: doneId },
          createdAt,
        });
      }
    });

    await expect(companyFigures(harness)).resolves.toEqual(before);
  });

  it('cuts the old owner’s figures at the acceptance while the move waits for runs, and never again at the move (D12, D18)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priyaId = await deployEmployee(harness, { ...THREE_EMPLOYEES[0], completedAt: 130_000 });
    const before = await companyFigures(harness);
    const transferId = await handOver(harness, priyaId, 500_000, 'accepting');
    // A run in flight at the acceptance settles before the move.
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('events', {
        agentId: priyaId,
        type: 'work.plan-approved',
        payload: { workItemId: 'settling', decidedVia: 'channel' },
        createdAt: 510_000,
      });
    });
    await expect(companyFigures(harness)).resolves.toEqual(before);

    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(transferId, { state: 'accepted' });
      await ctx.db.patch(priyaId, { userId: SUCCESSOR.subject, bossEmail: SUCCESSOR.email });
    });
    await expect(companyFigures(harness)).resolves.toEqual(before);
  });

  it('keeps every employee the roster lists when one more was handed over, the cap applied to each kind', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const departedId = await deployEmployee(harness, { name: 'Priya', deployedAt: 500 });
    for (let index = 0; index < 20; index += 1) {
      await deployEmployee(harness, { name: `Employee ${index + 1}`, deployedAt: 1_000 + index });
    }
    await handOver(harness, departedId, 500_000);
    const figures = await companyFigures(harness);
    expect(figures.omittedEmployees).toBe(0);
    expect(figures.company.employees).toBe(21);
    expect(figures.employees.map((row) => row.name)).toEqual([
      'Priya',
      ...Array.from({ length: 20 }, (_, index) => `Employee ${index + 1}`),
    ]);
  });

  it('keeps the old owner’s figures as they were after a handover, and counts the new owner’s from the acceptance (D12)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priyaId = await deployEmployee(harness, { ...THREE_EMPLOYEES[0], completedAt: 130_000 });
    await deployEmployee(harness, { ...THREE_EMPLOYEES[1], completedAt: 220_000 });
    // A plan the old manager was asked for and had not decided when Priya moved.
    const openItemId = await harness.run(async (ctx): Promise<Id<'workItems'>> => {
      const workItemId = await ctx.db.insert('workItems', {
        agentId: priyaId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'PRIYA-OPEN',
        title: 'Priya item open at the handover',
        contentSummary: 'Synthetic company work.',
        contentRefs: [],
        state: 'plan-pending',
        observedAt: 140_000,
        createdAt: 140_000,
      });
      await ctx.db.insert('events', {
        agentId: priyaId,
        type: 'work.decision-requesting',
        payload: { workItemId, decisionId: 'open-0', kind: 'plan' },
        createdAt: 141_000,
      });
      return workItemId;
    });
    const before = await companyFigures(harness);
    expect(before.employees.map((row) => row.name)).toEqual(['Priya', 'Mateo']);

    await handOver(harness, priyaId, 500_000);
    // The new manager approves the moved plan and its run lands a write on the row and its event.
    await harness.run(async (ctx): Promise<void> => {
      const output = { applied: [landedRow(openItemId, 7, 'manager', 'Commented on PRIYA-OPEN')] };
      await ctx.db.patch(openItemId, { state: 'completed', output, manualEstimateMinutes: 30 });
      await ctx.db.insert('events', {
        agentId: priyaId,
        type: 'work.plan-approved',
        payload: { workItemId: openItemId, decidedVia: 'dashboard' },
        createdAt: 610_000,
      });
      await ctx.db.insert('events', {
        agentId: priyaId,
        type: 'work.completed',
        payload: { workItemId: openItemId, output },
        createdAt: 620_000,
      });
    });
    // The new manager's own month with Priya: one plan, asked and approved after the acceptance.
    await harness.run(async (ctx): Promise<void> => {
      const workItemId = await ctx.db.insert('workItems', {
        agentId: priyaId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'PRIYA-NEW',
        title: 'Priya item for the new manager',
        contentSummary: 'Synthetic company work.',
        contentRefs: [],
        state: 'completed',
        observedAt: 590_000,
        createdAt: 590_000,
      });
      for (const [type, payload, createdAt] of [
        ['work.decision-requesting', { workItemId, decisionId: 'new-0', kind: 'plan' }, 600_000],
        ['work.plan-approved', { workItemId, decidedVia: 'dashboard' }, 603_000],
      ] as const) {
        await ctx.db.insert('events', { agentId: priyaId, type, payload, createdAt });
      }
    });

    await expect(companyFigures(harness)).resolves.toEqual(before);

    const successor = await harness.withIdentity(SUCCESSOR).query(api.metrics.forOwner, {});
    expect(successor?.employees.map((row) => row.name)).toEqual(['Priya']);
    expect(successor?.company.employees).toBe(1);
    // The new manager asked for one plan and decided two: their own and the moved one.
    expect(successor?.company.decisions).toMatchObject({
      requested: 1,
      approved: 2,
      rejected: 0,
      medianLatencyMs: 3_000,
    });
    // Priya's charter and her earlier writes were the old manager's; the moved plan's write is theirs.
    expect(successor?.company.charter.timesToFirstApprovedMs).toEqual([null]);
    expect(successor?.company.auditTrail).toEqual({ complete: 1, total: 1, fraction: 1 });
  });

  it('leaves out an employee handed over and since retired, whose records are gone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await deployEmployee(harness, { ...THREE_EMPLOYEES[1], completedAt: 220_000 });
    const before = await companyFigures(harness);
    const gone = await deployEmployee(harness, { name: 'Priya', deployedAt: 1_000 });
    await handOver(harness, gone, 500_000);
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.delete(gone);
    });
    await expect(companyFigures(harness)).resolves.toEqual(before);
  });

  it('refuses a caller with no identity (the anonymous-caller guard, 12-G)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await deployEmployee(harness, { name: 'Priya', deployedAt: 1_000 });
    await expect(harness.query(api.metrics.forOwner, {})).rejects.toMatchObject(
      await guardRefusal(),
    );
  });
});

describe('handoversFromTransfers', (): void => {
  const row = (fields: Partial<Doc<'managerTransfers'>>): Doc<'managerTransfers'> => ({
    _id: 'transfer1' as Id<'managerTransfers'>,
    _creationTime: 1,
    agentId: 'agent1' as Id<'agents'>,
    agentName: 'Priya',
    fromOwnerKey: 'ana',
    fromAddress: 'ana@day0.local',
    toAddress: 'ben@day0.local',
    state: 'accepted',
    requestedAt: 1,
    expiresAt: 2,
    decidedAt: 500,
    toOwnerKey: 'ben',
    ...fields,
  });

  it('cuts at the acceptance of a request moved or waiting for runs, and at no other state', (): void => {
    expect(
      handoversFromTransfers([
        row({}),
        row({ state: 'accepting', decidedAt: 600 }),
        row({ state: 'declined' }),
        row({ state: 'asked', decidedAt: undefined, toOwnerKey: undefined }),
      ]).map((handover) => handover.acceptedAt),
    ).toEqual([500, 600]);
  });

  it('leaves out an accepted row it cannot place, without its acceptance time or acceptor', (): void => {
    expect(
      handoversFromTransfers([row({ decidedAt: undefined }), row({ toOwnerKey: undefined })]),
    ).toEqual([]);
  });
});

describe('isEvaluationAgent', (): void => {
  it('reads the reserved address through the one evaluation-address check, in any spelling', (): void => {
    expect(
      isEvaluationAgent({
        bossEmail: ' EVAL-day0-r1-1758150000000@Day0.local ',
        name: 'Day0 evaluation 1',
        arm: 'day0',
      }),
    ).toBe(true);
    expect(
      isEvaluationAgent({
        bossEmail: 'Eval-Revocation-20260918t090000@day0.local',
        name: 'Day0 revocation evaluation',
      }),
    ).toBe(true);
  });

  it('never takes an ordinary manager whose address begins with eval- for an evaluation run', (): void => {
    for (const agent of [
      { bossEmail: 'eval-team@company.com', name: 'Day0 evaluation 1' },
      { bossEmail: 'eval-day0-r1-1758150000000@day0.local', name: 'Maya' },
      { bossEmail: 'eval-revocation-x@day0.local.example', name: 'Day0 revocation evaluation' },
      { bossEmail: 'lead@day0.local', name: 'Day0 revocation evaluation' },
    ]) {
      expect(isEvaluationAgent(agent), agent.bossEmail).toBe(false);
    }
    expect(isEvaluationAgent({ bossEmail: 'lead@day0.local', name: 'Maya', arm: 'baseline' })).toBe(
      true,
    );
  });
});

describe('the figures do not depend on the order the rows are read in', (): void => {
  // An export lists rows by id, the backend's index by creation time, and
  // events written in one mutation share a createdAt millisecond.
  const event = (
    creationTime: number,
    type: string,
    payload: Record<string, unknown>,
    createdAt: number,
  ): Doc<'events'> =>
    ({
      _id: `event-${creationTime}`,
      _creationTime: creationTime,
      agentId: 'agent',
      type,
      payload,
      createdAt,
    }) as unknown as Doc<'events'>;

  it('pairs a decision with a request written in the same millisecond however the two are listed', (): void => {
    const request = event(
      1,
      'work.decision-requesting',
      { workItemId: 'wi', decisionId: 'd', kind: 'plan' },
      5_000,
    );
    const approved = event(
      2,
      'work.plan-approved',
      { workItemId: 'wi', decidedVia: 'channel' },
      5_000,
    );
    const later = [
      event(
        3,
        'work.decision-requesting',
        { workItemId: 'wi2', decisionId: 'd2', kind: 'plan' },
        6_000,
      ),
      event(4, 'work.plan-approved', { workItemId: 'wi2', decidedVia: 'channel' }, 9_000),
    ];

    const indexOrder = computeAgentMetrics([request, approved, ...later], [], []);
    const idOrder = computeAgentMetrics([approved, request, ...later], [], []);

    expect(indexOrder.decisions).toMatchObject({
      requested: 2,
      approved: 2,
      medianLatencyMs: 1_500,
    });
    expect(idOrder).toEqual(indexOrder);
  });

  it('withdraws the plan ask a re-draft on reconnection replaced, so the figures count the second ask alone (wave 3.5 review M21)', (): void => {
    const minute = 60_000;
    const events = [
      event(1, 'work.decision-requesting', { workItemId: 'w1', decisionId: 'd1', kind: 'plan' }, 0),
      event(
        2,
        'work.plan-redrafting',
        { workItemId: 'w1', surfaceId: 's', slug: 'linear' },
        10 * minute,
      ),
      event(
        3,
        'work.decision-requesting',
        { workItemId: 'w1', decisionId: 'd2', kind: 'plan' },
        11 * minute,
      ),
      event(4, 'work.plan-approved', { workItemId: 'w1', decidedVia: 'dashboard' }, 12 * minute),
    ];
    expect(computeAgentMetrics(events, [], []).decisions).toMatchObject({
      requested: 1,
      approved: 1,
      medianLatencyMs: minute,
      byVia: { dashboard: { decided: 1, medianLatencyMs: minute } },
    });
  });

  it('dates Working from the first write that landed, never an approval alone (re-pinned: X finding 5)', (): void => {
    const decided = (creationTime: number, approvedIndexes: number[], at: number) =>
      event(
        creationTime,
        'work.actions-approved',
        {
          workItemId: 'w1',
          runId: `r${creationTime}`,
          approvedIndexes,
          rejectedIndexes: approvedIndexes.length > 0 ? [] : [0],
          refusedIndexes: [],
          autoIndexes: [],
          decidedVia: 'dashboard',
        },
        at,
      );
    const none = computeAgentMetrics([], [], []);
    expect([none.writeLanded, none.workingSince]).toEqual([false, null]);
    const approvedOnly = computeAgentMetrics(
      [decided(1, [], 5_000), decided(2, [0], 9_000)],
      [],
      [],
    );
    expect([approvedOnly.writeLanded, approvedOnly.workingSince]).toEqual([false, null]);
  });

  it('times a dashboard decision no chat surface asked for from when the item began waiting (walk m14)', (): void => {
    const minute = 60_000;
    const held = (indexes: number[]) => ({
      workItemId: 'w1',
      runId: 'r1',
      actionCount: 2,
      autoIndexes: [],
      heldIndexes: indexes,
      refusedIndexes: [],
    });
    const events = [
      event(1, 'work.plan-drafted', { workItemId: 'w1', plan: {} }, 0),
      event(2, 'work.plan-approved', { workItemId: 'w1', decidedVia: 'dashboard' }, 2 * minute),
      // A set holding nothing for the manager starts no wait.
      event(3, 'work.actions-pending', held([]), 2 * minute),
      event(4, 'work.actions-pending', held([0, 1]), 3 * minute),
      event(
        5,
        'work.actions-approved',
        {
          workItemId: 'w1',
          runId: 'r1',
          approvedIndexes: [0, 1],
          rejectedIndexes: [],
          refusedIndexes: [],
          autoIndexes: [],
          decidedVia: 'dashboard',
        },
        7 * minute,
      ),
    ];
    expect(computeAgentMetrics(events, [], []).decisions).toMatchObject({
      requested: 0,
      approved: 2,
      rejected: 0,
      medianLatencyMs: 3 * minute,
      byVia: { dashboard: { decided: 2, medianLatencyMs: 3 * minute } },
    });
  });

  it('times a re-drafted plan from its new draft, and a dashboard decision on an ask from the ask (walk m14, second pass)', (): void => {
    const minute = 60_000;
    const redrafted = [
      event(1, 'work.plan-drafted', { workItemId: 'w1', plan: {} }, 0),
      event(
        2,
        'work.plan-redrafting',
        { workItemId: 'w1', surfaceId: 's', slug: 'linear' },
        minute,
      ),
      event(3, 'work.plan-drafted', { workItemId: 'w1', plan: {} }, 5 * minute),
      event(4, 'work.plan-approved', { workItemId: 'w1', decidedVia: 'dashboard' }, 6 * minute),
    ];
    expect(computeAgentMetrics(redrafted, [], []).decisions).toMatchObject({
      requested: 0,
      approved: 1,
      medianLatencyMs: minute,
    });
    const asked = [
      event(1, 'work.plan-drafted', { workItemId: 'w2', plan: {} }, 0),
      event(
        2,
        'work.decision-requesting',
        { workItemId: 'w2', decisionId: 'd', kind: 'plan' },
        2 * minute,
      ),
      event(3, 'work.plan-approved', { workItemId: 'w2', decidedVia: 'dashboard' }, 3 * minute),
    ];
    expect(computeAgentMetrics(asked, [], []).decisions).toMatchObject({
      requested: 1,
      approved: 1,
      medianLatencyMs: minute,
      byVia: { dashboard: { decided: 1 } },
    });
  });

  it('uses backend write order for duplicate ledger observations in reversed and shuffled reads', (): void => {
    const row = (effect?: string): Record<string, unknown> => ({
      tool: 'mcp.call',
      ok: true,
      authority: 'manager',
      idempotencyKey: 'wi:run-1:0',
      ...(effect === undefined ? {} : { effect }),
    });
    const first = event(
      1,
      'work.failed',
      { workItemId: 'wi', output: { applied: [row()] } },
      5_000,
    );
    const second = event(
      2,
      'work.completed',
      { workItemId: 'wi', output: { applied: [row('landed')] } },
      5_000,
    );
    const other = event(3, 'agent.autonomy-changed', { from: false, to: true }, 6_000);
    const written = computeAgentMetrics([first, second, other], [], []);
    const reversed = computeAgentMetrics([other, second, first], [], []);
    const shuffled = computeAgentMetrics([second, other, first], [], []);

    expect(written.auditTrail).toEqual({ complete: 0, total: 1, fraction: 0 });
    expect(reversed).toEqual(written);
    expect(shuffled).toEqual(written);
  });
});

describe('the ledger walk and the pilot figures (step 29)', (): void => {
  let created = 0;
  const event = (
    type: string,
    payload: Record<string, unknown>,
    createdAt: number,
  ): Doc<'events'> =>
    ({
      _id: `event-${(created += 1)}`,
      _creationTime: created,
      agentId: 'agent',
      type,
      payload,
      createdAt,
    }) as unknown as Doc<'events'>;
  const item = (id: string, fields: Record<string, unknown> = {}): Doc<'workItems'> =>
    ({
      _id: id,
      _creationTime: 1,
      agentId: 'agent',
      state: 'completed',
      observedAt: 1_000,
      createdAt: 2_000,
      ...fields,
    }) as unknown as Doc<'workItems'>;
  const row = (key: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    tool: 'http.request',
    ok: true,
    authority: 'manager',
    effect: 'Commented on REVOPS-5',
    idempotencyKey: key,
    ...fields,
  });
  const slack = {
    _id: 'surface-slack',
    _creationTime: 1,
    agentId: 'agent',
    slug: 'slack',
    displayName: 'Slack',
    class: 'chat',
    verdict: 'connected',
    whereFound: [],
    credentialLanded: true,
    path: 'documented-api',
    endpoint: 'https://slack.com/api/',
    toolAllowlist: ['chat.postMessage', 'conversations.history'],
    managerDmChannelId: 'D0MANAGER',
    createdAt: 1,
  } as unknown as Doc<'surfaces'>;
  const post = (channel: string): Record<string, unknown> => ({
    tool: 'http.request',
    args: {
      surface: 'slack',
      method: 'POST',
      path: '/chat.postMessage',
      body: JSON.stringify({ channel, text: 'Done.' }),
    },
  });
  const history = {
    tool: 'http.request',
    args: { surface: 'slack', method: 'GET', path: '/conversations.history' },
  };

  it('keeps phase one’s landed rows in the figures while its closing set is held', (): void => {
    const pending = {
      phase: 'dependent',
      initial: {
        phase: 'dependent-authoring',
        actions: [post('C0TEAM')],
        applied: [row('wi:run-1:0')],
      },
      actions: [post('C0TEAM')],
      applied: [],
    };
    const metrics = computeAgentMetrics(
      [],
      [item('wi', { state: 'actions-pending', output: pending })],
      [],
    );
    expect(metrics.auditTrail).toEqual({ complete: 1, total: 1, fraction: 1 });
  });

  it('keeps the writes an earlier run landed when a retry replaces the output, and a reconciled write once', (): void => {
    const retried = {
      applied: [],
      landedWrites: [{ action: post('C0TEAM'), applied: row('wi:run-1:0') }],
    };
    const reconciled = event(
      'work.provider-reconciled',
      {
        workItemId: 'wi',
        entries: [
          {
            phase: 'single',
            actionIndex: 0,
            tool: 'http.request',
            outcome: 'landed',
            idempotencyKey: 'wi:run-1:0',
          },
          {
            phase: 'single',
            actionIndex: 1,
            tool: 'http.request',
            outcome: 'landed',
            idempotencyKey: 'wi:run-1:1',
            effect: 'Moved REVOPS-5 to Done',
          },
          {
            phase: 'single',
            actionIndex: 2,
            tool: 'http.request',
            outcome: 'outcome-unknown',
            idempotencyKey: 'wi:run-1:2',
          },
        ],
      },
      5_000,
    );
    const metrics = computeAgentMetrics(
      [reconciled],
      [item('wi', { state: 'failed', output: retried })],
      [],
    );
    // The carried write, and the one only the reconciliation records (it names no authority).
    expect(metrics.auditTrail).toEqual({ complete: 1, total: 2, fraction: 0.5 });
  });

  it('keys a closing set apart from phase one under the same run, even on its unflagged second pending event', (): void => {
    const events = [
      event(
        'work.actions-pending',
        { workItemId: 'wi', runId: 'run-1', heldIndexes: [0], refusedIndexes: [] },
        1_000,
      ),
      event(
        'work.actions-approved',
        {
          workItemId: 'wi',
          runId: 'run-1',
          approvedIndexes: [0],
          rejectedIndexes: [],
          decidedVia: 'dashboard',
        },
        2_000,
      ),
      event(
        'work.dependent-authoring',
        { workItemId: 'wi', runId: 'run-1', prerequisiteActionCount: 1 },
        3_000,
      ),
      event(
        'work.actions-pending',
        {
          workItemId: 'wi',
          runId: 'run-1',
          heldIndexes: [0],
          refusedIndexes: [],
          dependentPhase: true,
        },
        4_000,
      ),
      event(
        'work.actions-pending',
        {
          workItemId: 'wi',
          runId: 'run-1',
          heldIndexes: [0],
          refusedIndexes: [],
          autoApplied: true,
        },
        4_001,
      ),
      event(
        'work.actions-approved',
        {
          workItemId: 'wi',
          runId: 'attempt-2',
          approvedIndexes: [0],
          rejectedIndexes: [],
          decidedVia: 'dashboard',
        },
        5_000,
      ),
    ];
    expect(computeAgentMetrics(events, [], []).actions).toMatchObject({ held: 2, approved: 2 });
  });

  it('counts a closing refusal the hold and the ledger both saw once, by its durable index', (): void => {
    const events = [
      event(
        'work.dependent-authoring',
        { workItemId: 'wi', runId: 'run-1', prerequisiteActionCount: 2 },
        1_000,
      ),
      event(
        'work.actions-pending',
        {
          workItemId: 'wi',
          runId: 'run-1',
          heldIndexes: [],
          refusedIndexes: [0],
          dependentPhase: true,
          refusals: [{ index: 0, reason: 'no grant (linear:write)' }],
        },
        2_000,
      ),
    ];
    const output = {
      applied: [row('wi:run-1:2', { ok: false, reason: 'no grant (linear:write)' })],
    };
    expect(
      computeAgentMetrics(events, [item('wi', { state: 'failed', output })], []).actions.refused,
    ).toBe(1);
  });

  it('counts a skill as reused only on an item it was not made for, whichever item ran it first', (): void => {
    const events = [
      event('work.execution-claimed', { workItemId: 'a', skillId: 's1', proposedFor: 'b' }, 1_000),
      event('work.execution-claimed', { workItemId: 'b', skillId: 's1', proposedFor: 'b' }, 2_000),
    ];
    expect(computeAgentMetrics(events, [], []).pilot.skillReuse).toEqual({
      runs: 2,
      reused: 1,
      adopted: 0,
      rate: 0.5,
    });
  });

  it('an adopted run counts as reuse and in the adopted split (A14, 10-A)', (): void => {
    const events = [
      // Priya's own skill on the item it was made for: a run, not reuse.
      event(
        'work.execution-claimed',
        { workItemId: 'p1', skillId: 'sp', proposedFor: 'p1' },
        1_000,
      ),
      // Mateo's adopted copy on the item it was proposed for, and on a second item: both reuse,
      // since the skill was first made for Priya's work, and both adopted.
      event(
        'work.execution-claimed',
        { workItemId: 'm1', skillId: 'sm', proposedFor: 'm1', skillAdopted: true },
        2_000,
      ),
      event(
        'work.execution-claimed',
        { workItemId: 'm2', skillId: 'sm', proposedFor: 'm1', skillAdopted: true },
        3_000,
      ),
      // A second claim of one run is still one run.
      event(
        'work.execution-claimed',
        { workItemId: 'm2', skillId: 'sm', proposedFor: 'm1', skillAdopted: true },
        4_000,
      ),
    ];
    expect(computeAgentMetrics(events, [], []).pilot.skillReuse).toEqual({
      runs: 3,
      reused: 2,
      adopted: 2,
      rate: 2 / 3,
    });
  });

  it('pools the adopted split across employees in the company figure (A14, 10-A)', (): void => {
    const records = ['mateo', 'ana'].map((id, index) => ({
      agent: { _id: id as Id<'agents'>, name: id, createdAt: index },
      events: [
        event(
          'work.execution-claimed',
          { workItemId: `${id}-1`, skillId: `${id}-s`, proposedFor: `${id}-1`, skillAdopted: true },
          1_000 + index,
        ),
        event(
          'work.execution-claimed',
          { workItemId: `${id}-2`, skillId: `${id}-own`, proposedFor: `${id}-2` },
          2_000 + index,
        ),
      ],
      workItems: [],
      charters: [],
    }));
    const company = computeCompanyMetrics(records, { excludedAgents: 0, omittedEmployees: 0 });
    expect(company.company.pilot.skillReuse).toEqual({
      runs: 4,
      reused: 2,
      adopted: 2,
      rate: 0.5,
    });
    expect(company.employees.map((employee) => employee.metrics.pilot.skillReuse.adopted)).toEqual([
      1, 1,
    ]);
  });

  it('counts approving none of the held actions as a rejection of the decision and of each held action', (): void => {
    const events = [
      event(
        'work.decision-requesting',
        { workItemId: 'wi', decisionId: 'a1', kind: 'actions' },
        1_000,
      ),
      event(
        'work.actions-pending',
        { workItemId: 'wi', runId: 'run-1', heldIndexes: [0, 1], refusedIndexes: [] },
        1_001,
      ),
      event(
        'work.actions-approved',
        {
          workItemId: 'wi',
          runId: 'run-1',
          approvedIndexes: [],
          rejectedIndexes: [],
          decidedVia: 'channel',
        },
        9_000,
      ),
    ];
    const metrics = computeAgentMetrics(events, [], []);
    expect(metrics.decisions).toMatchObject({ approved: 0, rejected: 1, partiallyApproved: 0 });
    expect(metrics.actions).toMatchObject({ held: 2, approved: 0, rejected: 2 });
  });

  it('dates Working from a write the employee applied on its own when it came first, never a message to the manager (walk m12)', (): void => {
    const completed = (channel: string, at: number): Doc<'events'> =>
      event(
        'work.completed',
        {
          workItemId: 'wi',
          output: {
            actions: [post(channel)],
            applied: [row(`wi:run-${at}:0`, { authority: 'autonomous' })],
          },
        },
        at,
      );
    const approved = event(
      'work.actions-approved',
      {
        workItemId: 'wi2',
        runId: 'run-2',
        approvedIndexes: [0],
        rejectedIndexes: [],
        refusedIndexes: [],
        autoIndexes: [],
        decidedVia: 'dashboard',
      },
      9_000,
    );
    expect(
      computeAgentMetrics([completed('C0TEAM', 3_000), approved], [], [], [slack]).workingSince,
    ).toBe(3_000);
    expect(
      computeAgentMetrics([completed('D0MANAGER', 3_000)], [], [], [slack]).workingSince,
    ).toBeNull();
  });

  describe('the first supervised write that landed (X finding 5)', (): void => {
    const approvedAt = (at: number): Doc<'events'> =>
      event(
        'work.actions-approved',
        {
          workItemId: 'wi',
          runId: 'run-1',
          approvedIndexes: [0],
          rejectedIndexes: [],
          refusedIndexes: [],
          autoIndexes: [],
          decidedVia: 'dashboard',
        },
        at,
      );
    const finished = (type: string, applied: Record<string, unknown>[], at: number) =>
      event(type, { workItemId: 'wi', output: { actions: [post('C0TEAM')], applied } }, at);
    const figure = (events: Doc<'events'>[], items: Doc<'workItems'>[] = []) => {
      const metrics = computeAgentMetrics(events, items, [], [slack]);
      return { landed: metrics.writeLanded, since: metrics.workingSince };
    };

    it('is not an approval whose write then failed', (): void => {
      expect(
        figure([
          approvedAt(5_000),
          finished('work.failed', [row('wi:run-1:0', { ok: false, authority: undefined })], 6_000),
        ]),
      ).toEqual({ landed: false, since: null });
    });

    it('is the landing of a delayed write, not its approval', (): void => {
      expect(
        figure([approvedAt(5_000), finished('work.completed', [row('wi:run-1:0')], 90_000)]),
      ).toEqual({ landed: true, since: 90_000 });
    });

    it('is the landed write of a partial approval, the rest held', (): void => {
      expect(
        figure([
          approvedAt(5_000),
          finished(
            'work.completed',
            [
              row('wi:run-1:0'),
              row('wi:run-1:1', { held: true, reason: 'not approved by the manager' }),
            ],
            20_000,
          ),
        ]),
      ).toEqual({ landed: true, since: 20_000 });
      // Held and waiting rows alone have landed nothing.
      expect(
        figure([
          finished(
            'work.completed',
            [
              row('wi:run-1:0', { held: true }),
              row('wi:run-1:1', { awaitingApproval: true, authority: 'standing' }),
            ],
            20_000,
          ),
        ]),
      ).toEqual({ landed: false, since: null });
    });

    describe('dated by the landing time the apply path stamped on the row', (): void => {
      it('is not a failed write, which carries no landing time', (): void => {
        expect(
          figure([
            approvedAt(5_000),
            finished(
              'work.failed',
              [row('wi:run-1:0', { ok: false, reason: 'provider said no' })],
              6_000,
            ),
          ]),
        ).toEqual({ landed: false, since: null });
      });

      it('is the moment a delayed write landed, not the later event that carried it', (): void => {
        expect(
          figure([
            approvedAt(5_000),
            finished('work.completed', [row('wi:run-1:0', { landedAt: 61_000 })], 90_000),
          ]),
        ).toEqual({ landed: true, since: 61_000 });
      });

      it('is the landed row of a partial approval, never the rest that was held', (): void => {
        expect(
          figure([
            approvedAt(5_000),
            finished(
              'work.completed',
              [
                row('wi:run-1:0', { landedAt: 14_000 }),
                row('wi:run-1:1', { held: true, reason: 'not approved by the manager' }),
              ],
              20_000,
            ),
          ]),
        ).toEqual({ landed: true, since: 14_000 });
      });

      it('dates an auto-phase write whose held rest the manager then rejected, seen only on its work item', (): void => {
        const rejected = event(
          'work.actions-rejected',
          { workItemId: 'wi', reason: 'rejected by the manager', decidedVia: 'dashboard' },
          30_000,
        );
        const output = {
          actions: [post('C0TEAM'), post('C0TEAM')],
          applied: [
            row('wi:run-1:0', { authority: 'autonomous', landedAt: 12_000 }),
            row('wi:run-1:1', {
              ok: true,
              held: true,
              authority: undefined,
              reason: 'rejected by the manager',
            }),
          ],
        };
        expect(figure([rejected], [item('wi', { state: 'failed', output })])).toEqual({
          landed: true,
          since: 12_000,
        });
      });

      it('takes the earliest landing across writes, whichever event carried each', (): void => {
        const later = event(
          'work.completed',
          {
            workItemId: 'wi2',
            output: {
              actions: [post('C0TEAM')],
              applied: [row('wi2:run-2:0', { landedAt: 40_000 })],
            },
          },
          41_000,
        );
        expect(
          figure([
            later,
            finished('work.completed', [row('wi:run-1:0', { landedAt: 35_000 })], 50_000),
          ]),
        ).toEqual({ landed: true, since: 35_000 });
      });
    });

    it('has landed with no time while its row is seen only on its work item', (): void => {
      expect(
        figure(
          [approvedAt(5_000)],
          [item('wi', { output: { actions: [post('C0TEAM')], applied: [row('wi:run-1:0')] } })],
        ),
      ).toEqual({ landed: true, since: null });
    });

    it('is never a reconciliation copy, which carries no authority, nor a message to the manager', (): void => {
      const reconciled = event(
        'work.provider-reconciled',
        {
          workItemId: 'wi',
          entries: [{ tool: 'http.request', outcome: 'landed', idempotencyKey: 'wi:run-9:0' }],
        },
        4_000,
      );
      // The copy is in the ledger (the audit counts it), and is still no supervised write.
      expect(computeAgentMetrics([reconciled], [], [], [slack]).auditTrail.total).toBe(1);
      expect(
        figure([
          event(
            'work.provider-reconciled',
            {
              workItemId: 'wi',
              entries: [{ tool: 'http.request', outcome: 'landed', idempotencyKey: 'wi:run-9:0' }],
            },
            4_000,
          ),
          finished('work.completed', [], 5_000),
        ]),
      ).toEqual({ landed: false, since: null });
      expect(
        figure([
          event(
            'work.completed',
            {
              workItemId: 'wi',
              output: { actions: [post('D0MANAGER')], applied: [row('wi:run-2:0')] },
            },
            6_000,
          ),
        ]),
      ).toEqual({ landed: false, since: null });
    });
  });

  it('splits the automatic rows into reads, messages to the manager and writes', (): void => {
    const output = {
      actions: [history, post('D0MANAGER'), post('C0TEAM'), { tool: 'http.request', args: {} }],
      applied: [
        row('wi:run-1:0', { authority: 'standing' }),
        row('wi:run-1:1', { authority: 'standing' }),
        row('wi:run-1:2', { authority: 'autonomous' }),
        row('wi:run-1:3', { authority: 'autonomous' }),
      ],
    };
    const metrics = computeAgentMetrics([], [item('wi', { output })], [], [slack]);
    expect(metrics.actions.autoApplied).toBe(4);
    // The unparseable last row cannot be shown to be a read, so it counts as a write.
    expect(metrics.actions.automatic).toEqual({ reads: 1, managerMessages: 1, writes: 2 });
  });

  it('keeps a manager message the send recorded one after the manager DM moves, and a post it recorded a change (review M16)', (): void => {
    const output = {
      actions: [post('D0MANAGER'), post('C0TEAM')],
      applied: [
        row('wi:run-1:0', { authority: 'standing', actionClass: 'manager-dm' }),
        row('wi:run-1:1', { authority: 'autonomous', actionClass: 'public-post' }),
      ],
    };
    // The manager changed: the surface now names the team channel as the DM.
    const moved = { ...slack, managerDmChannelId: 'C0TEAM' };
    const metrics = computeAgentMetrics([], [item('wi', { output })], [], [moved]);
    expect(metrics.actions.automatic).toEqual({ reads: 0, managerMessages: 1, writes: 1 });
    const wiped = { ...slack, managerDmChannelId: undefined };
    expect(
      computeAgentMetrics([], [item('wi', { output })], [], [wiped]).actions.automatic,
    ).toEqual({ reads: 0, managerMessages: 1, writes: 1 });
  });

  it('counts the documentation an item’s prompts carried against its billed input tokens, with the graded recall (14-R)', (): void => {
    const events = [
      event(
        'work.documentation-selected',
        { workItemId: 'a', site: 'plan', blockIds: ['b1'], chars: 6_000 },
        1_000,
      ),
      event(
        'work.documentation-selected',
        { workItemId: 'a', site: 'execute', blockIds: ['b2'], chars: 4_000 },
        2_000,
      ),
      event(
        'work.model-call',
        { workItemId: 'a', stage: 'draft', outcome: 'ok', inputTokens: 9_000 },
        1_500,
      ),
      event(
        'work.model-call',
        { workItemId: 'a', stage: 'execution', outcome: 'ok', inputTokens: 11_000 },
        2_500,
      ),
      event(
        'work.documentation-selected',
        { workItemId: 'b', site: 'plan', blockIds: [], chars: 2_000 },
        3_000,
      ),
      event('work.model-call', { workItemId: 'b', stage: 'draft', outcome: 'ok' }, 3_500),
      event(
        'work.model-call',
        { workItemId: 'c', stage: 'evaluation', outcome: 'ok', inputTokens: 500 },
        4_000,
      ),
    ];
    expect(
      computeAgentMetrics(events, [item('a'), item('b'), item('c')], []).pilot.retrieval,
    ).toEqual({
      tokens: { items: 2, charsPerItem: 6_000, inputTokensPerItem: 20_000 },
      recall: RETRIEVAL_RECALL,
    });
    expect(computeAgentMetrics([], [], []).pilot.retrieval).toEqual({
      tokens: null,
      recall: RETRIEVAL_RECALL,
    });
  });

  it('computes skill reuse, cycle time from the ask, reorientation acceptance and the hours-saved gauge', (): void => {
    const events = [
      event('work.discovered', { workItemId: 'a' }, 1_500),
      event('work.execution-claimed', { workItemId: 'a', skillId: 's1', proposedFor: 'a' }, 2_000),
      event('work.execution-claimed', { workItemId: 'a', skillId: 's1', proposedFor: 'a' }, 2_500),
      event('work.failed', { workItemId: 'a', reason: 'stopped' }, 3_000),
      event('work.completed', { workItemId: 'a' }, 61_000),
      event('work.execution-claimed', { workItemId: 'b', skillId: 's1', proposedFor: 'a' }, 4_000),
      event('work.completed', { workItemId: 'b' }, 121_000),
      event('work.execution-claimed', { workItemId: 'c', skillId: 'builtin' }, 5_000),
      event('work.execution-claimed', { workItemId: 'd', skillId: 'builtin' }, 6_000),
      event('work.skipped', { workItemId: 'e' }, 7_000),
      event('charter.question-answered', { questionId: 'q1', amended: true }, 8_000),
      event('charter.question-answered', { questionId: 'q2', amended: false }, 9_000),
    ];
    const items = [
      item('a', { manualEstimateMinutes: 45 }),
      item('b', { manualEstimateMinutes: 45 }),
      item('c', { state: 'executing' }),
      item('d', { state: 'failed', manualEstimateMinutes: 600 }),
      item('e', { state: 'skipped' }),
    ];
    expect(computeAgentMetrics(events, items, []).pilot).toEqual({
      skillReuse: { runs: 4, reused: 2, adopted: 0, rate: 0.5 },
      cycleTime: {
        ended: 3,
        medianToEndMs: 6_000,
        completed: 2,
        medianToCompletionMs: 90_000,
        p90ToCompletionMs: 120_000,
      },
      reorientation: { answered: 2, amended: 1, rate: 0.5 },
      hoursSaved: { estimatedItems: 2, hours: 1.5 },
      retrieval: { tokens: null, recall: RETRIEVAL_RECALL },
    });
  });

  it('does not count a skip the manager overruled as the end of the item (review m36)', (): void => {
    const events = [
      // Skipped, then "Take it anyway": the item ends when its run does.
      event('work.skipped', { workItemId: 'e' }, 2_000),
      event(
        'work.retry',
        { workItemId: 'e', resumeState: 'discovered', fromState: 'skipped' },
        3_000,
      ),
      event('work.completed', { workItemId: 'e' }, 11_000),
      // Skipped and taken back, still running: it has not ended.
      event('work.skipped', { workItemId: 'f' }, 4_000),
      event(
        'work.retry',
        { workItemId: 'f', resumeState: 'discovered', fromState: 'skipped' },
        5_000,
      ),
    ];
    const items = [item('e'), item('f', { state: 'executing' })];
    expect(computeAgentMetrics(events, items, []).pilot.cycleTime).toEqual({
      ended: 1,
      medianToEndMs: 10_000,
      completed: 1,
      medianToCompletionMs: 10_000,
      p90ToCompletionMs: 10_000,
    });
  });
});
