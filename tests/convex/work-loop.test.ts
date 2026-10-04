/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { ExecutionOutput } from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import {
  AWAITING_CHARTER,
  EXECUTION_STALL_MS,
  MANAGER_CLAIM_LAPSED_REASON,
  MAX_DRAFT_RESUMES,
  STEP_LEASE_MS,
} from '../../convex/workLoop';
import { managerIdentity } from './fakes/manager-identity';

/**
 * The server drives each employee's work loop in real mode: a row entering a
 * state schedules its next step, a freed slot wakes the work queued at the
 * cap, and nothing waits for a dashboard page to be open. Every call below is
 * a server-side mutation or a scheduled job; no test calls the public
 * evaluate, draft or execute actions the page used to drive.
 */

const recorded = vi.hoisted(() => ({
  scopeCalls: [] as string[],
  /** Holds the charter judgement open until the test releases it. */
  scopeGate: undefined as Promise<void> | undefined,
  /** Thrown or answered by the charter judgement instead of its in-scope reply. */
  scopeOutcome: undefined as unknown,
  planCalls: [] as string[],
  /** Holds the planner open until the test releases it. */
  planGate: undefined as Promise<void> | undefined,
  skillRuns: [] as string[],
  http: [] as Array<{ url: string; body: unknown }>,
}));

const { schemaChecked } = await vi.hoisted(async () => await import('./fakes/mastra'));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: schemaChecked(async (args): Promise<unknown> => {
    if (args.agent.name === 'day0-scope-judgement') {
      recorded.scopeCalls.push(args.user);
      await recorded.scopeGate;
      if (recorded.scopeOutcome instanceof Error) throw recorded.scopeOutcome;
      if (recorded.scopeOutcome !== undefined) return recorded.scopeOutcome;
      return {
        inScope: true,
        fit: true,
        reason: 'close summaries are the charter work',
        exclusion: { kind: 'none', quote: '' },
      };
    }
    throw new Error(`unscripted agent ${args.agent.name}`);
  }),
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/work/plan', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/work/plan')>();
  return {
    ...original,
    draftExecutionPlan: async (args: { candidate: { title: string } }) => {
      recorded.planCalls.push(args.candidate.title);
      await recorded.planGate;
      return {
        summary: 'Tell the manager the close summary is ready.',
        steps: ['DM the manager that the close summary is ready.'],
        expectedOutputType: 'message',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 2,
      };
    },
  };
});

const managerDm: ExecutionOutput = {
  draft: 'The close summary is ready.',
  notes: '',
  actions: [
    {
      tool: 'http.request',
      args: {
        surface: 'slack',
        method: 'POST',
        path: '/chat.postMessage',
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
        body: JSON.stringify({ channel: 'D0MANAGER', text: 'The close summary is ready.' }),
      },
    },
  ],
};

vi.mock('../../src/work/execute-skill', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/work/execute-skill')>();
  return {
    ...original,
    runSkill: async (args: { candidate: { title: string } }): Promise<ExecutionOutput> => {
      recorded.skillRuns.push(args.candidate.title);
      return managerDm;
    },
  };
});

vi.mock('../../src/surfaces/credentials', () => import('./fakes/surface-credentials'));

vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit): Promise<Response> => {
  recorded.http.push({
    url: String(input),
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  });
  return new Response(JSON.stringify({ ok: true, ts: '1789000000.000100' }), { status: 200 });
});

type Harness = TestConvex<typeof schema>;
const OWNER = managerIdentity();

afterEach((): void => {
  recorded.scopeCalls.length = 0;
  recorded.scopeGate = undefined;
  recorded.scopeOutcome = undefined;
  recorded.planCalls.length = 0;
  recorded.planGate = undefined;
  recorded.skillRuns.length = 0;
  recorded.http.length = 0;
  vi.useRealTimers();
  restoreSurfaceMode();
});

/**
 * An employee with an approved charter, a registered skill for its Linear
 * tickets, the grants the evaluator asks for, a connected Linear queue and a
 * connected Slack manager channel. No work item yet.
 *
 * Args:
 *   harness: Convex test harness.
 *   options: The autonomy switch and the agent's boss address.
 *
 * Returns:
 *   The agent id.
 */
async function seedEmployee(
  harness: Harness,
  options: { autonomousActions?: boolean; bossEmail?: string } = {},
): Promise<Id<'agents'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: options.bossEmail ?? 'boss@day0.local',
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      autonomousActions: options.autonomousActions ?? false,
      createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId,
      version: 'v1',
      approved: true,
      approvedAt: 1,
      createdAt: 1,
      body: {
        proposedFunction: 'RevOps analyst',
        proposedBoundaries: { willDo: ['close summaries'], willNotDo: [], escalationTriggers: [] },
        approvalChain: { boss: 'boss@day0.local' },
      },
    });
    await ctx.db.insert('skills', {
      agentId,
      name: 'update-linear-ticket',
      description: 'Comment on and close a linear ticket.',
      body: 'Comment, then close.',
      sourceType: 'agent-authored',
      state: 'registered',
      createdAt: 1,
      registeredAt: 1,
    });
    for (const scope of ['boss:message', 'linear:read', 'linear:write', 'slack:read']) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
    const live = {
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      whereFound: [],
      createdAt: 1,
    };
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'connected',
      endpoint: 'https://mcp.linear.app/mcp',
      path: 'mcp',
      toolAllowlist: ['save_comment', 'save_issue'],
      credentialId: 'cred-linear',
      ...live,
    } as never);
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'connected',
      endpoint: 'https://slack.com/api/',
      path: 'documented-api',
      toolAllowlist: ['chat.postMessage'],
      credentialId: 'cred-slack',
      managerDmChannelId: 'D0MANAGER',
      managerUserId: 'UMANAGER',
      ...live,
    } as never);
    return agentId;
  });
}

/** Seed one Linear ticket the way the intake sweep does. */
async function seedTicket(
  harness: Harness,
  agentId: Id<'agents'>,
  externalId: string,
  title = `Triage the Linear close summary ${externalId}`,
): Promise<Id<'workItems'>> {
  return await harness.mutation(internal.work.seedItem, {
    agentId,
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId,
    title,
    contentSummary: 'Triage this Linear close summary revenue operations hand-off.',
    contentRefs: [`ticket://${externalId}`],
    priority: 'High',
  });
}

/** Run every job the scheduler holds that is due now, and every job those schedule. */
async function drain(harness: Harness): Promise<void> {
  await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0));
}

