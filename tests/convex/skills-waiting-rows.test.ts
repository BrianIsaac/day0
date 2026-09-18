/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * Several items of one employee can wait for one skill: the first evaluation
 * proposes it and every later item of the same shape is linked to that
 * proposal. Whatever then happens to the skill has to reach every one of
 * them, not only the item that asked first. The rows are built the way the
 * 19 Sep full run built them: two tickets through the real evaluator, one
 * proposal, both parked at `needs-skill`.
 */

const recorded = vi.hoisted(() => ({
  scopeCalls: [] as string[],
  planCalls: [] as string[],
}));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (args: { agent: { name: string }; user: string }): Promise<unknown> => {
    if (args.agent.name === 'day0-scope-judgement') {
      recorded.scopeCalls.push(args.user);
      return { inScope: true, fit: true, reason: 'ticket notes are the charter work' };
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
      return {
        summary: 'Post the status note on the ticket.',
        steps: ['Comment on the ticket with the status note.'],
        expectedOutputType: 'message',
        riskNotes: '',
        reversibility: 'reversible',
        estimatedMinutes: 2,
      };
    },
  };
});

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };

afterEach((): void => {
  recorded.scopeCalls.length = 0;
  recorded.planCalls.length = 0;
  vi.useRealTimers();
  restoreSurfaceMode();
});

/**
 * An employee with an approved charter, the grants the evaluator asks for and
 * a connected Linear queue, but no skill that covers a ticket.
 *
 * Args:
 *   harness: Convex test harness.
 *   name: The employee's name.
 *
 * Returns:
 *   The agent id.
 */
async function seedEmployee(harness: Harness, name = 'Aiko'): Promise<Id<'agents'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name,
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
        proposedFunction: 'Logistics coordinator',
        proposedBoundaries: { willDo: ['shipment notes'], willNotDo: [], escalationTriggers: [] },
        approvalChain: { boss: 'boss@day0.local' },
      },
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
    title: `Post the shipment status note on ${externalId}`,
    contentSummary: 'Comment on this Linear ticket with the shipment status and close it.',
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

async function readSkill(harness: Harness, skillId: Id<'skills'>): Promise<Doc<'skills'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(skillId));
  if (!row) throw new Error('skill missing');
  return row;
}

/** The work items the scheduler holds an evaluation for, in the order they were scheduled. */
async function pendingEvaluations(harness: Harness): Promise<string[]> {
  return (
    await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
  )
    .filter((job) => job.state.kind === 'pending' && job.name.includes('evaluateWorkItemInternal'))
    .map((job) => String((job.args[0] as { workItemId: string }).workItemId));
}

interface Waiting {
  agentId: Id<'agents'>;
  first: Id<'workItems'>;
  second: Id<'workItems'>;
  skillId: Id<'skills'>;
}

/**
 * Two tickets through the real evaluator: the first proposes the skill, the
 * second is linked to the same proposal, both rest at `needs-skill`.
 *
 * Args:
 *   harness: Convex test harness.
 *
 * Returns:
 *   The agent, the two work items in discovery order and the one proposal.
 */
async function seedTwoWaitingForOneSkill(harness: Harness): Promise<Waiting> {
  const agentId = await seedEmployee(harness);
  const first = await seedTicket(harness, agentId, 'LOG-2');
  const second = await seedTicket(harness, agentId, 'LOG-1');
  await drain(harness);
  const [a, b] = [await readItem(harness, first), await readItem(harness, second)];
  expect(a.state).toBe('needs-skill');
  expect(b.state).toBe('needs-skill');
  if (!a.proposedSkillId) throw new Error('the first item proposed no skill');
  expect(b.proposedSkillId).toBe(a.proposedSkillId);
  const skill = await readSkill(harness, a.proposedSkillId);
  expect(skill).toMatchObject({ state: 'proposed', proposedFor: first });
  recorded.scopeCalls.length = 0;
  return { agentId, first, second, skillId: a.proposedSkillId };
}

