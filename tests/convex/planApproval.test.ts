/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { ExecutionPlan } from '../../src/work/types';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import {
  AGREEMENT_NOT_A_SENTENCE,
  AGREEMENT_STATEMENT_TOO_LONG,
} from '../../convex/workingAgreements';

/**
 * A plan's arrival and its approval (`convex/planApproval.ts`, moved out of `convex/work.ts` by
 * 13-W): the "Keep this note for later work of this kind" tick keeps the approval's note as a
 * working agreement in the same click, active once its check against the charter answers, and a
 * stored plan records the working agreements it applied. The refusal judgement is scripted at the
 * model seam: a note that tells the employee to email the customer itself contradicts the
 * charter's clause.
 */

const recorded = vi.hoisted(() => ({ refusals: [] as string[] }));

vi.mock('../../src/lib/mastra', async () => {
  const { schemaChecked } = await import('./fakes/mastra');
  return {
    MODEL_CONFIG: 'openai/mock',
    MODEL_PROVIDER_MAX_RETRIES: 2,
    makeAgent: (name: string): { name: string } => ({ name }),
    agentJson: schemaChecked((call) => {
      if (call.agent.name === 'day0-agreement-refusal') {
        recorded.refusals.push(call.user);
        return /yourself/i.test(call.user.split('--- Statement ---')[1] ?? '')
          ? { verdict: 'contradicts-will-not-do', clause: 1 }
          : { verdict: 'keep', clause: null };
      }
      throw new Error(`unscripted agent ${call.agent.name}`);
    }),
    agentText: async (): Promise<string> => '',
  };
});

type Harness = TestConvex<typeof schema>;
const OWNER = managerIdentity();

const plan: ExecutionPlan = {
  summary: 'Comment the delay notice on the ticket.',
  steps: ['Comment the Delay notice B template on LOG-1.'],
  expectedOutputType: 'ticket-update',
  riskNotes: 'Which template applies to a customs hold?',
  reversibility: 'reversible',
  estimatedMinutes: 2,
};

beforeEach((): void => {
  vi.useFakeTimers();
});

afterEach((): void => {
  recorded.refusals.length = 0;
  vi.useRealTimers();
  restoreSurfaceMode();
});

async function drain(harness: Harness): Promise<void> {
  // Each round starts what is due and awaits it in real time, until nothing due is left: an action
  // that awaits real work on a busy machine outlasted convex-test's 10,000 macrotask pumps in
  // `finishAllScheduledFunctions` (a flake seen on the pre-tag's runs, on `2478d192` too).
  for (let round = 0; round < DRAIN_ROUND_LIMIT; round += 1) {
    vi.advanceTimersByTime(0);
    await harness.finishInProgressScheduledFunctions();
    const due = await harness.run(
      async (ctx) =>
        (await ctx.db.system.query('_scheduled_functions').collect()).filter(
          (job) => job.state.kind === 'pending' && job.scheduledTime <= Date.now(),
        ).length,
    );
    if (due === 0) return;
  }
  throw new Error(`scheduled work still due after ${DRAIN_ROUND_LIMIT} rounds`);
}

/** Rounds of scheduled work a drain runs before it calls the chain endless. */
const DRAIN_ROUND_LIMIT = 50;

/** One employee with an approved charter and one work item in the state the test names. */
async function seed(
  harness: Harness,
  state: Doc<'workItems'>['state'],
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
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
        proposedFunction: 'Logistics desk.',
        proposedBoundaries: {
          willDo: ['shipment exception tickets'],
          willNotDo: ['email customers directly'],
          escalationTriggers: [],
        },
        approvalChain: { boss: MANAGER_ADDRESS },
      },
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'Linear',
      externalId: 'LOG-1',
      title: 'Exception: SH-4471 held at customs',
      contentSummary: 'Notify the customer.',
      contentRefs: [],
      state,
      verdict: { decision: 'claim', value: 60, risk: 20, requiredPermissions: [] },
      ...(state === 'plan-pending' ? { plan } : {}),
      observedAt: 1,
      createdAt: 1,
    });
    return { agentId, workItemId };
  });
}

async function agreementsOf(harness: Harness): Promise<Doc<'workingAgreements'>[]> {
  return await harness.run(async (ctx) => await ctx.db.query('workingAgreements').collect());
}