async function readItem(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

async function eventsOf(harness: Harness, type: string): Promise<Doc<'events'>[]> {
  return (await harness.run(async (ctx) => await ctx.db.query('events').collect())).filter(
    (event) => event.type === type,
  );
}

async function scheduledNames(harness: Harness): Promise<string[]> {
  return (
    await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
  )
    .map((row) => row.name)
    .sort();
}

/** Insert a discovered ticket directly, so nothing is scheduled for it. */
async function insertDiscovered(
  harness: Harness,
  agentId: Id<'agents'>,
  externalId: string,
): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId,
        title: `Triage the Linear close summary ${externalId}`,
        contentSummary: 'Triage this Linear close summary revenue operations hand-off.',
        contentRefs: [`ticket://${externalId}`],
        priority: 'High',
        state: 'discovered',
        observedAt: Date.now(),
        createdAt: Date.now(),
      }),
  );
}

describe('the server-side steps', (): void => {
  it("does not let a pre-claim failure stop another caller's execution", async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await insertDiscovered(harness, agentId, 'REVOPS-10');
    const skillId = await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, { state: 'plan-approved' });
      const skill = await ctx.db.query('skills').first();
      if (!skill) throw new Error('skill missing');
      return skill._id;
    });
    const claim = await harness.mutation(internal.workRuns.claimForExecution, {
      workItemId,
      skillId,
    });
    expect(claim.claimed).toBe(true);

    await harness.mutation(internal.workRuns.setFailed, {
      workItemId,
      reason: 'no registered skill matches source surface linear',
    });

    expect((await readItem(harness, workItemId)).state).toBe('executing');
    expect(await eventsOf(harness, 'work.failed')).toEqual([]);
  });

  it('evaluates and drafts through internal reads, with no caller identity', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await insertDiscovered(harness, agentId, 'REVOPS-11');

    await expect(
      harness.action(internal.workActions.evaluateWorkItemInternal, { workItemId }),
    ).resolves.toEqual({ decision: 'claim' });
    const claimed = await readItem(harness, workItemId);
    expect(claimed.state).toBe('claimed');
    expect(claimed).not.toHaveProperty('evaluationClaimedAt');

    await expect(
      harness.action(internal.workActions.draftPlanInternal, { workItemId }),
    ).resolves.toEqual({ ok: true });
    const drafted = await readItem(harness, workItemId);
    expect(drafted.state).toBe('plan-pending');
    expect(drafted).not.toHaveProperty('draftClaimedAt');
    expect(recorded.scopeCalls).toHaveLength(1);
    expect(recorded.planCalls).toEqual(['Triage the Linear close summary REVOPS-11']);
  });

  it('spends one planner call when a second draft arrives while the first holds the claim', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await insertDiscovered(harness, agentId, 'REVOPS-12');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, { state: 'claimed', verdict: { decision: 'claim' } });
    });
    let release = (): void => {};
    recorded.planGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = harness.action(internal.workActions.draftPlanInternal, { workItemId });
    await vi.waitFor(() => expect(recorded.planCalls).toHaveLength(1));
    await expect(
      harness.action(internal.workActions.draftPlanInternal, { workItemId }),
    ).resolves.toEqual({ ok: false, reason: 'another draft of this work item is running' });
    release();
    await expect(first).resolves.toEqual({ ok: true });

    expect(recorded.planCalls).toHaveLength(1);
    expect((await readItem(harness, workItemId)).state).toBe('plan-pending');
  });

  it('leaves a failed step claimed until the lease passes, then lets the next run take it', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await insertDiscovered(harness, agentId, 'REVOPS-13');
    await harness.run(async (ctx) => {
      const charter = await ctx.db.query('charters').first();
      if (charter) await ctx.db.patch(charter._id, { approved: false });
    });

    await expect(
      harness.action(internal.workActions.evaluateWorkItemInternal, { workItemId }),
    ).rejects.toThrow('cannot evaluate: charter not approved');
    await expect(
      harness.action(internal.workActions.evaluateWorkItemInternal, { workItemId }),
    ).resolves.toEqual({ decision: 'noop-claimed' });

    await harness.run(async (ctx) => {
      const charter = await ctx.db.query('charters').first();
      if (charter) await ctx.db.patch(charter._id, { approved: true });
    });
    vi.advanceTimersByTime(10 * 60 * 1000);
    await expect(
      harness.action(internal.workActions.evaluateWorkItemInternal, { workItemId }),
    ).resolves.toEqual({ decision: 'claim' });
  });

  it('evaluates a queued row again only once the employee has a free slot', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const open = await insertDiscovered(harness, agentId, 'REVOPS-15');
    const workItemId = await insertDiscovered(harness, agentId, 'REVOPS-16');
    await harness.run(async (ctx) => {
      await ctx.db.patch(open, { state: 'plan-pending', verdict: { decision: 'claim' } });
      await ctx.db.patch(workItemId, {
        verdict: { decision: 'queue', reason: 'WIP cap reached: supervised cold-start limit is 1' },
      });
    });

    await expect(
      harness.action(internal.workActions.evaluateWorkItemInternal, { workItemId }),
    ).resolves.toEqual({ decision: 'noop-queued' });
    expect(recorded.scopeCalls).toEqual([]);
    expect(await readItem(harness, workItemId)).not.toHaveProperty('evaluationClaimedAt');

    await harness.run(async (ctx) => {
      await ctx.db.patch(open, { state: 'cancelled' });
    });
    await expect(
      harness.action(internal.workActions.evaluateWorkItemInternal, { workItemId }),
    ).resolves.toEqual({ decision: 'claim' });
    expect(recorded.scopeCalls).toHaveLength(1);
  });

  it('claims nothing when the dashboard drives the loop in mock mode', async (): Promise<void> => {
    useSurfaceMode('mock');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await insertDiscovered(harness, agentId, 'REVOPS-14');
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, { state: 'claimed', verdict: { decision: 'claim' } });
    });

    await expect(
      harness.action(internal.workActions.draftPlanInternal, { workItemId }),
    ).resolves.toEqual({ ok: false, reason: 'the server loop is real-mode only' });
    await harness.withIdentity(OWNER).action(api.workActions.draftPlan, { workItemId });
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('plan-pending');
    expect(row).not.toHaveProperty('draftClaimedAt');
  });
});

