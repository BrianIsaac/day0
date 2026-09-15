/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import type { Charter } from '../../src/agent/charter';
import { runThroughBody } from '../fixtures/run-through-charter-2026-09-14';
import { strikeRefusalBody } from '../fixtures/charter-strike-refusal-2026-09-15';

type Harness = TestConvex<typeof schema>;

afterEach((): void => {
  restoreSurfaceMode();
});

async function seedDraft(
  harness: Harness,
  body: Charter = runThroughBody(),
  owner = 'owner',
): Promise<{ agentId: Id<'agents'>; charterId: Id<'charters'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'worker 1',
      userId: owner,
      state: 'charter-pending',
      createdAt: 1,
    });
    const charterId = await ctx.db.insert('charters', {
      agentId,
      version: '0.0',
      body,
      approved: false,
      createdAt: 2,
    });
    await ctx.db.insert('workspace', {
      agentId,
      fileName: 'IDENTITY.md',
      content: '# IDENTITY\n\nRole: owned, prioritized Linear tickets\n',
      updatedAt: 2,
    });
    return { agentId, charterId };
  });
}

async function charter(harness: Harness, charterId: Id<'charters'>): Promise<Doc<'charters'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(charterId));
  if (!row) throw new Error('charter missing');
  return row;
}

async function workspaceFile(harness: Harness, agentId: Id<'agents'>, fileName: string): Promise<string> {
  return await harness.run(async (ctx) => {
    const row = await ctx.db
      .query('workspace')
      .withIndex('by_agent_file', (q) => q.eq('agentId', agentId).eq('fileName', fileName))
      .unique();
    return row?.content ?? '';
  });
}

async function eventsOf(harness: Harness, agentId: Id<'agents'>): Promise<Doc<'events'>[]> {
  return await harness.run(
    async (ctx) =>
      await ctx.db
        .query('events')
        .withIndex('by_agent', (q) => q.eq('agentId', agentId))
        .collect(),
  );
}

describe('striking a constraint before approval', (): void => {
  it('marks the constraint struck on the draft and can restore it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { charterId } = await seedDraft(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    await owner.mutation(api.charters.setConstraintStruck, { charterId, index: 0, struck: true });
    let body = (await charter(harness, charterId)).body as Charter;
    expect(body.constraints?.[0]?.struck).toBe(true);
    expect(body.constraints?.[1]?.struck).toBeUndefined();
    // The draft's clauses are untouched until approval, so a restore costs nothing.
    expect(body.proposedBoundaries.willDo[0]).toContain('owned, prioritized');
    await owner.mutation(api.charters.setConstraintStruck, { charterId, index: 0, struck: false });
    body = (await charter(harness, charterId)).body as Charter;
    expect(body.constraints?.[0]?.struck).toBe(false);
  });

  it('refuses a stranger, an approved charter and an index the draft has no constraint at', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { charterId } = await seedDraft(harness);
    await expect(
      harness
        .withIdentity({ subject: 'stranger' })
        .mutation(api.charters.setConstraintStruck, { charterId, index: 0, struck: true }),
    ).rejects.toThrow(/forbidden|not found|owner/i);
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.mutation(api.charters.setConstraintStruck, { charterId, index: 5, struck: true }),
    ).rejects.toThrow(/no constraint/i);
    await owner.mutation(api.charters.approve, { charterId });
    await expect(
      owner.mutation(api.charters.setConstraintStruck, { charterId, index: 0, struck: true }),
    ).rejects.toThrow(/approved/i);
  });
});

/** A draft whose one will-not-do clause is the only clause bounding Linear, and carries a derived word. */
function boundedBody(struck?: boolean): Charter {
  const body = runThroughBody();
  body.proposedBoundaries.willNotDo = ['Change owned Linear tickets outside Q3 close.'];
  body.proposedBoundaries.escalationTriggers = [];
  body.constraints = [
    {
      kind: 'candidate-property',
      quote: 'Tickets have an owner.',
      wording: ['owned'],
      origin: 'derived',
      ...(struck === undefined ? {} : { struck }),
    },
  ];
  return body;
}

const BOUNDED_REFUSAL =
  'strike refused: \u201cChange owned Linear tickets outside Q3 close.\u201d is the only clause that bounds Linear';

