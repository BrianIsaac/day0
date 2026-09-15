/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import type { Charter } from '../../src/agent/charter';

type Harness = TestConvex<typeof schema>;

/** The 14 September draft: the owner phrase encoded twice, one constraint listing it. */
export function runThroughBody(): Charter {
  return {
    version: '0.0',
    source: 'day-1 manager 1:1',
    whyThisHire: 'A small RevOps team is drowning in tier-2 asks during the Q3 close.',
    proposedFunction:
      'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps team.',
    evidence: [{ text: 'Formal work is in Linear.', source: 'from manager 1:1 day-1' }],
    shortTermGoals: { day30: 'Clean drafts.', day60: 'Own tickets.', day90: 'Cover close week.' },
    proposedBoundaries: {
      willDo: [
        'Handle owned, prioritized Linear tickets in the Q3 close project.',
        'Draft replies to asks in #revops-asks.',
      ],
      willNotDo: ['Post to public Slack channels.'],
      escalationTriggers: ['A ticket outside the Q3 close project.'],
    },
    namedCollaborators: [{ name: 'Priya', topic: 'pipeline', introPath: 'manager' }],
    namedSystems: [
      { name: 'Linear', class: 'kanban', whereMentioned: 'Formal work is in Linear.' },
      { name: 'Slack', class: 'chat', whereMentioned: 'Asks arrive in Slack #revops-asks.' },
    ],
    priorityReading: ['team overview'],
    adjacentRoles: [],
    approvalChain: { boss: 'Brian', confidence: 'high' },
    openQuestions: ['Whether Northstar CRM access will be granted.', 'Who owns the Looker pipeline tile.'],
    constraints: [
      {
        kind: 'candidate-property',
        quote: "if it's a ticket it has an owner and a priority",
        wording: ['owned, prioritized'],
        origin: 'synthesis',
      },
      {
        kind: 'system-boundary',
        quote: 'Never post to public channels.',
        wording: ['Post to public Slack channels.'],
        origin: 'synthesis',
      },
    ],
    createdAt: '2026-09-14T12:00:00.000Z',
  };
}

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