describe('the server drives the work loop in real mode', (): void => {
  it('takes an intake-seeded row to a drafted plan and a decision request with no client call', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);

    const workItemId = await seedTicket(
      harness,
      agentId,
      'REVOPS-21',
      'Add the Q3 close-summary audit note',
    );
    await drain(harness);

    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('plan-pending');
    expect(row.plan).toMatchObject({ summary: 'Tell the manager the close summary is ready.' });
    expect(row.decision).toMatchObject({ kind: 'plan', ts: '1789000000.000100' });
    expect(recorded.scopeCalls).toHaveLength(1);
    expect(recorded.planCalls).toEqual(['Add the Q3 close-summary audit note']);
    expect(recorded.skillRuns).toEqual([]);
    expect(
      recorded.http
        .filter((call) => call.url.endsWith('/chat.postMessage'))
        .map((call) => call.body),
    ).toEqual([expect.objectContaining({ channel: 'D0MANAGER' })]);
  });

  it('executes a plan approved from the dashboard with no client call', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await seedTicket(harness, agentId, 'REVOPS-22');
    await drain(harness);
    expect((await readItem(harness, workItemId)).state).toBe('plan-pending');

    await harness.withIdentity(OWNER).mutation(api.work.approvePlan, { workItemId });
    await drain(harness);

    expect(recorded.skillRuns).toEqual(['Triage the Linear close summary REVOPS-22']);
    expect(await eventsOf(harness, 'work.execution-claimed')).toHaveLength(1);
    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('completed');
    expect(await eventsOf(harness, 'work.completed')).toHaveLength(1);
  });

  it('holds the second row at the supervised cap without a scope call until the first completes', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const first = await seedTicket(harness, agentId, 'REVOPS-23');
    await drain(harness);
    const second = await seedTicket(harness, agentId, 'REVOPS-24');
    await drain(harness);

    expect((await readItem(harness, first)).state).toBe('plan-pending');
    const queued = await readItem(harness, second);
    expect(queued.state).toBe('discovered');
    expect(queued.verdict).toBeUndefined();
    expect(recorded.scopeCalls).toHaveLength(1);
    expect(recorded.planCalls).toEqual(['Triage the Linear close summary REVOPS-23']);

    await harness.withIdentity(OWNER).mutation(api.work.approvePlan, { workItemId: first });
    await drain(harness);

    expect((await readItem(harness, first)).state).toBe('completed');
    const resumed = await readItem(harness, second);
    expect(resumed.state).toBe('plan-pending');
    expect(recorded.planCalls).toEqual([
      'Triage the Linear close summary REVOPS-23',
      'Triage the Linear close summary REVOPS-24',
    ]);
  });

  it('hands the slots the autonomy switch adds to the work queued at the supervised cap', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const first = await seedTicket(harness, agentId, 'REVOPS-28');
    await drain(harness);
    const second = await seedTicket(harness, agentId, 'REVOPS-29');
    const third = await seedTicket(harness, agentId, 'REVOPS-30');
    await drain(harness);
    expect((await readItem(harness, first)).state).toBe('plan-pending');
    expect((await readItem(harness, second)).verdict).toBeUndefined();
    expect((await readItem(harness, third)).verdict).toBeUndefined();
    expect(recorded.scopeCalls).toHaveLength(1);

    await harness
      .withIdentity(OWNER)
      .mutation(api.agents.setAutonomousActions, { agentId, on: true });
    await drain(harness);

    for (const workItemId of [second, third]) {
      expect((await readItem(harness, workItemId)).state).toBe('completed');
    }
    expect((await readItem(harness, first)).state).toBe('plan-pending');
  });

  it('takes a retried failed row back to execution', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await seedTicket(harness, agentId, 'REVOPS-25');
    await drain(harness);
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        state: 'failed',
        skipReason: 'stopped: the manager DM did not land',
        output: { ...managerDm, applied: [{ tool: 'http.request', ok: false, reason: 'timeout' }] },
      });
    });

    await harness
      .withIdentity(OWNER)
      .mutation(api.workRuns.retryFailed, { workItemId, feedback: 'Send it again.' });
    await drain(harness);

    expect(recorded.skillRuns).toEqual(['Triage the Linear close summary REVOPS-25']);
    expect(await eventsOf(harness, 'work.execution-claimed')).toHaveLength(1);
    expect((await readItem(harness, workItemId)).state).toBe('completed');
  });

  it('spends one evaluation model call on a seed and a re-evaluation that arrive together', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    let release = (): void => {};
    recorded.scopeGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const workItemId = await seedTicket(harness, agentId, 'REVOPS-26');
    vi.advanceTimersByTime(0);
    await vi.waitFor(() => expect(recorded.scopeCalls).toHaveLength(1));

    const second = await harness.action(internal.workActions.evaluateWorkItemInternal, {
      workItemId,
    });
    expect(second.decision).toMatch(/^noop/);
    release();
    await drain(harness);

    expect(recorded.scopeCalls).toHaveLength(1);
    expect((await readItem(harness, workItemId)).state).toBe('plan-pending');
  });

  it('schedules nothing for a revocation trial row', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_EVALUATION_BED', 'revocation-test');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness, { bossEmail: 'eval-revocation-01@day0.local' });

    const { workItemId } = await harness
      .withIdentity(OWNER)
      .mutation(api.revocationEvaluation.seedTrial, {
        agentId,
        trialId: 'rev-scope-01',
        kind: 'queued-read',
      });
    await harness.mutation(internal.work.resumeStalledSteps, {});
    await harness.mutation(internal.work.setVerdict, {
      workItemId,
      verdict: { decision: 'claim', value: 60, risk: 30, requiredPermissions: ['slack:read'] },
    });

    for (const [index, kind] of (
      ['held-dm', 'approved-write', 'auto-read', 'auto-write'] as const
    ).entries()) {
      const trial = await harness.withIdentity(OWNER).mutation(api.revocationEvaluation.seedTrial, {
        agentId,
        trialId: `rev-scope-0${index + 2}`,
        kind,
      });
      await harness.mutation(internal.work.resumeStalledSteps, {});
      await harness.mutation(internal.revocationEvaluation.recordOutcome, {
        workItemId: trial.workItemId,
        applied: [{ tool: 'http.request', ok: true }],
      });
    }

    expect((await readItem(harness, workItemId)).state).toBe('claimed');
    expect(await scheduledNames(harness)).toEqual([]);
  });

  it('does not exempt ordinary work that shares a trial-shaped external id', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);

    await seedTicket(harness, agentId, 'EVAL-rev-scope-01');

    expect(await scheduledNames(harness)).toContain('workActions:evaluateWorkItemInternal');
  });

  it('schedules nothing in mock mode', async (): Promise<void> => {
    useSurfaceMode('mock');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);

    const workItemId = await seedTicket(harness, agentId, 'REVOPS-27');
    await harness.mutation(internal.work.setVerdict, {
      workItemId,
      verdict: { decision: 'claim', value: 60, risk: 30, requiredPermissions: ['linear:read'] },
    });
    await harness.mutation(internal.work.setPlan, {
      workItemId,
      plan: {
        summary: 'x',
        steps: ['x'],
        expectedOutputType: 'message',
        riskNotes: '',
        reversibility: 'r',
        estimatedMinutes: 1,
      },
    });
    await harness.withIdentity(OWNER).mutation(api.work.approvePlan, { workItemId });
    await harness.mutation(internal.work.resumeStalledSteps, {});

    expect((await readItem(harness, workItemId)).state).toBe('plan-approved');
    expect(
      (await scheduledNames(harness)).filter((name) => name.startsWith('workActions:')),
    ).toEqual([]);
    const row = await readItem(harness, workItemId);
    expect(row).not.toHaveProperty('evaluationClaimedAt');
    expect(row).not.toHaveProperty('draftClaimedAt');
  });
});

