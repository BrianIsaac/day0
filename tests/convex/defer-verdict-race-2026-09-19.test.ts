/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * Finding C of the 19 Sep full run: REVOPS-27 read "defer - awaiting-connection:
 * looker-pipeline-tile (connected)". Its evaluation read the surfaces, the
 * scope judgement ran for 24.9 s, the tile connected inside that call, and the
 * verdict was written afterwards from the read taken before. `recordConnected`
 * re-admits only rows already `deferred`, so nothing ever sent the row back.
 * The rows below are the run's own: the ticket, the tile and the order.
 */

const recorded = vi.hoisted(() => ({
  scopeCalls: [] as string[],
  /** Holds the charter judgement open until the test releases it. */
  scopeGate: undefined as Promise<void> | undefined,
}));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (args: { agent: { name: string }; user: string }): Promise<unknown> => {
    if (args.agent.name === 'day0-scope-judgement') {
      recorded.scopeCalls.push(args.user);
      await recorded.scopeGate;
      return { inScope: true, fit: true, reason: 'the pipeline tile is revenue operations work' };
    }
    throw new Error(`unscripted agent ${args.agent.name}`);
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/work/plan', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/work/plan')>();
  return {
    ...original,
    draftExecutionPlan: async () => ({
      summary: 'Refresh the tile to the standup figure.',
      steps: ['Set the tile to the figure in the Friday standup coverage summary.'],
      expectedOutputType: 'message',
      riskNotes: '',
      reversibility: 'reversible',
      estimatedMinutes: 2,
    }),
  };
});

vi.mock('../../src/surfaces/credentials', () => ({
  decryptCredentialRef: { name: 'credentials:decrypt' },
  decryptCredential: async (_ctx: unknown, credentialId: string): Promise<string> =>
    `plain-${credentialId}`,
}));

vi.stubGlobal(
  'fetch',
  async (): Promise<Response> =>
    new Response(JSON.stringify({ ok: true, ts: '1789000000.000100' }), { status: 200 }),
);

type Harness = TestConvex<typeof schema>;
const TILE = 'looker-pipeline-tile';

afterEach((): void => {
  recorded.scopeCalls.length = 0;
  recorded.scopeGate = undefined;
  vi.useRealTimers();
  restoreSurfaceMode();
});

/** Real mode on a deployment that can drive the tile, as the run's bed could. */
function useRealModeWithBrowser(): void {
  useSurfaceMode('real');
  vi.stubEnv('DAY0_BROWSER_MCP_URL', 'http://browser-mcp:8931/mcp');
}

interface Employee {
  agentId: Id<'agents'>;
  tileId: Id<'surfaces'>;
}

/**
 * Priya as the run had her when REVOPS-27 was discovered: Linear connected,
 * the Looker tile approved with its credential landed and no probe back yet.
 *
 * Args:
 *   harness: Convex test harness.
 *   options: Whether the tile is already connected.
 *
 * Returns:
 *   The agent and the tile surface.
 */
async function seedPriya(
  harness: Harness,
  options: { tileConnected?: boolean } = {},
): Promise<Employee> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      autonomousActions: false,
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
        proposedBoundaries: { willDo: ['pipeline reporting'], willNotDo: [], escalationTriggers: [] },
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
    for (const scope of ['boss:message', 'linear:read', 'linear:write']) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
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
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      whereFound: [],
      createdAt: 1,
    } as never);
    const tileId = await ctx.db.insert('surfaces', {
      agentId,
      slug: TILE,
      displayName: 'Looker pipeline tile',
      class: 'analytics',
      verdict: options.tileConnected ? 'connected' : 'approved',
      endpoint: 'http://looker-tile:8080/',
      path: 'browser-driven',
      credentialId: 'cred-tile',
      credentialLanded: true,
      ...(options.tileConnected ? { lastVerifiedAt: Date.now() } : {}),
      probeGeneration: 1,
      whereFound: [],
      createdAt: 1,
    } as never);
    return { agentId, tileId };
  });
}

