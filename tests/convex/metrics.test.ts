import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import { computeAgentMetrics, type OwnerMetrics } from '../../convex/metrics';
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

  it('counts a resent request once, timing the decision from the first ask', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(async (ctx): Promise<Id<'agents'>> => {
      const id = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
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
        payload: { workItemId, kind: 'plan', decisionId: 'd-first', reason: 'request not delivered' },
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
        reason: 'browser session could not be re-established: browser_fill_form no grant (looker:write)',
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
  const COMPANY_OWNER = { subject: 'company-owner' };

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
        await ctx.db.patch(workItemId, { output: { applied: spec.ledger(workItemId) } });
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

  it('returns nothing to a caller with no identity', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await deployEmployee(harness, { name: 'Priya', deployedAt: 1_000 });
    await expect(harness.query(api.metrics.forOwner, {})).resolves.toBeNull();
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

  it(
    'pairs a decision with a request written in the same millisecond however the two are listed',
    (): void => {
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
    },
  );

  it('uses backend write order for duplicate ledger observations in reversed and shuffled reads', (): void => {
    const row = (effect?: string): Record<string, unknown> => ({
      tool: 'mcp.call',
      ok: true,
      authority: 'manager',
      idempotencyKey: 'wi:run-1:0',
      ...(effect === undefined ? {} : { effect }),
    });
    const first = event(1, 'work.failed', { workItemId: 'wi', output: { applied: [row()] } }, 5_000);
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