describe('the loop under load (P9-1)', (): void => {
  /**
   * Insert discovered tickets directly, so nothing is scheduled for them.
   *
   * Args:
   *   harness: Convex test harness.
   *   agentId: The employee.
   *   rows: Each ticket's external id and priority.
   *
   * Returns:
   *   The work item ids, in insertion order.
   */
  async function insertQueue(
    harness: Harness,
    agentId: Id<'agents'>,
    rows: ReadonlyArray<{ externalId: string; priority?: string; verdict?: unknown }>,
  ): Promise<Id<'workItems'>[]> {
    return await harness.run(async (ctx) => {
      const ids: Id<'workItems'>[] = [];
      for (const row of rows) {
        ids.push(
          await ctx.db.insert('workItems', {
            agentId,
            sourceCategory: 'ticket-queue',
            sourceSystem: 'linear',
            externalId: row.externalId,
            title: `Triage the Linear close summary ${row.externalId}`,
            contentSummary: 'Triage this Linear close summary revenue operations hand-off.',
            contentRefs: [`ticket://${row.externalId}`],
            ...(row.priority === undefined ? {} : { priority: row.priority }),
            ...(row.verdict === undefined ? {} : { verdict: row.verdict }),
            state: 'discovered',
            observedAt: Date.now(),
            createdAt: Date.now(),
          }),
        );
      }
      return ids;
    });
  }

  /** The work items the scheduler holds an evaluation for. */
  async function scheduledEvaluations(harness: Harness): Promise<string[]> {
    return (
      await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
    )
      .filter((job) => job.name === 'workActions:evaluateWorkItemInternal')
      .map((job) => String((job.args[0] as { workItemId: string }).workItemId));
  }

  it('claims an evaluation only while a slot is free, an evaluation in flight holding one', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness, { autonomousActions: true });
    const rows = await insertQueue(
      harness,
      agentId,
      ['REVOPS-60', 'REVOPS-61', 'REVOPS-62', 'REVOPS-63', 'REVOPS-64'].map((externalId) => ({
        externalId,
      })),
    );

    const claims = [];
    for (const workItemId of rows) {
      claims.push(
        await harness.mutation(internal.work.claimLoopStep, { workItemId, step: 'evaluation' }),
      );
    }

    expect(claims).toEqual([
      { claimed: true, claimedAt: expect.any(Number) },
      { claimed: true, claimedAt: expect.any(Number) },
      { claimed: true, claimedAt: expect.any(Number) },
      { claimed: false, reason: 'queued' },
      { claimed: false, reason: 'queued' },
    ]);
  });

  it('gives a free slot to the most urgent waiting row, then the oldest', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const [, , urgent] = await insertQueue(harness, agentId, [
      { externalId: 'REVOPS-70', priority: 'Low' },
      { externalId: 'REVOPS-71', priority: 'No priority' },
      { externalId: 'REVOPS-72', priority: 'Urgent' },
      { externalId: 'REVOPS-73', priority: 'High' },
      { externalId: 'REVOPS-74', priority: 'Urgent' },
    ]);

    await harness.mutation(internal.work.resumeStalledSteps, {});

    expect(await scheduledEvaluations(harness)).toEqual([String(urgent)]);
  });

  it('sweeps a deep backlog within the transaction limits, waking only what the free slots admit', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    // A backlog deeper than the limit allows reading in one transaction: the
    // sweep reads a bounded window of it, not every waiting row.
    const harness = convexTest({
      schema: contractSchema(),
      modules: allConvexModules(),
      transactionLimits: { documentsRead: 400 },
    });
    const agentId = await seedEmployee(harness);
    const backlog = Array.from({ length: 600 }, (_, index) => ({
      externalId: `REVOPS-${1000 + index}`,
      verdict: { decision: 'queue', reason: 'WIP cap reached: supervised cold-start limit is 1' },
    }));
    const [oldest] = await insertQueue(harness, agentId, backlog);

    await harness.mutation(internal.work.resumeStalledSteps, {});

    expect(await scheduledEvaluations(harness)).toEqual([String(oldest)]);
  });
});