/** REVOPS-27 as intake seeded it in the run. */
async function seedTileTicket(harness: Harness, agentId: Id<'agents'>): Promise<Id<'workItems'>> {
  return await harness.mutation(internal.work.seedItem, {
    agentId,
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId: 'REVOPS-27',
    title: 'Refresh the Looker pipeline tile',
    contentSummary:
      'Update the pipeline coverage figure on the Looker pipeline tile to the figure in the Friday standup coverage summary.',
    contentRefs: ['ticket://REVOPS-27'],
    priority: 'High',
  });
}

/** Insert a row in a given state with nothing scheduled for it. */
async function insertRow(
  harness: Harness,
  agentId: Id<'agents'>,
  externalId: string,
  fields: Partial<Doc<'workItems'>> = {},
): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId,
        title: 'Refresh the Looker pipeline tile',
        contentSummary: 'Update the pipeline coverage figure on the Looker pipeline tile.',
        contentRefs: [`ticket://${externalId}`],
        priority: 'High',
        state: 'discovered',
        observedAt: Date.now(),
        createdAt: Date.now(),
        ...fields,
      } as never),
  );
}

async function connectTile(harness: Harness, tileId: Id<'surfaces'>, verifiedAt: number): Promise<void> {
  await expect(
    harness.mutation(internal.surfaces.recordConnected, {
      surfaceId: tileId,
      generation: 1,
      toolAllowlist: [],
      toolArguments: [],
      verifiedAt,
    }),
  ).resolves.toBe(true);
}

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

async function pendingJobs(harness: Harness): Promise<Array<{ name: string; args: unknown }>> {
  return (
    await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
  )
    .filter((job) => job.state.kind === 'pending')
    .map((job) => ({ name: job.name, args: job.args[0] }));
}

const deferOnTile = { decision: 'defer', reason: 'awaiting-connection', missingSurface: TILE };