describe('the "Keep this note" tick at plan approval', (): void => {
  it('keeps the note as an agreement in the same click, active once the check answers', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'plan-pending');
    const note = 'Use the Delay notice B template for customs holds.';

    await harness
      .withIdentity(OWNER)
      .mutation(api.planApproval.approvePlan, { workItemId, note, keepNote: true });
    const [kept] = await agreementsOf(harness);
    expect(kept).toMatchObject({
      userId: 'owner',
      agentId,
      statement: note,
      scope: 'surface',
      scopeRef: 'linear',
      sourceType: 'plan-approval',
      workItemId,
      approvedVia: 'plan-approval',
      approvedAt: expect.any(Number),
    });
    // The same click approved the plan, with the note for this run as well.
    const approved = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(approved?.state).toBe('plan-approved');
    expect(approved?.managerAnswers?.map((answer) => answer.answer)).toEqual([note]);
    await drain(harness);

    expect((await agreementsOf(harness))[0]).toMatchObject({
      status: 'active',
      effectiveFrom: expect.any(Number),
    });
    expect(recorded.refusals[0]).toContain(note);
    const activated = (
      await harness.run(async (ctx) => await ctx.db.query('events').collect())
    ).filter((event) => event.type === 'agreement.activated');
    expect(activated.map((event) => event.payload)).toEqual([
      { agreementId: kept?._id, everyEmployee: false, approvedVia: 'plan-approval', workItemId },
    ]);
  });

  it('approves the plan and refuses a note that contradicts a willNotDo clause, with the clause', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'plan-pending');
    await harness.withIdentity(OWNER).mutation(api.planApproval.approvePlan, {
      workItemId,
      note: 'Email the customer the template yourself.',
      keepNote: true,
    });
    await drain(harness);

    expect((await agreementsOf(harness))[0]).toMatchObject({
      status: 'refused',
      refusal: { reason: 'contradicts-will-not-do', clause: 'email customers directly' },
    });
    expect((await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.state).not.toBe(
      'plan-pending',
    );
  });

  it('keeps nothing without the tick, and refuses the tick with no note or in mock mode', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'plan-pending');
    await expect(
      harness
        .withIdentity(OWNER)
        .mutation(api.planApproval.approvePlan, { workItemId, keepNote: true }),
    ).rejects.toThrow('Write the agreement before keeping it.');
    await harness
      .withIdentity(OWNER)
      .mutation(api.planApproval.approvePlan, { workItemId, note: 'For this run only.' });
    expect(await agreementsOf(harness)).toEqual([]);

    useSurfaceMode('mock');
    const mock = convexTest(schema, allConvexModules());
    const seeded = await seed(mock, 'plan-pending');
    await expect(
      mock.withIdentity(OWNER).mutation(api.planApproval.approvePlan, {
        workItemId: seeded.workItemId,
        note: 'Use template B.',
        keepNote: true,
      }),
    ).rejects.toThrow('Working agreements are kept in real mode only.');
    expect((await mock.run(async (ctx) => await ctx.db.get(seeded.workItemId)))?.state).toBe(
      'plan-pending',
    );
  });
});

describe('the note the tick keeps, held to what an edit keeps (W13-R32)', (): void => {
  it('refuses a note past the limit, as an edit does, and a word that is no sentence, approving nothing', async (): Promise<void> => {
    useSurfaceMode('real');
    for (const [note, refusal] of [
      [`Use template B ${'and say so again '.repeat(40)}`, AGREEMENT_STATEMENT_TOO_LONG],
      ['Yes', AGREEMENT_NOT_A_SENTENCE],
      ['Evergreen.', AGREEMENT_NOT_A_SENTENCE],
    ] as const) {
      const harness = convexTest(schema, allConvexModules());
      const { workItemId } = await seed(harness, 'plan-pending');
      await expect(
        harness
          .withIdentity(OWNER)
          .mutation(api.planApproval.approvePlan, { workItemId, note, keepNote: true }),
      ).rejects.toThrow(refusal);
      expect(await agreementsOf(harness)).toEqual([]);
      expect((await harness.run(async (ctx) => await ctx.db.get(workItemId)))?.state).toBe(
        'plan-pending',
      );
    }
  });

  it('keeps a short direction of two words (the code reader: "Use UTC." is a sentence)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'plan-pending');
    await harness
      .withIdentity(OWNER)
      .mutation(api.planApproval.approvePlan, { workItemId, note: 'Use UTC.', keepNote: true });
    expect((await agreementsOf(harness)).map((row) => row.statement)).toEqual(['Use UTC.']);
  });
});

describe('a stored plan and the working agreements it applied', (): void => {
  it('keeps only active agreements that bind the employee, and lists the item on each', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, workItemId } = await seed(harness, 'claimed');
    const [own, everyone, retired, stranger] = await harness.run(async (ctx) => {
      const base = {
        kind: 'preference' as const,
        statement: 'Comment on the ticket.',
        scope: 'global' as const,
        sourceType: 'plan-approval' as const,
        createdAt: 1,
        appliedTo: [],
      };
      return await Promise.all([
        ctx.db.insert('workingAgreements', { ...base, userId: 'owner', agentId, status: 'active' }),
        ctx.db.insert('workingAgreements', { ...base, userId: 'owner', status: 'active' }),
        ctx.db.insert('workingAgreements', { ...base, userId: 'owner', status: 'retired' }),
        ctx.db.insert('workingAgreements', { ...base, userId: 'stranger', status: 'active' }),
      ]);
    });
    await harness.mutation(internal.planApproval.setPlan, {
      workItemId,
      plan: { ...plan, appliedAgreements: [own, everyone, retired, stranger, 'forged'] },
    });

    const stored = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect((stored?.plan as ExecutionPlan).appliedAgreements).toEqual([own, everyone]);
    const rows = await agreementsOf(harness);
    expect(rows.filter((row) => row.appliedTo.includes(workItemId)).map((row) => row._id)).toEqual([
      own,
      everyone,
    ]);
  });

  it('stores a plan that names no agreement exactly as drafted', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { workItemId } = await seed(harness, 'claimed');
    await harness.mutation(internal.planApproval.setPlan, { workItemId, plan });
    const stored = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(stored?.plan).toEqual(plan);
  });
});