describe('a scope call that fails parks the row (E-70)', (): void => {
  it.each([
    ['throws', new Error('provider answered 503'), 'provider answered 503'],
    [
      'times out',
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      'The operation was aborted due to timeout',
    ],
    [
      "answers `inScope: 'yes'`",
      { inScope: 'yes', fit: true, reason: 'looks fine', exclusion: { kind: 'none', quote: '' } },
      'agentJson(day0-scope-judgement): reply did not satisfy the schema',
    ],
  ])(
    'never executes an item whose scope call %s under autonomy, and records only the unavailable event',
    async (_how, outcome, cause): Promise<void> => {
      useSurfaceMode('real');
      vi.useFakeTimers();
      const harness = convexTest(contractSchema(), allConvexModules());
      const agentId = await seedEmployee(harness, { autonomousActions: true });
      recorded.scopeOutcome = outcome;

      const workItemId = await seedTicket(harness, agentId, 'REVOPS-70');
      await drain(harness);

      const row = await readItem(harness, workItemId);
      expect(row.state).toBe('discovered');
      expect(row).not.toHaveProperty('verdict');
      expect(row).not.toHaveProperty('scopeAdmission');
      expect(recorded.scopeCalls).toHaveLength(1);
      expect(recorded.planCalls).toEqual([]);
      expect(recorded.skillRuns).toEqual([]);
      expect(
        (await eventsOf(harness, 'work.scope-judgement-unavailable')).map((e) => e.payload),
      ).toEqual([{ workItemId, cause }]);
      expect(await eventsOf(harness, 'work.evaluated')).toEqual([]);
      expect(await eventsOf(harness, 'work.execution-claimed')).toEqual([]);
    },
  );

  it('re-admits a parked row at the first sweep after its lease, once the scope call answers', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    recorded.scopeOutcome = new Error('provider answered 503');
    const workItemId = await seedTicket(harness, agentId, 'REVOPS-71');
    await drain(harness);
    expect((await readItem(harness, workItemId)).state).toBe('discovered');

    // Inside the lease the sweep leaves the parked row alone: no second call.
    recorded.scopeOutcome = undefined;
    await harness.mutation(internal.work.resumeStalledSteps, {});
    await drain(harness);
    expect(recorded.scopeCalls).toHaveLength(1);
    expect((await readItem(harness, workItemId)).state).toBe('discovered');

    vi.advanceTimersByTime(STEP_LEASE_MS);
    await harness.mutation(internal.work.resumeStalledSteps, {});
    await drain(harness);

    expect(recorded.scopeCalls).toHaveLength(2);
    expect((await readItem(harness, workItemId)).state).toBe('plan-pending');
    expect(await eventsOf(harness, 'work.scope-judgement-unavailable')).toHaveLength(1);
    expect((await eventsOf(harness, 'work.evaluated')).map((event) => event.payload)).toEqual([
      expect.objectContaining({ workItemId, decision: 'claim' }),
    ]);
  });
});

describe('an evaluation that keeps dying (wave 2 review M23, E-70 D2)', (): void => {
  /** The rows the sweep scheduled an evaluation for. */
  async function scheduledEvaluations(harness: Harness): Promise<unknown[]> {
    return (
      await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
    )
      .filter((job) => job.name === 'workActions:evaluateWorkItemInternal')
      .map((job) => (job.args[0] as { workItemId: unknown }).workItemId);
  }

  /** A waiting row whose evaluation began `attempts` times and last died a lease ago. */
  async function diedRow(
    harness: Harness,
    agentId: Id<'agents'>,
    externalId: string,
    attempts: number,
    unavailable = false,
  ): Promise<Id<'workItems'>> {
    const workItemId = await insertDiscovered(harness, agentId, externalId);
    const claimedAt = Date.now() - STEP_LEASE_MS - 1;
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        evaluationAttempts: attempts,
        evaluationClaimedAt: claimedAt,
        ...(unavailable ? { evaluationUnavailableAt: claimedAt + 1 } : {}),
      });
    });
    return workItemId;
  }

  it('counts each evaluation it starts, and forgets the count once a verdict lands', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    recorded.scopeOutcome = new Error('provider answered 503');
    const workItemId = await seedTicket(harness, agentId, 'REVOPS-80');
    await drain(harness);
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'discovered',
      evaluationAttempts: 1,
      evaluationUnavailableAt: expect.any(Number),
      evaluationUnavailableCause: expect.stringContaining('provider answered 503'),
    });

    recorded.scopeOutcome = undefined;
    vi.advanceTimersByTime(STEP_LEASE_MS);
    await harness.mutation(internal.work.resumeStalledSteps, {});
    await drain(harness);
    const evaluated = await readItem(harness, workItemId);
    expect(evaluated.state).toBe('plan-pending');
    expect(evaluated).not.toHaveProperty('evaluationAttempts');
    expect(evaluated).not.toHaveProperty('evaluationUnavailableAt');
    expect(evaluated).not.toHaveProperty('evaluationUnavailableCause');
  });

  it('marks a row unavailable only for the attempt that holds its claim, never from a late answer of a lapsed one', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await insertDiscovered(harness, agentId, 'REVOPS-86');
    const first = await harness.mutation(internal.work.claimLoopStep, {
      workItemId,
      step: 'evaluation',
    });
    if (!first.claimed) throw new Error('the first attempt claims');
    vi.advanceTimersByTime(STEP_LEASE_MS + 1);
    const second = await harness.mutation(internal.work.claimLoopStep, {
      workItemId,
      step: 'evaluation',
    });
    if (!second.claimed) throw new Error('the second attempt claims once the first lapsed');

    await harness.mutation(internal.work.recordScopeJudgementUnavailable, {
      workItemId,
      cause: 'provider answered 503',
      claimedAt: first.claimedAt,
    });
    expect(await readItem(harness, workItemId)).not.toHaveProperty('evaluationUnavailableAt');
    expect(await readItem(harness, workItemId)).not.toHaveProperty('evaluationUnavailableCause');
    await harness.mutation(internal.work.recordScopeJudgementUnavailable, {
      workItemId,
      cause: 'provider answered 503',
      claimedAt: second.claimedAt,
    });
    expect(await readItem(harness, workItemId)).toMatchObject({
      evaluationAttempts: 2,
      evaluationUnavailableAt: expect.any(Number),
      evaluationUnavailableCause: 'provider answered 503',
    });
  });

  it('gives the free slot at cap one to the next row while an evaluation that died twice waits behind it', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const dying = await diedRow(harness, agentId, 'REVOPS-81', 2);
    vi.advanceTimersByTime(1);
    const next = await insertDiscovered(harness, agentId, 'REVOPS-82');

    await harness.mutation(internal.work.resumeStalledSteps, {});

    expect(await scheduledEvaluations(harness)).toEqual([next]);
    expect((await readItem(harness, dying)).state).toBe('discovered');
  });

  it('parks a row whose evaluation died three times, with the event, and evaluates the next', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const dying = await diedRow(harness, agentId, 'REVOPS-83', 3);
    const next = await insertDiscovered(harness, agentId, 'REVOPS-84');

    await harness.mutation(internal.work.resumeStalledSteps, {});

    expect(await readItem(harness, dying)).toMatchObject({
      state: 'deferred',
      verdict: { decision: 'defer', reason: 'evaluation-attempts-spent', attempts: 3 },
    });
    expect((await readItem(harness, dying)).evaluationClaimedAt).toBeUndefined();
    expect(
      (await eventsOf(harness, 'work.evaluation-parked')).map((event) => event.payload),
    ).toEqual([{ workItemId: dying, attempts: 3, reason: 'evaluation-attempts-spent' }]);
    expect(await scheduledEvaluations(harness)).toEqual([next]);

    // Nothing but the manager's Retry brings it back.
    await harness.mutation(internal.work.reevaluatePending, {
      agentId,
      trigger: 'charter',
      key: 'charter:amended',
    });
    await harness.mutation(internal.work.readmitSatisfiedDeferrals, { agentId });
    expect((await readItem(harness, dying)).state).toBe('deferred');
    await harness.withIdentity(OWNER).mutation(api.workRuns.retryFailed, { workItemId: dying });
    const retried = await readItem(harness, dying);
    expect(retried.state).toBe('discovered');
    expect(retried).not.toHaveProperty('evaluationAttempts');
  });

  it('parks a row whose last evaluation could not reach the scope judgement as unavailable, and re-admits it on the charter trigger and on Check for new work', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const parked = await diedRow(harness, agentId, 'REVOPS-85', 3, true);
    await harness.mutation(internal.work.resumeStalledSteps, {});
    expect(await readItem(harness, parked)).toMatchObject({
      state: 'deferred',
      verdict: { decision: 'defer', reason: 'scope-judgement-unavailable', attempts: 3 },
    });

    await harness.mutation(internal.work.reevaluatePending, {
      agentId,
      trigger: 'charter',
      key: 'charter:amended',
    });
    const readmitted = await readItem(harness, parked);
    expect(readmitted.state).toBe('discovered');
    expect(readmitted).not.toHaveProperty('evaluationAttempts');

    await harness.run(async (ctx) => {
      await ctx.db.patch(parked, {
        state: 'deferred',
        verdict: { decision: 'defer', reason: 'scope-judgement-unavailable', attempts: 3 },
      });
    });
    await harness.mutation(internal.work.readmitSatisfiedDeferrals, { agentId });
    expect((await readItem(harness, parked)).state).toBe('discovered');
  });
});

