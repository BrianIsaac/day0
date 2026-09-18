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
  planCalls: [] as string[],
  /** Holds the planner open until the test releases it. */
  planGate: undefined as Promise<void> | undefined,
  skillRuns: [] as string[],
  http: [] as Array<{ url: string; body: unknown }>,
}));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (args: { agent: { name: string }; user: string }): Promise<unknown> => {
    if (args.agent.name === 'day0-scope-judgement') {
      recorded.scopeCalls.push(args.user);
      await recorded.scopeGate;
      return { inScope: true, fit: true, reason: 'close summaries are the charter work' };
    }
    throw new Error(`unscripted agent ${args.agent.name}`);
  },
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

vi.mock('../../src/surfaces/credentials', () => ({
  decryptCredentialRef: { name: 'credentials:decrypt' },
  decryptCredential: async (_ctx: unknown, credentialId: string): Promise<string> =>
    `plain-${credentialId}`,
}));

vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit): Promise<Response> => {
  recorded.http.push({
    url: String(input),
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  });
  return new Response(JSON.stringify({ ok: true, ts: '1789000000.000100' }), { status: 200 });
});

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };

afterEach((): void => {
  recorded.scopeCalls.length = 0;
  recorded.scopeGate = undefined;
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
): Promise<Id<'workItems'>> {
  return await harness.mutation(internal.work.seedItem, {
    agentId,
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId,
    title: `Triage the Linear close summary ${externalId}`,
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

    const workItemId = await seedTicket(harness, agentId, 'REVOPS-21');
    await drain(harness);

    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('plan-pending');
    expect(row.plan).toMatchObject({ summary: 'Tell the manager the close summary is ready.' });
    expect(row.decision).toMatchObject({ kind: 'plan', ts: '1789000000.000100' });
    expect(recorded.scopeCalls).toHaveLength(1);
    expect(recorded.planCalls).toEqual(['Triage the Linear close summary REVOPS-21']);
    expect(recorded.skillRuns).toEqual([]);
    expect(
      recorded.http.filter((call) => call.url.endsWith('/chat.postMessage')).map((call) => call.body),
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

  it('holds the second row at the supervised cap until the first completes, then evaluates it', async (): Promise<void> => {
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
    expect(queued.verdict).toMatchObject({ decision: 'queue' });
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
    expect((await readItem(harness, second)).verdict).toMatchObject({ decision: 'queue' });
    expect((await readItem(harness, third)).verdict).toMatchObject({ decision: 'queue' });

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
      .mutation(api.work.retryFailed, { workItemId, feedback: 'Send it again.' });
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

    expect((await readItem(harness, workItemId)).state).toBe('claimed');
    expect((await scheduledNames(harness)).filter((name) => name.startsWith('workActions:'))).toEqual(
      [],
    );
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
      plan: { summary: 'x', steps: ['x'], expectedOutputType: 'message', riskNotes: '', reversibility: 'r', estimatedMinutes: 1 },
    });
    await harness.withIdentity(OWNER).mutation(api.work.approvePlan, { workItemId });
    await harness.mutation(internal.work.resumeStalledSteps, {});

    expect((await readItem(harness, workItemId)).state).toBe('plan-approved');
    expect((await scheduledNames(harness)).filter((name) => name.startsWith('workActions:'))).toEqual(
      [],
    );
    const row = await readItem(harness, workItemId);
    expect(row).not.toHaveProperty('evaluationClaimedAt');
    expect(row).not.toHaveProperty('draftClaimedAt');
  });
});