describe('a strike the effective charter cannot honour', (): void => {
  it('is refused at toggle time with the reason, and the draft is left unflagged', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { charterId } = await seedDraft(harness, boundedBody());
    const owner = harness.withIdentity({ subject: 'owner' });
    const before = await charter(harness, charterId);
    const result = await owner.mutation(api.charters.setConstraintStruck, {
      charterId,
      index: 0,
      struck: true,
    });
    expect(result).toEqual({ ok: false, reason: BOUNDED_REFUSAL });
    const after = await charter(harness, charterId);
    expect(JSON.stringify(after.body)).toBe(JSON.stringify(before.body));

    expect(await owner.mutation(api.charters.approve, { charterId })).toEqual({ ok: true });
    const approved = await charter(harness, charterId);
    expect(approved.approved).toBe(true);
    expect(JSON.stringify(approved.body)).toBe(JSON.stringify(before.body));
  });

  it('is returned as a reason by approve when the flag reached the row some other way', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedDraft(harness, boundedBody(true));
    const owner = harness.withIdentity({ subject: 'owner' });
    expect(await owner.mutation(api.charters.approve, { charterId })).toEqual({
      ok: false,
      reason: BOUNDED_REFUSAL,
    });
    const row = await charter(harness, charterId);
    expect(row.approved).toBe(false);
    expect(row.body).toEqual(boundedBody(true));
    const agent = await harness.run(async (ctx) => await ctx.db.get(agentId));
    expect(agent?.state).toBe('charter-pending');
    expect(await eventsOf(harness, agentId)).toEqual([]);
  });
});

describe('the 15 September strike the card offered and approval refused', (): void => {
  it('strikes the derived rule as its whole clause and approves', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedDraft(harness, strikeRefusalBody(false));
    const owner = harness.withIdentity({ subject: 'owner' });
    expect(
      await owner.mutation(api.charters.setConstraintStruck, { charterId, index: 2, struck: true }),
    ).toEqual({ ok: true });
    expect(await owner.mutation(api.charters.approve, { charterId })).toEqual({ ok: true });

    const row = await charter(harness, charterId);
    expect(row.approved).toBe(true);
    const body = row.body as Charter;
    expect(body.proposedBoundaries.willNotDo).toEqual(['Access or execute work in Northstar CRM.']);
    expect(body.proposedBoundaries.willDo).toEqual(strikeRefusalBody().proposedBoundaries.willDo);
    expect(body.proposedBoundaries.escalationTriggers).toEqual(
      strikeRefusalBody().proposedBoundaries.escalationTriggers,
    );
    expect(body.proposedFunction).toBe(strikeRefusalBody().proposedFunction);
    expect(
      [
        body.proposedFunction,
        ...body.proposedBoundaries.willDo,
        ...body.proposedBoundaries.willNotDo,
        ...body.proposedBoundaries.escalationTriggers,
      ].join('\n'),
    ).not.toMatch(/ownership/i);
    expect(body.constraints).toEqual(strikeRefusalBody().constraints);
    expect(await workspaceFile(harness, agentId, 'IDENTITY.md')).not.toMatch(/ownership/i);
    const approved = (await eventsOf(harness, agentId)).find((e) => e.type === 'charter.approved');
    expect(approved?.payload).toEqual({
      charterId,
      version: '0.0',
      struckConstraints: ['Take ownership of Northstar CRM-dependent work that Brain must handle.'],
    });
  });
});