describe('checking for new work on demand', (): void => {
  it('polls the connected work surfaces now, at most once a minute', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const surfaceIds = await harness.run(async (ctx) =>
      (await ctx.db.query('surfaces').collect()).map((surface) => surface._id).sort(),
    );

    const first = await harness
      .withIdentity(OWNER)
      .mutation(api.workLoop.checkForNewWork, { agentId });
    expect(first).toMatchObject({ scheduled: 2 });
    const jobs = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(jobs.map((job) => job.name)).toEqual([
      'intakeActions:pollSurface',
      'intakeActions:pollSurface',
      'work:readmitSatisfiedDeferrals',
    ]);
    expect(
      jobs
        .filter((job) => job.name === 'intakeActions:pollSurface')
        .map((job) => (job.args[0] as { surfaceId: string }).surfaceId)
        .sort(),
    ).toEqual(surfaceIds);
    expect(jobs.at(-1)?.args[0]).toEqual({ agentId });

    vi.advanceTimersByTime(30_000);
    const again = await harness
      .withIdentity(OWNER)
      .mutation(api.workLoop.checkForNewWork, { agentId });
    expect(again).toMatchObject({ scheduled: 0, retryInMs: 30_000 });

    vi.advanceTimersByTime(30_000);
    const later = await harness
      .withIdentity(OWNER)
      .mutation(api.workLoop.checkForNewWork, { agentId });
    expect(later).toMatchObject({ scheduled: 2 });
    // The polls the advanced clock fired are still running: finish them here,
    // so none of them runs on into a later test.
    await harness.finishInProgressScheduledFunctions();
  });

  it('refuses a caller who does not own the employee, and the mock deployment', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    await expect(
      harness
        .withIdentity(managerIdentity('someone-else'))
        .mutation(api.workLoop.checkForNewWork, { agentId }),
    ).rejects.toThrow(/not yours/);

    restoreSurfaceMode();
    useSurfaceMode('mock');
    const mock = convexTest(contractSchema(), allConvexModules());
    const mockAgent = await seedEmployee(mock);
    await expect(
      mock.withIdentity(OWNER).mutation(api.workLoop.checkForNewWork, { agentId: mockAgent }),
    ).rejects.toThrow(/real-mode/);
  });
});