async function approveAndClaim(harness: Harness, skillId: Id<'skills'>): Promise<Id<'events'>> {
  await harness.withIdentity(OWNER).mutation(api.skills.approve, { skillId });
  return await claim(harness, skillId);
}

async function claim(harness: Harness, skillId: Id<'skills'>): Promise<Id<'events'>> {
  const claimed = await harness.mutation(internal.skills.claimAuthoringRun, { skillId });
  if (!claimed.claimed) throw new Error(`claim refused: ${claimed.reason}`);
  return claimed.runId;
}

async function register(
  harness: Harness,
  skillId: Id<'skills'>,
  runId: Id<'events'>,
): Promise<void> {
  await expect(
    harness.mutation(internal.skills.completeRegistration, {
      skillId,
      runId,
      body: 'Comment on the ticket, then close it.',
      verificationLog: 'smoke test passed',
    }),
  ).resolves.toEqual({ registered: true });
}

describe('a skill that registers while several items wait for it', (): void => {
  it('re-evaluates every waiting item in discovery order, one slot at a time', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { first, second, skillId } = await seedTwoWaitingForOneSkill(harness);
    const runId = await approveAndClaim(harness, skillId);

    await register(harness, skillId, runId);

    for (const workItemId of [first, second]) {
      expect(await readItem(harness, workItemId)).toMatchObject({
        state: 'discovered',
        verdict: { decision: 'pending-reevaluation', reason: 'skill registered, ready to retry' },
      });
    }
    expect(await pendingEvaluations(harness)).toEqual([String(first), String(second)]);

    await drain(harness);

    // The supervised cap is one: the first item takes the slot and drafts its
    // plan, the second is evaluated too and queues behind it.
    expect(recorded.scopeCalls).toHaveLength(2);
    expect(recorded.scopeCalls[0]).toContain('LOG-2');
    expect(recorded.scopeCalls[1]).toContain('LOG-1');
    expect((await readItem(harness, first)).state).toBe('plan-pending');
    expect(await readItem(harness, second)).toMatchObject({
      state: 'discovered',
      verdict: { decision: 'queue' },
    });
    expect(recorded.planCalls).toEqual(['Post the shipment status note on LOG-2']);
  });

  it('re-queues the waiting items in mock mode too, and schedules nothing', async (): Promise<void> => {
    useSurfaceMode('mock');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const { first, second, skillId } = await seedLinkedPair(harness, agentId, 'proposed');
    const runId = await approveAndClaim(harness, skillId);

    await register(harness, skillId, runId);

    expect((await readItem(harness, first)).state).toBe('discovered');
    expect((await readItem(harness, second)).state).toBe('discovered');
    expect(await pendingEvaluations(harness)).toEqual([]);
  });

  it('leaves alone a linked item that has already moved on', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const { first, second, skillId } = await seedLinkedPair(harness, agentId, 'proposed');
    await harness.run(async (ctx) => {
      await ctx.db.patch(second, { state: 'cancelled', skipReason: 'cancelled by the manager' });
    });
    const runId = await approveAndClaim(harness, skillId);

    await register(harness, skillId, runId);

    expect((await readItem(harness, first)).state).toBe('discovered');
    expect(await readItem(harness, second)).toMatchObject({
      state: 'cancelled',
      skipReason: 'cancelled by the manager',
    });
  });

  it("does not touch another employee's waiting items", async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const otherAgentId = await seedEmployee(harness, 'Mateo');
    const { skillId } = await seedLinkedPair(harness, agentId, 'proposed');
    const other = await seedLinkedPair(harness, otherAgentId, 'proposed');
    const runId = await approveAndClaim(harness, skillId);

    await register(harness, skillId, runId);

    expect((await readItem(harness, other.first)).state).toBe('needs-skill');
    expect((await readItem(harness, other.second)).state).toBe('needs-skill');
  });
});