describe('approving a charter with a struck constraint', (): void => {
  it('keeps struck wording out of the clauses, re-renders the workspace and records the strike', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedDraft(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    await owner.mutation(api.charters.setConstraintStruck, { charterId, index: 0, struck: true });
    await owner.mutation(api.charters.approve, { charterId });

    const row = await charter(harness, charterId);
    expect(row.approved).toBe(true);
    const body = row.body as Charter;
    expect(body.proposedFunction).toBe(
      'Own routine revenue operations work from Linear tickets for the RevOps team.',
    );
    expect(body.proposedBoundaries.willDo).toEqual([
      'Handle Linear tickets in the Q3 close project.',
      'Draft replies to asks in #revops-asks.',
    ]);
    expect(body.proposedBoundaries.willNotDo).toEqual(['Post to public Slack channels.']);
    expect(body.constraints).toEqual([
      { ...runThroughBody().constraints![0], struck: true },
      runThroughBody().constraints![1],
    ]);

    const identity = await workspaceFile(harness, agentId, 'IDENTITY.md');
    expect(identity).toContain('Handle Linear tickets in the Q3 close project.');
    expect(identity).not.toMatch(/owned/);
    const approved = (await eventsOf(harness, agentId)).find((e) => e.type === 'charter.approved');
    expect(approved?.payload).toEqual({
      charterId,
      version: '0.0',
      struckConstraints: ["if it's a ticket it has an owner and a priority"],
    });
    const agent = await harness.run(async (ctx) => await ctx.db.get(agentId));
    expect(agent?.state).toBe('active');
  });

  it('leaves the body byte-identical and the workspace untouched when nothing is struck', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedDraft(harness);
    const before = await charter(harness, charterId);
    await harness.withIdentity({ subject: 'owner' }).mutation(api.charters.approve, { charterId });
    const after = await charter(harness, charterId);
    expect(JSON.stringify(after.body)).toBe(JSON.stringify(before.body));
    expect(await workspaceFile(harness, agentId, 'IDENTITY.md')).toBe(
      '# IDENTITY\n\nRole: owned, prioritized Linear tickets\n',
    );
    const approved = (await eventsOf(harness, agentId)).find((e) => e.type === 'charter.approved');
    expect(approved?.payload).toEqual({ charterId, version: '0.0' });
  });

  it('approves a charter drafted before constraints existed as before', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const legacy = runThroughBody();
    delete legacy.constraints;
    const { charterId } = await seedDraft(harness, legacy);
    await harness.withIdentity({ subject: 'owner' }).mutation(api.charters.approve, { charterId });
    const row = await charter(harness, charterId);
    expect(row.approved).toBe(true);
    expect((row.body as Charter).proposedBoundaries.willDo[0]).toContain('owned, prioritized');
  });
});

async function seedApproved(
  harness: Harness,
  body: Charter = runThroughBody(),
): Promise<{ agentId: Id<'agents'>; charterId: Id<'charters'> }> {
  const seeded = await seedDraft(harness, body);
  await harness.run(async (ctx) => {
    await ctx.db.patch(seeded.charterId, { approved: true, approvedAt: 3 });
    await ctx.db.patch(seeded.agentId, { state: 'active' });
  });
  return seeded;
}

async function scheduledJobs(harness: Harness): Promise<Array<{ name: string; args: unknown[] }>> {
  const jobs = await harness.run(
    async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
  );
  return jobs.map((job) => ({ name: job.name, args: job.args }));
}

async function latestCharter(harness: Harness, agentId: Id<'agents'>): Promise<Doc<'charters'>> {
  const row = await harness.withIdentity({ subject: 'owner' }).query(api.charters.latest, { agentId });
  if (!row) throw new Error('no charter');
  return row;
}