describe('what an outage leaves (P7-18)', (): void => {
  /** The scheduled jobs of one function, with their arguments. */
  async function scheduledCalls(harness: Harness, name: string): Promise<unknown[]> {
    return (
      await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
    )
      .filter((row) => row.name === name)
      .map((row) => row.args[0]);
  }

  /** Leave a claimed row as a draft that claimed it and died a lease ago would. */
  async function killDraft(harness: Harness, workItemId: Id<'workItems'>): Promise<void> {
    await harness.run(async (ctx) => {
      await ctx.db.patch(workItemId, {
        state: 'claimed',
        verdict: { decision: 'claim', value: 1, risk: 0, requiredPermissions: [] },
        draftClaimedAt: Date.now() - STEP_LEASE_MS - 1,
      });
    });
  }

  it('resumes a draft that keeps dying a bounded number of times, then stops the row for Retry', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await insertDiscovered(harness, agentId, 'REVOPS-41');
    for (let attempt = 1; attempt <= MAX_DRAFT_RESUMES; attempt += 1) {
      await killDraft(harness, workItemId);
      await harness.mutation(internal.work.resumeStalledSteps, {});
    }
    expect(await scheduledCalls(harness, 'workActions:draftPlanInternal')).toHaveLength(
      MAX_DRAFT_RESUMES,
    );
    expect((await eventsOf(harness, 'work.draft-resumed')).map((event) => event.payload)).toEqual(
      Array.from({ length: MAX_DRAFT_RESUMES }, (_, index) => ({
        workItemId,
        attempt: index + 1,
      })),
    );

    await killDraft(harness, workItemId);
    await harness.mutation(internal.work.resumeStalledSteps, {});
    expect(await scheduledCalls(harness, 'workActions:draftPlanInternal')).toHaveLength(
      MAX_DRAFT_RESUMES,
    );
    expect(await scheduledCalls(harness, 'workRuns:setFailed')).toEqual([
      {
        workItemId,
        reason: `the plan draft died ${MAX_DRAFT_RESUMES + 1} times without an answer; Retry drafts it again`,
        stopped: true,
      },
    ]);
  });

  it("counts the dead drafts again from the manager's last Retry", async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await insertDiscovered(harness, agentId, 'REVOPS-42');
    for (let attempt = 1; attempt <= MAX_DRAFT_RESUMES; attempt += 1) {
      await killDraft(harness, workItemId);
      await harness.mutation(internal.work.resumeStalledSteps, {});
    }
    await harness.run(async (ctx) => {
      await ctx.db.insert('events', {
        agentId,
        type: 'work.retry',
        payload: { workItemId, resumeState: 'claimed', fromState: 'failed' },
        createdAt: Date.now() + 1,
      });
    });
    vi.advanceTimersByTime(10);
    await killDraft(harness, workItemId);
    await harness.mutation(internal.work.resumeStalledSteps, {});
    expect(await scheduledCalls(harness, 'workRuns:setFailed')).toEqual([]);
    expect((await eventsOf(harness, 'work.draft-resumed')).at(-1)?.payload).toEqual({
      workItemId,
      attempt: 1,
    });
  });

  it('asks for an action decision parked while no manager channel existed, once one is back', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await insertDiscovered(harness, agentId, 'REVOPS-43');
    const slack = await harness.run(async (ctx) => {
      const pendingRunId = await ctx.db.insert('events', {
        agentId,
        type: 'work.execution-claimed',
        payload: { workItemId },
        createdAt: Date.now() - STEP_LEASE_MS - 1,
      });
      await ctx.db.patch(workItemId, {
        state: 'actions-pending',
        pendingRunId,
        executionRunId: pendingRunId,
        output: managerDm,
      });
      const row = await ctx.db
        .query('surfaces')
        .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'slack'))
        .unique();
      if (!row) throw new Error('slack surface missing');
      await ctx.db.patch(row._id, { verdict: 'listed-dead' });
      return row._id;
    });
    await harness.mutation(internal.work.resumeStalledSteps, {});
    expect(await scheduledCalls(harness, 'managerChannelActions:requestDecision')).toEqual([]);

    await harness.run(async (ctx) => await ctx.db.patch(slack, { verdict: 'connected' }));
    // A set with nothing held has nothing to ask about, and is not asked every sweep.
    await harness.run(
      async (ctx) =>
        await ctx.db.patch(workItemId, {
          actionVerdicts: [{ disposition: 'refused', reason: 'x' }],
        }),
    );
    await harness.mutation(internal.work.resumeStalledSteps, {});
    expect(await scheduledCalls(harness, 'managerChannelActions:requestDecision')).toEqual([]);

    await harness.run(async (ctx) => await ctx.db.patch(workItemId, { actionVerdicts: undefined }));
    await harness.mutation(internal.work.resumeStalledSteps, {});
    expect(await scheduledCalls(harness, 'managerChannelActions:requestDecision')).toEqual([
      { workItemId, kind: 'actions' },
    ]);
  });
});

describe('a closing phase whose authoring never claimed the run (P5-1)', (): void => {
  it('is handed to its recovery, not stopped as if nothing landed', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await insertDiscovered(harness, agentId, 'REVOPS-44');
    const runId = await harness.run(async (ctx) => {
      const claim = await ctx.db.insert('events', {
        agentId,
        type: 'work.execution-claimed',
        payload: { workItemId },
        createdAt: Date.now() - EXECUTION_STALL_MS - 1,
      });
      await ctx.db.patch(workItemId, {
        state: 'executing',
        executionRunId: claim,
        output: {
          ...managerDm,
          phase: 'dependent-authoring',
          applied: [{ tool: 'http.request', ok: true }],
        },
      });
      return claim;
    });
    await harness.mutation(internal.work.resumeStalledSteps, {});
    const jobs = (
      await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
    ).map((job) => ({ name: job.name, args: job.args[0] }));
    expect(jobs).toContainEqual({
      name: 'work:recoverDependentAuthoring',
      args: { workItemId, runId },
    });
    expect(jobs.map((job) => job.name)).not.toContain('workRuns:setFailed');
  });
});

describe('queued work while the charter is not approved (step 4)', (): void => {
  it('parks each waiting row with an event instead of an evaluation that throws, and the approval brings it back', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    await harness.run(async (ctx) => {
      const charter = await ctx.db
        .query('charters')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .first();
      if (!charter) throw new Error('charter missing');
      await ctx.db.patch(charter._id, { approved: false, approvedAt: undefined });
    });
    const first = await insertDiscovered(harness, agentId, 'REVOPS-51');
    const second = await insertDiscovered(harness, agentId, 'REVOPS-52');

    await harness.mutation(internal.work.resumeStalledSteps, {});
    await harness.mutation(internal.work.resumeStalledSteps, {});
    for (const workItemId of [first, second]) {
      expect(await readItem(harness, workItemId)).toMatchObject({
        state: 'deferred',
        verdict: { decision: 'defer', reason: AWAITING_CHARTER },
      });
    }
    expect(
      (await eventsOf(harness, 'work.waiting-for-charter')).map((event) => event.payload),
    ).toEqual([{ workItemId: first }, { workItemId: second }]);
    expect(await scheduledNames(harness)).not.toContain('workActions:evaluateWorkItemInternal');

    await harness.run(async (ctx) => {
      const charter = await ctx.db
        .query('charters')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .first();
      if (!charter) throw new Error('charter missing');
      await ctx.db.patch(charter._id, { approved: true, approvedAt: Date.now() });
    });
    await harness.mutation(internal.work.reevaluatePending, {
      agentId,
      trigger: 'charter',
      key: 'charter-approved',
    });
    expect((await readItem(harness, first)).state).toBe('discovered');
    expect((await readItem(harness, second)).state).toBe('discovered');
  });
});

describe('the stall sweep while a handover is finishing (D18)', (): void => {
  /** A plan approved and a claimed row with no plan, both left by steps that died. */
  async function seedStalled(harness: Harness, agentId: Id<'agents'>): Promise<void> {
    await harness.run(async (ctx) => {
      const fields = {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        title: 'Close the summary',
        contentSummary: 'Synthetic.',
        contentRefs: [],
        observedAt: 1,
        createdAt: 1,
      };
      await ctx.db.insert('workItems', {
        ...fields,
        externalId: 'REVOPS-71',
        state: 'plan-approved',
        plan: { summary: 'Close it.', steps: ['close'] },
      });
      await ctx.db.insert('workItems', { ...fields, externalId: 'REVOPS-72', state: 'claimed' });
    });
  }

  it('resumes nothing for an employee whose handover is finishing, and resumes it otherwise', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const finishing = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(finishing);
    await seedStalled(finishing, agentId);
    await finishing.run(async (ctx) => {
      await ctx.db.insert('managerTransfers', {
        agentId,
        agentName: 'Priya',
        fromOwnerKey: 'owner',
        fromAddress: 'boss@day0.local',
        toAddress: 'colleague@day0.local',
        state: 'accepting',
        requestedAt: 1,
        expiresAt: Date.now() + 60_000,
        decidedAt: 2,
        toOwnerKey: 'colleague',
        settleBy: Date.now() + 60_000,
      });
    });
    const control = convexTest(contractSchema(), allConvexModules());
    await seedStalled(control, await seedEmployee(control));

    await finishing.mutation(internal.work.resumeStalledSteps, {});
    await control.mutation(internal.work.resumeStalledSteps, {});

    expect(await scheduledNames(finishing)).toEqual([]);
    expect(await scheduledNames(control)).toEqual(
      expect.arrayContaining([
        'workActions:draftPlanInternal',
        'workActions:executeApprovedPlanInternal',
      ]),
    );
  });
});