describe('a connection that lands between an evaluation\'s read and its verdict', (): void => {
  it('leaves REVOPS-27 re-evaluated, not deferred against a connected tile', async (): Promise<void> => {
    useRealModeWithBrowser();
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, tileId } = await seedPriya(harness);
    let release = (): void => {};
    recorded.scopeGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const workItemId = await seedTileTicket(harness, agentId);
    vi.advanceTimersByTime(0);
    // The first evaluation of the file loads every module the action imports.
    await vi.waitFor(() => expect(recorded.scopeCalls).toHaveLength(1), { timeout: 20_000 });
    // The evaluation has read the surfaces; the tile connects inside the model call.
    await connectTile(harness, tileId, Date.now());
    expect((await readItem(harness, workItemId)).state).toBe('discovered');
    recorded.scopeGate = undefined;
    release();
    await drain(harness);

    const row = await readItem(harness, workItemId);
    expect(row.state).toBe('plan-pending');
    expect(recorded.scopeCalls).toHaveLength(2);
    const requeued = await eventsOf(harness, 'work.requeued');
    expect(requeued).toHaveLength(1);
    expect(requeued[0].payload).toMatchObject({
      workItemId,
      trigger: 'verdict-write',
      previousMissingSurface: TILE,
    });
    expect(
      (await eventsOf(harness, 'work.evaluated')).map(
        (event) => (event.payload as { decision: string }).decision,
      ),
    ).toEqual(['pending-reevaluation', 'claim']);
  }, 30_000);

  it('still parks a defer whose surface is not connected at the write', async (): Promise<void> => {
    useRealModeWithBrowser();
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId } = await seedPriya(harness);
    const workItemId = await insertRow(harness, agentId, 'REVOPS-27');

    const stored = await harness.mutation(internal.work.setVerdict, {
      workItemId,
      verdict: deferOnTile,
    });

    expect(stored).toEqual(deferOnTile);
    expect(await readItem(harness, workItemId)).toMatchObject({
      state: 'deferred',
      verdict: deferOnTile,
    });
    expect(await eventsOf(harness, 'work.requeued')).toEqual([]);
  });

  it('re-evaluates once per connection, so a flapping tile cannot loop', async (): Promise<void> => {
    useRealModeWithBrowser();
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, tileId } = await seedPriya(harness, { tileConnected: true });
    const workItemId = await insertRow(harness, agentId, 'REVOPS-27');

    const first = await harness.mutation(internal.work.setVerdict, {
      workItemId,
      verdict: deferOnTile,
    });
    expect(first).toMatchObject({
      decision: 'pending-reevaluation',
      reason: 'looker-pipeline-tile connected while this was being evaluated',
      superseded: deferOnTile,
    });
    const readmitted = await readItem(harness, workItemId);
    expect(readmitted.state).toBe('discovered');
    expect(readmitted.reevaluation?.trigger).toBe('verdict-write');
    expect(await pendingJobs(harness)).toEqual([
      { name: 'workActions:evaluateWorkItemInternal', args: { workItemId } },
    ]);

    // The same connection has bought its one re-evaluation: the next defer parks.
    const second = await harness.mutation(internal.work.setVerdict, {
      workItemId,
      verdict: deferOnTile,
    });
    expect(second).toEqual(deferOnTile);
    expect((await readItem(harness, workItemId)).state).toBe('deferred');
    expect(await eventsOf(harness, 'work.requeued')).toHaveLength(1);

    // A later connection is a change of the thing waited on, and buys one more.
    await harness.run(async (ctx) => {
      await ctx.db.patch(tileId, { lastVerifiedAt: Date.now() + 1_000 });
      await ctx.db.patch(workItemId, { state: 'discovered', verdict: undefined });
    });
    const third = await harness.mutation(internal.work.setVerdict, {
      workItemId,
      verdict: deferOnTile,
    });
    expect(third.decision).toBe('pending-reevaluation');
    const fourth = await harness.mutation(internal.work.setVerdict, {
      workItemId,
      verdict: deferOnTile,
    });
    expect(fourth).toEqual(deferOnTile);
    expect(await eventsOf(harness, 'work.requeued')).toHaveLength(2);
  });

  it('does not spend the re-evaluation the connecting write already gave the row', async (): Promise<void> => {
    useRealModeWithBrowser();
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, tileId } = await seedPriya(harness);
    const workItemId = await insertRow(harness, agentId, 'REVOPS-27', {
      state: 'deferred',
      verdict: deferOnTile,
    });

    await connectTile(harness, tileId, Date.now());
    expect((await readItem(harness, workItemId)).state).toBe('discovered');
    const stored = await harness.mutation(internal.work.setVerdict, {
      workItemId,
      verdict: deferOnTile,
    });

    expect(stored).toEqual(deferOnTile);
    expect((await readItem(harness, workItemId)).state).toBe('deferred');
  });

  it('treats a tile whose last probe is older than the liveness window as not connected', async (): Promise<void> => {
    useRealModeWithBrowser();
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId, tileId } = await seedPriya(harness, { tileConnected: true });
    await harness.run(async (ctx) => {
      await ctx.db.patch(tileId, { lastVerifiedAt: Date.now() - 7 * 60 * 60 * 1_000 });
    });
    const workItemId = await insertRow(harness, agentId, 'REVOPS-27');

    await harness.mutation(internal.work.setVerdict, { workItemId, verdict: deferOnTile });

    expect((await readItem(harness, workItemId)).state).toBe('deferred');
  });
  it('does not count a browser-driven tile this deployment cannot drive, as the evaluation does not', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId } = await seedPriya(harness, { tileConnected: true });
    const workItemId = await insertRow(harness, agentId, 'REVOPS-27');

    const stored = await harness.mutation(internal.work.setVerdict, {
      workItemId,
      verdict: deferOnTile,
    });

    expect(stored).toEqual(deferOnTile);
    expect((await readItem(harness, workItemId)).state).toBe('deferred');
  });
});