describe('amending an approved charter', (): void => {
  it('creates v0.1 that supersedes v0.0, with the diff on the event, the workspace re-rendered and no orientation', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedApproved(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    const changes = [
      { kind: 'edit-function' as const, text: 'Own routine revenue operations work from Linear tickets for the RevOps team.' },
    ];
    const result = await owner.mutation(api.charters.amend, { agentId, changes, reason: 'Ownership is not a rule.' });
    expect(result.version).toBe('0.1');

    const amended = await latestCharter(harness, agentId);
    expect(amended._id).toBe(result.charterId);
    expect(amended).toMatchObject({ version: '0.1', approved: true, supersedes: charterId });
    expect(amended.approvedAt).toEqual(expect.any(Number));
    const body = amended.body as Charter;
    expect(body.version).toBe('0.1');
    expect(body.proposedFunction).toBe('Own routine revenue operations work from Linear tickets for the RevOps team.');
    expect(body.proposedBoundaries).toEqual(runThroughBody().proposedBoundaries);

    const previous = await charter(harness, charterId);
    expect(previous.version).toBe('0.0');
    expect((previous.body as Charter).proposedFunction).toBe(runThroughBody().proposedFunction);
    expect(await owner.query(api.charters.listForAgent, { agentId })).toHaveLength(2);

    const event = (await eventsOf(harness, agentId)).find((e) => e.type === 'charter.amended');
    expect(event?.payload).toEqual({
      charterId: result.charterId,
      previousCharterId: charterId,
      version: '0.1',
      previousVersion: '0.0',
      via: 'dashboard',
      reason: 'Ownership is not a rule.',
      changes,
      diff: [
        {
          field: 'proposedFunction',
          before: runThroughBody().proposedFunction,
          after: 'Own routine revenue operations work from Linear tickets for the RevOps team.',
        },
      ],
    });
    expect(await workspaceFile(harness, agentId, 'IDENTITY.md')).toContain(
      'Role: Own routine revenue operations work from Linear tickets for the RevOps team.',
    );
    expect(await workspaceFile(harness, agentId, 'TOOLS.md')).toContain('# TOOLS');
    expect(await scheduledJobs(harness)).toEqual([
      { name: 'work:reevaluatePending', args: [{ agentId, trigger: 'charter', key: result.charterId }] },
    ]);
  });

  it('re-admits the work parked under the previous version through the intake trigger, keyed on the new row', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedApproved(harness);
    const parked = await harness.run(async (ctx) => {
      const insert = async (externalId: string, reason: string): Promise<Id<'workItems'>> =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId,
          title: `Item ${externalId}`,
          contentSummary: 'Triage.',
          contentRefs: [],
          observedAt: 1,
          createdAt: 1,
          state: 'skipped',
          verdict: { decision: 'skip', reason },
          skipReason: reason,
        });
      return {
        outOfScope: await insert('REVOPS-10', 'out-of-scope: no charter or current documented-system overlap'),
        lowValue: await insert('REVOPS-12', 'low-value: 10'),
      };
    });
    const owner = harness.withIdentity({ subject: 'owner' });
    vi.useFakeTimers();
    let result: { charterId: Id<'charters'> };
    try {
      result = await owner.mutation(api.charters.amend, {
        agentId,
        changes: [{ kind: 'edit-function', text: 'Own routine revenue operations work from Linear tickets for the RevOps team.' }],
      });

      // The amendment schedules the intake stage's one trigger with the new
      // charter row as its idempotency key, and that job re-admits only the
      // skips the charter can change.
      expect(await scheduledJobs(harness)).toEqual([
        { name: 'work:reevaluatePending', args: [{ agentId, trigger: 'charter', key: result.charterId }] },
      ]);
      await harness.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
    const rows = await harness.run(async (ctx) => ({
      outOfScope: await ctx.db.get(parked.outOfScope),
      lowValue: await ctx.db.get(parked.lowValue),
    }));
    expect(rows.outOfScope).toMatchObject({
      state: 'discovered',
      reevaluation: { trigger: 'charter', key: result.charterId, at: expect.any(Number) },
    });
    expect(rows.outOfScope?.verdict).toBeUndefined();
    expect(rows.lowValue).toMatchObject({ state: 'skipped', skipReason: 'low-value: 10' });
    const events = await eventsOf(harness, agentId);
    expect(events.map((event) => event.type)).not.toContain('charter.reevaluation-unscheduled');
    expect(events.find((event) => event.type === 'work.requeued')?.payload).toEqual({
      workItemId: parked.outOfScope,
      trigger: 'charter',
      key: result.charterId,
      previousState: 'skipped',
    });
    expect(events.find((event) => event.type === 'work.reevaluation')?.payload).toEqual({
      trigger: 'charter',
      key: result.charterId,
      readmitted: 1,
      examined: 2,
    });
  });

  it('keeps an execution claim stable through amendment and refuses a mid-run retry', async () => {
    const t = convexTest(schema, allConvexModules());
    const { agentId } = await seedApproved(t);
    const ids = await t.run(async ctx => {
      const skillId = await ctx.db.insert('skills', {
        agentId, name: 'ticket-read', description: 'Read ticket', body: 'Read ticket',
        sourceType: 'agent-authored', state: 'registered', createdAt: 1,
      });
      const workItemId = await ctx.db.insert('workItems', {
        agentId, sourceCategory: 'ticket-queue', sourceSystem: 'linear', externalId: 'REVOPS-7',
        title: 'Read ticket', contentSummary: 'Read ticket', contentRefs: [],
        observedAt: 1, createdAt: 1, state: 'plan-approved',
        plan: { summary: 'Read', steps: ['Read ticket'], expectedOutputType: 'draft',
          riskNotes: '', reversibility: 'read-only', estimatedMinutes: 1 },
      });
      return { workItemId, skillId };
    });
    const owner = t.withIdentity({ subject: 'owner' });
    const claim = await t.mutation(internal.work.claimForExecution, ids);
    expect(claim.claimed).toBe(true);
    const before = await t.run(ctx => ctx.db.get(ids.workItemId));
    vi.useFakeTimers();
    try {
      await owner.mutation(api.charters.amend, {
        agentId, changes: [{ kind: 'edit-function', text: 'Read the revenue documentation.' }],
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally { vi.useRealTimers(); }
    await expect(owner.mutation(api.work.retryFailed, {
      workItemId: ids.workItemId, feedback: 'Try again now',
    })).rejects.toThrow('workItem state is executing');
    expect(await t.run(ctx => ctx.db.get(ids.workItemId))).toEqual(before);
    expect(await t.mutation(internal.work.claimForExecution, ids)).toMatchObject({ claimed: false });
  });

  it('numbers a second amendment v0.2 over v0.1', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedApproved(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    const first = await owner.mutation(api.charters.amend, {
      agentId,
      changes: [{ kind: 'edit-clause', field: 'escalationTriggers', index: 1, text: 'A request to change a forecast.' }],
    });
    const second = await owner.mutation(api.charters.amend, {
      agentId,
      changes: [{ kind: 'edit-clause', field: 'escalationTriggers', index: 0, text: '' }],
    });
    expect(second.version).toBe('0.2');
    const amended = await latestCharter(harness, agentId);
    expect(amended.supersedes).toBe(first.charterId);
    expect((amended.body as Charter).proposedBoundaries.escalationTriggers).toEqual([
      'A request to change a forecast.',
    ]);
  });

  it('refuses a draft, a stranger, a change that changes nothing and a clause the charter lacks', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const draft = await seedDraft(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    const edit = { kind: 'edit-function' as const, text: 'Something else.' };
    await expect(owner.mutation(api.charters.amend, { agentId: draft.agentId, changes: [edit] })).rejects.toThrow(
      /not approved/,
    );
    await owner.mutation(api.charters.approve, { charterId: draft.charterId });
    await expect(
      harness.withIdentity({ subject: 'stranger' }).mutation(api.charters.amend, { agentId: draft.agentId, changes: [edit] }),
    ).rejects.toThrow(/forbidden/);
    await expect(
      owner.mutation(api.charters.amend, {
        agentId: draft.agentId,
        changes: [{ kind: 'edit-function', text: runThroughBody().proposedFunction }],
      }),
    ).rejects.toThrow(/changes nothing/);
    await expect(
      owner.mutation(api.charters.amend, {
        agentId: draft.agentId,
        changes: [{ kind: 'edit-clause', field: 'willDo', index: 7, text: 'x' }],
      }),
    ).rejects.toThrow(/no willDo clause at index 7/);
    expect(await owner.query(api.charters.listForAgent, { agentId: draft.agentId })).toHaveLength(1);
    expect(await scheduledJobs(harness)).toEqual([]);
  });

  it('strikes a constraint after approval, removing its wording from the clauses', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedApproved(harness);
    await harness
      .withIdentity({ subject: 'owner' })
      .mutation(api.charters.amend, { agentId, changes: [{ kind: 'strike-constraint', index: 0 }] });
    const body = (await latestCharter(harness, agentId)).body as Charter;
    expect(body.proposedFunction).toBe('Own routine revenue operations work from Linear tickets for the RevOps team.');
    expect(body.proposedBoundaries.willDo[0]).toBe('Handle Linear tickets in the Q3 close project.');
    expect(body.constraints?.[0]).toMatchObject({ struck: true });
    expect(await workspaceFile(harness, agentId, 'IDENTITY.md')).not.toMatch(/owned/);
  });

  it('adds a rule and answers an open question', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedApproved(harness);
    await harness.withIdentity({ subject: 'owner' }).mutation(api.charters.amend, {
      agentId,
      changes: [
        {
          kind: 'add-constraint',
          constraint: { kind: 'system-boundary', quote: 'Never edit the forecast sheet.', clause: 'willNotDo' },
        },
        { kind: 'answer-question', question: 'Who owns the Looker pipeline tile.', answer: 'Priya.' },
      ],
    });
    const body = (await latestCharter(harness, agentId)).body as Charter;
    expect(body.proposedBoundaries.willNotDo).toEqual(['Post to public Slack channels.', 'Never edit the forecast sheet.']);
    expect(body.constraints?.[2]).toMatchObject({ origin: 'manager', wording: ['Never edit the forecast sheet.'] });
    expect(body.openQuestions).toEqual(['Whether Northstar CRM access will be granted.']);
    expect(body.answeredQuestions).toEqual([
      { question: 'Who owns the Looker pipeline tile.', answer: 'Priya.', answeredAt: expect.any(String) },
    ]);
    expect(await workspaceFile(harness, agentId, 'IDENTITY.md')).toContain('Never edit the forecast sheet.');
  });
});