describe('the manager-channel claims’ lease (N-3)', (): void => {
  const LAPSED = 20 * 60_000;
  const FRESH = 5 * 60_000;

  /** One employee with a chat card, an item whose decision was claimed, and every kind of claim. */
  async function claims(harness: TestConvex<typeof schema>, claimedAt: number) {
    return await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const surfaceId = await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        endpoint: 'https://slack.com/api/',
        path: 'documented-api',
        toolAllowlist: ['chat.postMessage', 'chat.update'],
        managerDmChannelId: 'D0MANAGER',
        credentialLanded: true,
        whereFound: [],
        createdAt: 1,
      });
      const workItemId = await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
        title: 'Close the audit note',
        contentSummary: 'Synthetic.',
        contentRefs: [],
        state: 'completed',
        decision: {
          id: 'abc234',
          kind: 'actions',
          requestedAt: 1,
          channel: 'D0MANAGER',
          surfaceSlug: 'slack',
          surfaceName: 'Slack',
          ts: '1.1',
          decidedAt: 2,
          outcome: 'approved',
          requestText: 'Approve?',
          closeClaimedAt: claimedAt,
          duplicateNotifiedAt: 3,
          duplicateNoticeClaimedAt: claimedAt,
        },
        observedAt: 1,
        createdAt: 1,
      });
      const digestId = await ctx.db.insert('events', {
        agentId,
        type: 'work.manager-digest-sending',
        payload: {},
        createdAt: claimedAt,
      });
      const digestNote = await ctx.db.insert('managerNotes', {
        agentId,
        workItemId,
        kind: 'landed',
        text: 'Landed.',
        createdAt: 1,
        claimedAt,
        digestId,
      });
      const perRunNote = await ctx.db.insert('managerNotes', {
        agentId,
        workItemId,
        kind: 'landed',
        text: 'Landed.',
        createdAt: 1,
        claimedAt,
      });
      const notice = await ctx.db.insert('managerDecisionNotices', {
        agentId,
        surfaceId,
        workItemId,
        decisionId: 'abc234',
        messageTs: '2.2',
        kind: 'received',
        text: 'Approval abc234 received.',
        createdAt: 1,
        claimedAt,
      });
      const replaced = await ctx.db.insert('replacedDecisionRequests', {
        agentId,
        workItemId,
        decisionId: 'old234',
        kind: 'actions',
        surfaceSlug: 'slack',
        channel: 'D0MANAGER',
        ts: '0.9',
        replacedAt: 1,
        editClaimedAt: claimedAt,
      });
      return { agentId, workItemId, digestNote, perRunNote, notice, replaced };
    });
  }

  it('settles every claim an action died holding, as its own failure would, and no live one', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const lapsed = await claims(harness, Date.now() - LAPSED);
    const live = await claims(harness, Date.now() - FRESH);

    await harness.mutation(internal.work.resumeStalledSteps, {});

    const read = async (ids: typeof lapsed) =>
      await harness.run(async (ctx) => ({
        item: await ctx.db.get(ids.workItemId),
        digestNote: await ctx.db.get(ids.digestNote),
        perRunNote: await ctx.db.get(ids.perRunNote),
        notice: await ctx.db.get(ids.notice),
        replaced: await ctx.db.get(ids.replaced),
      }));
    const settled = await read(lapsed);
    // An unsent digest's claim is released for the next digest, with the reason on the note.
    expect(settled.digestNote).toMatchObject({ failure: MANAGER_CLAIM_LAPSED_REASON });
    expect(settled.digestNote?.claimedAt).toBeUndefined();
    expect(settled.digestNote?.digestId).toBeUndefined();
    // A per-run note has its own switch (`recoverUnsentManagerNote`); the lease leaves it.
    expect(settled.perRunNote?.failure).toBeUndefined();
    expect(settled.notice?.failure).toBe(MANAGER_CLAIM_LAPSED_REASON);
    expect(settled.item?.decision).toMatchObject({
      closeFailure: MANAGER_CLAIM_LAPSED_REASON,
      duplicateNoticeFailure: MANAGER_CLAIM_LAPSED_REASON,
    });
    expect(settled.replaced?.editFailure).toBe(MANAGER_CLAIM_LAPSED_REASON);

    const untouched = await read(live);
    expect(untouched.digestNote?.claimedAt).toEqual(expect.any(Number));
    expect(untouched.digestNote?.failure).toBeUndefined();
    expect(untouched.notice?.failure).toBeUndefined();
    expect(untouched.item?.decision?.closeFailure).toBeUndefined();
    expect(untouched.item?.decision?.duplicateNoticeFailure).toBeUndefined();
    expect(untouched.replaced?.editFailure).toBeUndefined();
  });

  it('leaves a claim whose result was recorded, and settles one claim once', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const lapsed = await claims(harness, Date.now() - LAPSED);
    await harness.run(async (ctx) => {
      const row = await ctx.db.get(lapsed.workItemId);
      await ctx.db.patch(lapsed.workItemId, {
        decision: { ...row!.decision!, closedAt: Date.now() - LAPSED + 1_000 },
      });
    });
    await harness.mutation(internal.work.resumeStalledSteps, {});
    await harness.mutation(internal.work.resumeStalledSteps, {});
    const row = await harness.run(async (ctx) => await ctx.db.get(lapsed.workItemId));
    expect(row?.decision?.closeFailure).toBeUndefined();
    const failed = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent', (q) => q.eq('agentId', lapsed.agentId))
          .filter((q) => q.eq(q.field('type'), 'work.manager-digest-failed'))
          .collect(),
    );
    expect(failed).toHaveLength(1);
  });
});