/**
 * Two parked tickets linked to one skill row, written directly.
 *
 * Args:
 *   harness: Convex test harness.
 *   agentId: The employee.
 *   state: The state the skill row is inserted in.
 *
 * Returns:
 *   The two work items in discovery order and the skill.
 */
async function seedLinkedPair(
  harness: Harness,
  agentId: Id<'agents'>,
  state: Doc<'skills'>['state'],
): Promise<Waiting> {
  return await harness.run(async (ctx) => {
    const ticket = async (externalId: string): Promise<Id<'workItems'>> =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId,
        title: `Post the shipment status note on ${externalId}`,
        contentSummary: 'Comment on this Linear ticket with the shipment status and close it.',
        contentRefs: [`ticket://${externalId}`],
        priority: 'High',
        state: 'needs-skill',
        verdict: {
          decision: 'needs-skill',
          reason: 'no registered skill covers this; agent will propose "kanban-comment-and-close"',
          suggestedSkillName: 'kanban-comment-and-close',
        },
        observedAt: Date.now(),
        createdAt: Date.now(),
      });
    const first = await ticket('LOG-2');
    const second = await ticket('LOG-1');
    const skillId = await ctx.db.insert('skills', {
      agentId,
      name: 'kanban-comment-and-close',
      description: 'Comment on and close a ticket.',
      body: '',
      sourceType: 'agent-authored',
      state,
      proposedFor: first,
      requiredScopes: ['linear:read', 'linear:write'],
      targetSurface: 'linear',
      surfaceClass: 'kanban',
      operation: 'comment-and-close',
      createdAt: Date.now(),
    });
    await ctx.db.patch(first, { proposedSkillId: skillId });
    await ctx.db.patch(second, { proposedSkillId: skillId });
    return { agentId, first, second, skillId };
  });
}

describe('a proposal the manager rejects while several items wait for it', (): void => {
  it.fails(
    'releases every waiting item with the reason the card shows',
    async (): Promise<void> => {
      useSurfaceMode('real');
      vi.useFakeTimers();
      const harness = convexTest(contractSchema(), allConvexModules());
      const { first, second, skillId } = await seedTwoWaitingForOneSkill(harness);

      await harness.withIdentity(OWNER).mutation(api.skills.reject, { skillId });

      for (const workItemId of [first, second]) {
        expect(await readItem(harness, workItemId)).toMatchObject({
          state: 'cancelled',
          skipReason: 'skill proposal "kanban-comment-and-close" rejected by the manager',
        });
      }
    },
  );

  it('keeps an item that is now linked to a different proposal', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const { first, second, skillId } = await seedLinkedPair(harness, agentId, 'proposed');
    const otherSkillId = await harness.run(async (ctx) => {
      const id = await ctx.db.insert('skills', {
        agentId,
        name: 'another-proposal',
        description: 'Another proposal.',
        body: '',
        sourceType: 'agent-authored',
        state: 'proposed',
        proposedFor: second,
        createdAt: Date.now(),
      });
      await ctx.db.patch(second, { proposedSkillId: id });
      return id;
    });

    await harness.withIdentity(OWNER).mutation(api.skills.reject, { skillId });

    expect((await readItem(harness, first)).state).toBe('cancelled');
    expect(await readItem(harness, second)).toMatchObject({
      state: 'needs-skill',
      proposedSkillId: otherSkillId,
    });
  });
});