describe('the other verdicts that wait on something', (): void => {
  it('re-evaluates an awaiting-permission defer whose grants are all live at the write', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId } = await seedPriya(harness);
    const verdict = {
      decision: 'defer',
      reason: 'awaiting-permission',
      missingPermissions: ['linear:read', 'boss:message'],
    };
    const workItemId = await insertRow(harness, agentId, 'REVOPS-27');

    const first = await harness.mutation(internal.work.setVerdict, { workItemId, verdict });
    expect(first).toMatchObject({
      decision: 'pending-reevaluation',
      reason: 'boss:message, linear:read granted while this was being evaluated',
    });
    expect((await readItem(harness, workItemId)).state).toBe('discovered');

    const second = await harness.mutation(internal.work.setVerdict, { workItemId, verdict });
    expect(second).toEqual(verdict);
    expect((await readItem(harness, workItemId)).state).toBe('deferred');
  });

  it('parks an awaiting-permission defer while one grant is missing or revoked', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId } = await seedPriya(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('permissionGrants', {
        agentId,
        scope: 'netledger:read',
        createdAt: 1,
        revokedAt: 2,
      });
    });
    const missing = await insertRow(harness, agentId, 'REVOPS-30');
    const revoked = await insertRow(harness, agentId, 'REVOPS-31');

    await harness.mutation(internal.work.setVerdict, {
      workItemId: missing,
      verdict: {
        decision: 'defer',
        reason: 'awaiting-permission',
        missingPermissions: ['linear:read', 'looker-pipeline-tile:read'],
      },
    });
    await harness.mutation(internal.work.setVerdict, {
      workItemId: revoked,
      verdict: {
        decision: 'defer',
        reason: 'awaiting-permission',
        missingPermissions: ['netledger:read'],
      },
    });

    expect((await readItem(harness, missing)).state).toBe('deferred');
    expect((await readItem(harness, revoked)).state).toBe('deferred');
  });

  it('re-evaluates a needs-skill verdict naming a skill that registered during the evaluation', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId } = await seedPriya(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('skills', {
        agentId,
        name: 'analytics-update',
        description: 'Update a figure on an analytics surface.',
        body: 'Sign in, set the figure.',
        sourceType: 'agent-authored',
        state: 'registered',
        surfaceClass: 'analytics',
        operation: 'update',
        createdAt: 1,
        registeredAt: 5,
      });
    });
    const verdict = {
      decision: 'needs-skill',
      reason: 'no registered skill covers updating a figure on an analytics surface',
      suggestedSkillName: 'analytics-update',
      suggestedSkillRationale: 'First needed by the tile refresh.',
      suggestedSkillShape: { surfaceClass: 'analytics', operation: 'update' },
    };
    const workItemId = await insertRow(harness, agentId, 'REVOPS-27');

    const first = await harness.mutation(internal.work.setVerdict, { workItemId, verdict });
    expect(first.decision).toBe('pending-reevaluation');
    expect((await readItem(harness, workItemId)).state).toBe('discovered');

    const second = await harness.mutation(internal.work.setVerdict, { workItemId, verdict });
    expect(second).toEqual(verdict);
    expect((await readItem(harness, workItemId)).state).toBe('needs-skill');
  });

  it('parks a needs-skill verdict whose skill is not registered, or that names none', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId } = await seedPriya(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('skills', {
        agentId,
        name: 'analytics-update',
        description: 'Update a figure on an analytics surface.',
        body: '',
        sourceType: 'agent-authored',
        state: 'proposed',
        createdAt: 1,
      });
    });
    const proposedOnly = await insertRow(harness, agentId, 'REVOPS-32');
    const unnamed = await insertRow(harness, agentId, 'REVOPS-33');

    await harness.mutation(internal.work.setVerdict, {
      workItemId: proposedOnly,
      verdict: {
        decision: 'needs-skill',
        reason: 'no registered skill covers it',
        suggestedSkillName: 'analytics-update',
      },
    });
    await harness.mutation(internal.work.setVerdict, {
      workItemId: unnamed,
      verdict: { decision: 'needs-skill', reason: 'skill authored but not verified - smoke test' },
    });

    expect((await readItem(harness, proposedOnly)).state).toBe('needs-skill');
    expect((await readItem(harness, unnamed)).state).toBe('needs-skill');
  });

  it('writes a satisfied defer exactly as before in mock mode', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(contractSchema(), allConvexModules());
    const { agentId } = await seedPriya(harness, { tileConnected: true });
    const verdict = {
      decision: 'defer',
      reason: 'awaiting-permission',
      missingPermissions: ['linear:read'],
    };
    const workItemId = await insertRow(harness, agentId, 'REVOPS-27');

    const stored = await harness.mutation(internal.work.setVerdict, { workItemId, verdict });

    expect(stored).toEqual(verdict);
    const row = await readItem(harness, workItemId);
    expect(row).toMatchObject({ state: 'deferred', verdict });
    expect(row).not.toHaveProperty('reevaluation');
    expect(await eventsOf(harness, 'work.requeued')).toEqual([]);
  });
});