describe('amending the named systems', (): void => {
  it('in real mode declares an added system and orients that surface only', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedApproved(harness);
    await harness.mutation(internal.surfaces.seedFromCharter, {
      agentId,
      namedSystems: runThroughBody().namedSystems,
    });
    expect(await scheduledJobs(harness)).toEqual([]);

    const result = await harness.withIdentity({ subject: 'owner' }).mutation(api.charters.amend, {
      agentId,
      changes: [
        { kind: 'add-system', system: { name: 'Looker', class: 'analytics', whereMentioned: 'The pipeline tile is in Looker.' } },
      ],
    });

    const surfaces = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('surfaces')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect(),
    );
    expect(surfaces.map((surface) => surface.slug).sort()).toEqual(['linear', 'looker', 'slack']);
    const looker = surfaces.find((surface) => surface.slug === 'looker');
    expect(looker).toMatchObject({ verdict: 'declared', class: 'analytics' });
    expect(looker?.discoveryEvidence).toEqual([
      expect.objectContaining({ kind: 'charter', quote: 'The pipeline tile is in Looker.', current: true }),
    ]);
    const jobs = await scheduledJobs(harness);
    expect(jobs).toEqual(
      expect.arrayContaining([
        { name: 'orientationActions:orientOne', args: [{ surfaceId: looker?._id }] },
        { name: 'work:reevaluatePending', args: [{ agentId, trigger: 'charter', key: result.charterId }] },
      ]),
    );
    expect(jobs).toHaveLength(2);
    expect(surfaces.find((surface) => surface.slug === 'linear')?.orientationJobId).toBeUndefined();
    expect((await latestCharter(harness, agentId)).body).toMatchObject({
      namedSystems: [...runThroughBody().namedSystems, { name: 'Looker', class: 'analytics' }],
    });
  });

  it('in real mode retires the charter evidence of a removed system and leaves its verdict', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedApproved(harness);
    await harness.mutation(internal.surfaces.seedFromCharter, {
      agentId,
      namedSystems: runThroughBody().namedSystems,
    });
    await harness.withIdentity({ subject: 'owner' }).mutation(api.charters.amend, {
      agentId,
      changes: [{ kind: 'remove-system', name: 'Slack' }],
    });
    const slack = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('surfaces')
          .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId).eq('slug', 'slack'))
          .unique(),
    );
    expect(slack).toMatchObject({ verdict: 'declared' });
    expect(slack?.discoveryEvidence).toEqual([expect.objectContaining({ kind: 'charter', current: false })]);
    expect((await scheduledJobs(harness)).map((job) => job.name)).toEqual(['work:reevaluatePending']);
    expect(((await latestCharter(harness, agentId)).body as Charter).namedSystems).toEqual([
      runThroughBody().namedSystems[0],
    ]);
  });

  it('in mock mode records the system on the charter and touches no surface', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seedApproved(harness);
    await harness.withIdentity({ subject: 'owner' }).mutation(api.charters.amend, {
      agentId,
      changes: [
        { kind: 'add-system', system: { name: 'Looker', class: 'analytics', whereMentioned: 'The pipeline tile.' } },
      ],
    });
    const surfaces = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('surfaces')
          .withIndex('by_agent', (q) => q.eq('agentId', agentId))
          .collect(),
    );
    expect(surfaces).toEqual([]);
    expect((await scheduledJobs(harness)).map((job) => job.name)).toEqual(['work:reevaluatePending']);
    expect(((await latestCharter(harness, agentId)).body as Charter).namedSystems).toHaveLength(3);
  });
});