describe('an authoring run that does not register the skill', (): void => {
  it('tells every waiting item why, and a Retry that registers re-queues them all', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { first, second, skillId } = await seedTwoWaitingForOneSkill(harness);
    const failedRun = await approveAndClaim(harness, skillId);

    await harness.mutation(internal.skills.failAuthoringRun, {
      skillId,
      runId: failedRun,
      rowReason: 'smoke test failed: the comment was not posted',
      reason: 'smoke test failed',
      eventType: 'skill.verification-failed',
    });

    for (const workItemId of [first, second]) {
      expect(await readItem(harness, workItemId)).toMatchObject({
        state: 'needs-skill',
        verdict: { decision: 'needs-skill', reason: 'smoke test failed' },
        proposedSkillId: skillId,
      });
    }

    await register(harness, skillId, await claim(harness, skillId));

    expect(await pendingEvaluations(harness)).toEqual([String(first), String(second)]);
    expect((await readItem(harness, first)).state).toBe('discovered');
    expect((await readItem(harness, second)).state).toBe('discovered');
  });

  it('tells every waiting item when the body was kept but not verified', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { first, second, skillId } = await seedTwoWaitingForOneSkill(harness);
    const runId = await approveAndClaim(harness, skillId);

    await harness.mutation(internal.skills.parkUnverified, {
      skillId,
      runId,
      sandboxId: '(skipped)',
      body: 'Comment on the ticket, then close it.',
      smokeTest: 'assert True',
      verificationLog: 'no sandbox was available',
      reason: 'no sandbox was available',
    });

    for (const workItemId of [first, second]) {
      expect(await readItem(harness, workItemId)).toMatchObject({
        state: 'needs-skill',
        verdict: {
          decision: 'needs-skill',
          reason: 'skill authored but not verified - no sandbox was available',
        },
      });
    }
  });
});

describe('a registered skill sent back for revision', (): void => {
  it('parks every item queued for it, and the next registration re-queues them all', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const { first, second, skillId } = await seedTwoWaitingForOneSkill(harness);
    await register(harness, skillId, await approveAndClaim(harness, skillId));

    await harness.withIdentity(OWNER).mutation(api.skills.requestRevision, { skillId });

    for (const workItemId of [first, second]) {
      expect(await readItem(harness, workItemId)).toMatchObject({
        state: 'needs-skill',
        verdict: {
          decision: 'needs-skill',
          reason: 'registered skill sent back for revision before first execution',
        },
      });
    }

    await register(harness, skillId, await claim(harness, skillId));

    expect((await readItem(harness, first)).state).toBe('discovered');
    expect((await readItem(harness, second)).state).toBe('discovered');
  });
});

describe('an item linked to a skill after it registered', (): void => {
  async function proposeFor(
    harness: Harness,
    agentId: Id<'agents'>,
    workItemId: Id<'workItems'>,
  ): Promise<Id<'skills'>> {
    return await harness.mutation(internal.skills.propose, {
      agentId,
      workItemId,
      name: 'kanban-comment-and-close',
      description: 'Comment on and close a ticket.',
      rationale: 'No skill covers a ticket comment yet.',
      requiredScopes: ['linear:read', 'linear:write'],
      surfaceClass: 'kanban',
      operation: 'comment-and-close',
    });
  }

  /** A third ticket whose evaluation read the skill list before registration and landed after. */
  async function seedLateItem(harness: Harness, agentId: Id<'agents'>): Promise<Id<'workItems'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('workItems', {
          agentId,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'LOG-3',
          title: 'Post the shipment status note on LOG-3',
          contentSummary: 'Comment on this Linear ticket with the shipment status and close it.',
          contentRefs: ['ticket://LOG-3'],
          priority: 'High',
          state: 'needs-skill',
          verdict: {
            decision: 'needs-skill',
            reason:
              'no registered skill covers this; agent will propose "kanban-comment-and-close"',
            suggestedSkillName: 'kanban-comment-and-close',
          },
          observedAt: Date.now(),
          createdAt: Date.now(),
        }),
    );
  }

  it.fails(
    're-queues it at once instead of parking it behind a skill that is already callable',
    async (): Promise<void> => {
      useSurfaceMode('real');
      vi.useFakeTimers();
      const harness = convexTest(contractSchema(), allConvexModules());
      const agentId = await seedEmployee(harness);
      const { skillId } = await seedLinkedPair(harness, agentId, 'registered');
      const late = await seedLateItem(harness, agentId);

      await expect(proposeFor(harness, agentId, late)).resolves.toBe(skillId);
      await harness.mutation(internal.work.setProposedSkill, { workItemId: late, skillId });

      expect(await readItem(harness, late)).toMatchObject({
        state: 'discovered',
        verdict: { decision: 'pending-reevaluation' },
        proposedSkillId: skillId,
      });
      expect(await pendingEvaluations(harness)).toEqual([String(late)]);
    },
  );

  it.fails(
    're-queues it once per registration, so a skill that does not cover it cannot loop',
    async (): Promise<void> => {
      useSurfaceMode('real');
      vi.useFakeTimers();
      const harness = convexTest(contractSchema(), allConvexModules());
      const agentId = await seedEmployee(harness);
      const { skillId } = await seedLinkedPair(harness, agentId, 'registered');
      const late = await seedLateItem(harness, agentId);
      await proposeFor(harness, agentId, late);
      // The evaluator says needs-skill again, naming the same registered skill.
      await harness.mutation(internal.work.setVerdict, {
        workItemId: late,
        verdict: {
          decision: 'needs-skill',
          reason: 'no registered skill covers this; agent will propose "kanban-comment-and-close"',
          suggestedSkillName: 'kanban-comment-and-close',
        },
      });

      await expect(proposeFor(harness, agentId, late)).resolves.toBe(skillId);

      const parked = await readItem(harness, late);
      expect(parked.state).toBe('needs-skill');
      expect((parked.verdict as { reason: string }).reason).toBe(
        'registered skill "kanban-comment-and-close" was tried and does not cover this item',
      );
    },
  );

  it('is caught by the registration itself when the link had not landed yet', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const { skillId } = await seedLinkedPair(harness, agentId, 'proposed');
    const unlinked = await seedLateItem(harness, agentId);
    const runId = await approveAndClaim(harness, skillId);

    await register(harness, skillId, runId);

    expect((await readItem(harness, unlinked)).state).toBe('discovered');
  });
});

describe('two proposals of one name', (): void => {
  it('re-queues an item parked behind a failed proposal when a later one of that name registers', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const failed = await seedLinkedPair(harness, agentId, 'failed');
    const replacementId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('skills', {
          agentId,
          name: 'kanban-comment-and-close',
          description: 'Comment on and close a ticket.',
          body: '',
          sourceType: 'agent-authored',
          state: 'approved',
          requiredScopes: ['linear:read', 'linear:write'],
          targetSurface: 'linear',
          surfaceClass: 'kanban',
          operation: 'comment-and-close',
          createdAt: Date.now(),
        }),
    );

    await register(harness, replacementId, await claim(harness, replacementId));

    expect((await readItem(harness, failed.first)).state).toBe('discovered');
    expect((await readItem(harness, failed.second)).state).toBe('discovered');
  });

  it.fails(
    'links a later item to the live proposal, not to a new one beside it',
    async (): Promise<void> => {
      useSurfaceMode('real');
      vi.useFakeTimers();
      const harness = convexTest(contractSchema(), allConvexModules());
      const agentId = await seedEmployee(harness);
      const failed = await seedLinkedPair(harness, agentId, 'failed');
      const args = {
        agentId,
        name: 'kanban-comment-and-close',
        description: 'Comment on and close a ticket.',
        rationale: 'No skill covers a ticket comment yet.',
        requiredScopes: ['linear:read', 'linear:write'],
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
      };

      const live = await harness.mutation(internal.skills.propose, {
        ...args,
        workItemId: failed.first,
      });
      const again = await harness.mutation(internal.skills.propose, {
        ...args,
        workItemId: failed.second,
      });

      expect(live).not.toBe(failed.skillId);
      expect(again).toBe(live);
    },
  );
});
