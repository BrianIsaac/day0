/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { ExecutionPlan } from '../../src/work/types';
import { AGREEMENT_NOT_YOURS } from '../../src/work/agreement-vocabulary';
import { EMPLOYEES_CHECKED, EVERY_EMPLOYEE_TOO_MANY } from '../../convex/workingAgreements';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

/**
 * Working agreements (wave 13, 13-W): proposed from a correction applied to a second item or from
 * corrections the model judges alike, refused before they are shown when they would go beyond the
 * charter, and kept on a card, where the keep is checked again before the agreement takes effect.
 * The model is scripted at its seam: the refusal refuses a statement that tells the employee to
 * email the customer itself, quoting the charter's clause by number, and the sameness judgement
 * groups the corrections that both mention the customer's email.
 */

const recorded = vi.hoisted(() => ({
  model: [] as Array<{ agent: string; user: string }>,
  refusalDown: false,
}));

vi.mock('../../src/lib/mastra', async () => {
  const { schemaChecked: checked } = await import('./fakes/mastra');
  return {
    MODEL_CONFIG: 'openai/mock',
    MODEL_PROVIDER_MAX_RETRIES: 2,
    makeAgent: (name: string): { name: string } => ({ name }),
    agentJson: checked((call) => {
      recorded.model.push({ agent: call.agent.name, user: call.user });
      if (call.agent.name === 'day0-agreement-refusal') {
        if (recorded.refusalDown) throw new Error('model down');
        const statement = call.user.split('--- Statement ---\n')[1] ?? '';
        const clauses = [...call.user.matchAll(/\[(\d+)\] (.+)/g)];
        const emailing = clauses.find((clause) => clause[2] === 'email customers directly');
        return /yourself/i.test(statement) && emailing
          ? { verdict: 'contradicts-will-not-do', clause: Number(emailing[1]) }
          : { verdict: 'keep', clause: null };
      }
      if (call.agent.name === 'day0-agreement-sameness') {
        const listed = JSON.parse(call.user.split('\n')[1] ?? '[]') as Array<{
          id: string;
          text: string;
        }>;
        const alike = listed.filter((entry) => /customer/i.test(entry.text));
        return { groups: alike.length >= 2 ? [{ ids: alike.map((entry) => entry.id) }] : [] };
      }
      throw new Error(`unscripted agent ${call.agent.name}`);
    }),
    agentText: async (): Promise<string> => '',
  };
});

type Harness = TestConvex<typeof schema>;
const OWNER = managerIdentity();
const STRANGER = managerIdentity('stranger');

const NO_EMAIL = 'Comment on the ticket and let the account team email the customer.';
const NO_EMAIL_AGAIN = 'Never email the customer; the account team sends it from the ticket.';
const EMAIL_YOURSELF = 'Email the customer the new sailing yourself.';
const EMAIL_YOURSELF_AGAIN = 'Send the customer the email yourself, today.';

beforeEach((): void => {
  useSurfaceMode('real');
  vi.useFakeTimers();
});

afterEach((): void => {
  recorded.model.length = 0;
  recorded.refusalDown = false;
  vi.useRealTimers();
  restoreSurfaceMode();
});

/** Run every scheduled job that is due, and every job those schedule. */
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

/** One employee of the owner with an approved charter that will not email customers directly. */
async function seedEmployee(
  harness: Harness,
  options: { name?: string; userId?: string; willNotDo?: string[] } = {},
): Promise<Id<'agents'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: options.name ?? 'Priya',
      userId: options.userId ?? 'owner',
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
        proposedFunction: 'Logistics desk: handle shipment exception tickets in Linear.',
        proposedBoundaries: {
          willDo: ['shipment exception tickets'],
          willNotDo: options.willNotDo ?? ['change carrier contracts', 'email customers directly'],
          escalationTriggers: [],
        },
        approvalChain: { boss: MANAGER_ADDRESS },
      },
    });
    return agentId;
  });
}

const plan: ExecutionPlan = {
  summary: 'Send the delay notice.',
  steps: ['Comment the delay notice on the ticket.'],
  expectedOutputType: 'ticket-update',
  riskNotes: '',
  reversibility: 'reversible',
  estimatedMinutes: 2,
};

/** A work item of the employee's, on Linear, in a state the test names. */
async function seedItem(
  harness: Harness,
  agentId: Id<'agents'>,
  externalId: string,
  state: Doc<'workItems'>['state'],
  sourceSystem = 'linear',
): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem,
        externalId,
        title: `Exception: ${externalId}`,
        contentSummary: 'Notify the customer.',
        contentRefs: [],
        state,
        verdict: { decision: 'claim', value: 60, risk: 20, requiredPermissions: [] },
        ...(state === 'plan-pending' ? { plan } : {}),
        observedAt: 1,
        createdAt: 1,
      }),
  );
}

/** The manager cancels a pending plan with a reason, which is kept as a correction. */
async function cancelWith(
  harness: Harness,
  agentId: Id<'agents'>,
  externalId: string,
  reason: string,
): Promise<Id<'workItems'>> {
  const workItemId = await seedItem(harness, agentId, externalId, 'plan-pending');
  await harness.withIdentity(OWNER).mutation(api.work.cancelPlan, { workItemId, reason });
  await drain(harness);
  return workItemId;
}

async function agreementsOf(harness: Harness): Promise<Doc<'workingAgreements'>[]> {
  return await harness.run(async (ctx) => await ctx.db.query('workingAgreements').collect());
}

async function correctionsOf(harness: Harness): Promise<Doc<'corrections'>[]> {
  return await harness.run(async (ctx) => await ctx.db.query('corrections').collect());
}

async function eventsOf(harness: Harness, type: string): Promise<Doc<'events'>[]> {
  return (await harness.run(async (ctx) => await ctx.db.query('events').collect())).filter(
    (event) => event.type === type,
  );
}

function promptsOf(agent: string): string[] {
  return recorded.model.filter((call) => call.agent === agent).map((call) => call.user);
}

/** Store a drafted plan on a claimed item that says it applied the corrections named. */
async function planApplying(
  harness: Harness,
  agentId: Id<'agents'>,
  externalId: string,
  correctionIds: readonly Id<'corrections'>[],
): Promise<Id<'workItems'>> {
  const workItemId = await seedItem(harness, agentId, externalId, 'claimed');
  await harness.mutation(internal.planApproval.setPlan, {
    workItemId,
    plan: { ...plan, appliedCorrections: [...correctionIds] },
  });
  await drain(harness);
  return workItemId;
}

describe('proposals from corrections', (): void => {
  it('proposes an agreement from a correction applied to a second item', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await cancelWith(harness, agentId, 'LOG-1', NO_EMAIL);
    const [correction] = await correctionsOf(harness);
    expect(await agreementsOf(harness)).toEqual([]);

    await planApplying(harness, agentId, 'LOG-2', [correction!._id]);

    const [agreement] = await agreementsOf(harness);
    expect(agreement).toMatchObject({
      userId: 'owner',
      agentId,
      statement: NO_EMAIL,
      scope: 'surface',
      scopeRef: 'linear',
      sourceType: 'correction-promotion',
      correctionIds: [correction!._id],
      status: 'proposed',
    });
    expect(agreement?.approvedAt).toBeUndefined();
    expect((await correctionsOf(harness))[0]?.agreementId).toBe(agreement?._id);
    // Checked against the charter before it was shown.
    expect(promptsOf('day0-agreement-refusal')[0]).toContain(NO_EMAIL);
    expect((await eventsOf(harness, 'agreement.proposed')).map((event) => event.payload)).toEqual([
      {
        agreementId: agreement?._id,
        everyEmployee: false,
        source: 'correction-promotion',
        correctionIds: [correction!._id],
      },
    ]);

    // Applied to a third item, it is not proposed again.
    await planApplying(harness, agentId, 'LOG-3', [correction!._id]);
    expect(await agreementsOf(harness)).toHaveLength(1);
  });

  it('proposes one agreement from two corrections the judgement calls the same', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await cancelWith(harness, agentId, 'LOG-1', NO_EMAIL);
    await cancelWith(harness, agentId, 'LOG-2', NO_EMAIL_AGAIN);

    const corrections = (await correctionsOf(harness)).sort((a, b) => a.createdAt - b.createdAt);
    const agreements = await agreementsOf(harness);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]).toMatchObject({
      statement: NO_EMAIL_AGAIN,
      correctionIds: corrections.map((correction) => correction._id),
      status: 'proposed',
    });
    for (const correction of await correctionsOf(harness)) {
      expect(correction.agreementId).toBe(agreements[0]?._id);
      expect(correction.agreementJudgedAt).toEqual(expect.any(Number));
    }
    const [sameness] = promptsOf('day0-agreement-sameness');
    for (const correction of corrections) expect(sameness).toContain(correction._id);
  });

  it('adds a correction given again to the open proposal it repeats, so the card says it was said twice (found on the bed)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await cancelWith(harness, agentId, 'LOG-1', NO_EMAIL);
    const [first] = await correctionsOf(harness);
    // The planner applies it to the next item before the manager rejects that one too.
    await planApplying(harness, agentId, 'LOG-2', [first!._id]);
    const [proposal] = await agreementsOf(harness);
    expect(proposal?.correctionIds).toEqual([first!._id]);

    await cancelWith(harness, agentId, 'LOG-3', NO_EMAIL_AGAIN);
    const agreements = await agreementsOf(harness);
    expect(agreements).toHaveLength(1);
    const again = (await correctionsOf(harness)).find((row) => row._id !== first!._id);
    expect(agreements[0]?.correctionIds).toEqual([first!._id, again!._id]);
    expect(again?.agreementId).toBe(proposal?._id);
    expect(agreements[0]?.statement).toBe(NO_EMAIL);
  });

  it('never proposes the same words twice: a correction promoted while its words wait in a proposal joins it (found on the bed)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await cancelWith(harness, agentId, 'LOG-1', NO_EMAIL);
    const [first] = await correctionsOf(harness);
    await planApplying(harness, agentId, 'LOG-2', [first!._id]);
    // The same words again, judged with nothing new beside them, then applied to a further item.
    await cancelWith(harness, agentId, 'LOG-3', NO_EMAIL);
    const again = (await correctionsOf(harness)).find((row) => row._id !== first!._id)!;
    await harness.run(async (ctx) => {
      await ctx.db.patch(again._id, { agreementId: undefined, agreementJudgedAt: 1 });
      const [proposal] = await ctx.db.query('workingAgreements').collect();
      await ctx.db.patch(proposal!._id, { correctionIds: [first!._id] });
    });
    await planApplying(harness, agentId, 'LOG-4', [again._id]);

    const agreements = await agreementsOf(harness);
    expect(agreements).toHaveLength(1);
    expect(agreements[0]?.correctionIds).toEqual([first!._id, again._id]);
  });

  it('judges each new correction at most once', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await cancelWith(harness, agentId, 'LOG-1', 'Use the Delay notice B template.');
    await cancelWith(harness, agentId, 'LOG-2', 'Follow up with the carrier in 48 hours.');
    expect(promptsOf('day0-agreement-sameness')).toHaveLength(1);
    expect(await agreementsOf(harness)).toEqual([]);

    // A plan stored afterwards finds nothing new to judge.
    await planApplying(harness, agentId, 'LOG-3', []);
    expect(promptsOf('day0-agreement-sameness')).toHaveLength(1);
  });

  it('judges again at the next plan when the judgement could not be had', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await cancelWith(harness, agentId, 'LOG-1', NO_EMAIL);
    recorded.refusalDown = true;
    await cancelWith(harness, agentId, 'LOG-2', NO_EMAIL_AGAIN);
    expect(await agreementsOf(harness)).toEqual([]);
    expect((await correctionsOf(harness)).every((row) => row.agreementId === undefined)).toBe(true);

    recorded.refusalDown = false;
    await planApplying(harness, agentId, 'LOG-3', []);
    expect(await agreementsOf(harness)).toMatchObject([{ status: 'proposed' }]);
  });

  it('proposes from a channel correction and never activates it without the card', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const given = await seedItem(harness, agentId, 'LOG-1', 'cancelled');
    const correctionId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('corrections', {
          agentId,
          workItemId: given,
          kind: 'plan-rejection',
          text: NO_EMAIL,
          itemTitle: 'Exception: LOG-1',
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          surfaces: ['linear'],
          createdAt: 1,
          appliedTo: [],
          origin: 'channel',
        }),
    );
    const second = await planApplying(harness, agentId, 'LOG-2', [correctionId]);

    const [agreement] = await agreementsOf(harness);
    expect(agreement).toMatchObject({ status: 'proposed', correctionIds: [correctionId] });
    await drain(harness);
    expect((await agreementsOf(harness))[0]?.status).toBe('proposed');
    expect(
      await harness.query(internal.workingAgreements.selectedForCandidate, {
        workItemId: second,
      }),
    ).toEqual([]);

    await harness.withIdentity(OWNER).mutation(api.workingAgreements.keep, {
      agreementId: agreement!._id,
      agentId,
      forEveryEmployee: false,
      via: 'promotion-card',
    });
    await drain(harness);
    expect((await agreementsOf(harness))[0]?.status).toBe('active');
  });
});

describe('the refusal before a proposal is shown', (): void => {
  it('refuses a statement contradicting a kept willNotDo clause, with the clause quoted', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await cancelWith(harness, agentId, 'LOG-1', EMAIL_YOURSELF);
    await cancelWith(harness, agentId, 'LOG-2', EMAIL_YOURSELF_AGAIN);

    const [agreement] = await agreementsOf(harness);
    expect(agreement).toMatchObject({
      status: 'refused',
      refusal: { reason: 'contradicts-will-not-do', clause: 'email customers directly' },
    });
    expect((await eventsOf(harness, 'agreement.refused')).map((event) => event.payload)).toEqual([
      {
        agreementId: agreement?._id,
        everyEmployee: false,
        reason: 'contradicts-will-not-do',
        clause: 'email customers directly',
      },
    ]);
    expect(await eventsOf(harness, 'agreement.proposed')).toEqual([]);
    const listed = await harness
      .withIdentity(OWNER)
      .query(api.workingAgreements.listForAgent, { agentId });
    expect(listed.map((row) => row.status)).toEqual(['refused']);
  });

  it('refuses a statement naming a credential and keeps it redacted', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await cancelWith(
      harness,
      agentId,
      'LOG-1',
      'Post the notice with the bot token xoxb-1234567890-abcdefghij.',
    );
    const [correction] = await correctionsOf(harness);
    await planApplying(harness, agentId, 'LOG-2', [correction!._id]);

    const [agreement] = await agreementsOf(harness);
    expect(agreement).toMatchObject({ status: 'refused', refusal: { reason: 'names-credential' } });
    expect(agreement?.statement).not.toContain('xoxb-1234567890-abcdefghij');
    expect(agreement?.statement).toContain('Post the notice with the bot token');
    expect(promptsOf('day0-agreement-refusal')).toEqual([]);
  });
});

describe('keeping an agreement on a card', (): void => {
  async function proposal(
    harness: Harness,
    agentId: Id<'agents'>,
  ): Promise<Id<'workingAgreements'>> {
    await cancelWith(harness, agentId, 'LOG-1', NO_EMAIL);
    await cancelWith(harness, agentId, 'LOG-2', NO_EMAIL_AGAIN);
    const [agreement] = await agreementsOf(harness);
    if (!agreement) throw new Error('no proposal');
    return agreement._id;
  }

  it('makes a kept proposal active once its check passes, for its employee', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const agreementId = await proposal(harness, agentId);
    recorded.model.length = 0;

    await harness.withIdentity(OWNER).mutation(api.workingAgreements.keep, {
      agreementId,
      agentId,
      forEveryEmployee: false,
      via: 'promotion-card',
    });
    const waiting = (await agreementsOf(harness))[0];
    expect(waiting).toMatchObject({ status: 'proposed', approvedVia: 'promotion-card' });
    await drain(harness);

    expect((await agreementsOf(harness))[0]).toMatchObject({
      status: 'active',
      agentId,
      effectiveFrom: expect.any(Number),
    });
    expect(promptsOf('day0-agreement-refusal')).toHaveLength(1);
    expect((await eventsOf(harness, 'agreement.activated')).map((event) => event.payload)).toEqual([
      { agreementId, everyEmployee: false, approvedVia: 'promotion-card' },
    ]);
  });

  it("keeps one for every employee, checked against each employee's charter", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const mateo = await seedEmployee(harness, { name: 'Mateo', willNotDo: ['approve refunds'] });
    const agreementId = await proposal(harness, agentId);
    recorded.model.length = 0;

    await harness.withIdentity(OWNER).mutation(api.workingAgreements.keep, {
      agreementId,
      agentId,
      forEveryEmployee: true,
      via: 'promotion-card',
    });
    await drain(harness);

    const [kept] = await agreementsOf(harness);
    expect(kept?.status).toBe('active');
    expect(kept?.agentId).toBeUndefined();
    const [refusalPrompt] = promptsOf('day0-agreement-refusal');
    expect(refusalPrompt).toContain('Priya: willDo');
    expect(refusalPrompt).toContain('Mateo: willDo');
    expect(refusalPrompt).toContain('approve refunds');
    const mateoItem = await seedItem(harness, mateo, 'LOG-9', 'claimed');
    expect(
      (
        await harness.query(internal.workingAgreements.selectedForCandidate, {
          workItemId: mateoItem,
        })
      ).map((row) => row._id),
    ).toEqual([agreementId]);
    const mateoSlack = await seedItem(harness, mateo, 'C1-1.1', 'claimed', 'slack');
    expect(
      await harness.query(internal.workingAgreements.selectedForCandidate, {
        workItemId: mateoSlack,
      }),
    ).toEqual([]);
  });

  it('asks no model while its employee is paused: the check waits, and so does the proposal run (W13-R45)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const agreementId = await proposal(harness, agentId);
    await harness.run(async (ctx) => await ctx.db.patch(agentId, { pausedAt: 1 }));
    recorded.model.length = 0;
    await harness.withIdentity(OWNER).mutation(api.workingAgreements.keep, {
      agreementId,
      agentId,
      forEveryEmployee: false,
      via: 'promotion-card',
    });
    await drain(harness);
    await harness.action(internal.workingAgreementActions.proposeFromCorrections, { agentId });
    expect(recorded.model).toEqual([]);
    expect((await agreementsOf(harness))[0]).toMatchObject({ status: 'proposed' });
    expect((await agreementsOf(harness))[0]?.approvedAt).toBeTypeOf('number');
  });

  it('refuses to keep one for every employee of an owner with more employees than the check reads, and says so (W13-R28)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    for (let index = 1; index <= EMPLOYEES_CHECKED; index += 1) {
      await seedEmployee(harness, { name: `Employee ${index}` });
    }
    const agreementId = await proposal(harness, agentId);
    await expect(
      harness.withIdentity(OWNER).mutation(api.workingAgreements.keep, {
        agreementId,
        agentId,
        forEveryEmployee: true,
        via: 'promotion-card',
      }),
    ).rejects.toMatchObject({ data: EVERY_EMPLOYEE_TOO_MANY });
    expect((await agreementsOf(harness))[0]).toMatchObject({ status: 'proposed' });
    expect((await agreementsOf(harness))[0]?.approvedAt).toBeUndefined();
  });

  it('refuses an edit of an every-employee agreement past the employees its check reads, as keep does (the code reader)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    for (let index = 1; index <= EMPLOYEES_CHECKED; index += 1) {
      await seedEmployee(harness, { name: `Employee ${index}` });
    }
    const agreementId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('workingAgreements', {
          userId: 'owner',
          kind: 'preference',
          statement: 'Name the vessel.',
          scope: 'global',
          sourceType: 'correction-promotion',
          status: 'active',
          approvedAt: 1,
          approvedVia: 'promotion-card',
          effectiveFrom: 1,
          createdAt: 1,
          appliedTo: [],
        }),
    );
    await expect(
      harness.withIdentity(OWNER).mutation(api.workingAgreements.edit, {
        agreementId,
        agentId,
        statement: 'Name the vessel and the carrier.',
      }),
    ).rejects.toMatchObject({ data: EVERY_EMPLOYEE_TOO_MANY });
    expect(await agreementsOf(harness)).toHaveLength(1);
  });

  it("refuses an employee's own agreement for every employee when another charter forbids it, and keeps it for its employee", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness, { willNotDo: ['change carrier contracts'] });
    await seedEmployee(harness, { name: 'Mateo' });
    const original = await harness.run(
      async (ctx) =>
        await ctx.db.insert('workingAgreements', {
          userId: 'owner',
          agentId,
          kind: 'preference',
          statement: EMAIL_YOURSELF,
          scope: 'global',
          sourceType: 'plan-approval',
          status: 'active',
          approvedAt: 1,
          approvedVia: 'plan-approval',
          effectiveFrom: 1,
          createdAt: 1,
          appliedTo: [],
        }),
    );

    await harness.withIdentity(OWNER).mutation(api.workingAgreements.keep, {
      agreementId: original,
      agentId,
      forEveryEmployee: true,
      via: 'agreements-card',
    });
    await drain(harness);

    const rows = await agreementsOf(harness);
    expect(rows.find((row) => row._id === original)?.status).toBe('active');
    expect(rows.find((row) => row._id !== original)).toMatchObject({
      status: 'refused',
      supersedes: original,
      refusal: { reason: 'contradicts-will-not-do', clause: 'email customers directly' },
    });
    expect(rows.find((row) => row._id !== original)?.agentId).toBeUndefined();
  });

  it('supersedes an edited agreement once the new words pass, and keeps the old one when they are refused', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const agreementId = await proposal(harness, agentId);
    const owner = harness.withIdentity(OWNER);
    await owner.mutation(api.workingAgreements.keep, {
      agreementId,
      agentId,
      forEveryEmployee: false,
      via: 'agreements-card',
    });
    await drain(harness);

    const { agreementId: edited } = await owner.mutation(api.workingAgreements.edit, {
      agreementId,
      agentId,
      statement: '  Comment on the ticket;   the account team emails.  ',
    });
    await drain(harness);
    let rows = await agreementsOf(harness);
    expect(rows.find((row) => row._id === agreementId)).toMatchObject({
      status: 'superseded',
      effectiveUntil: expect.any(Number),
    });
    expect(rows.find((row) => row._id === edited)).toMatchObject({
      status: 'active',
      statement: 'Comment on the ticket; the account team emails.',
      supersedes: agreementId,
    });

    const { agreementId: refused } = await owner.mutation(api.workingAgreements.edit, {
      agreementId: edited,
      agentId,
      statement: EMAIL_YOURSELF,
    });
    await drain(harness);
    rows = await agreementsOf(harness);
    expect(rows.find((row) => row._id === edited)?.status).toBe('active');
    expect(rows.find((row) => row._id === refused)?.status).toBe('refused');
  });

  it('retires an active agreement and sets a proposal aside', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const agreementId = await proposal(harness, agentId);
    const owner = harness.withIdentity(OWNER);
    await owner.mutation(api.workingAgreements.dismiss, { agreementId, agentId });
    expect((await agreementsOf(harness))[0]?.status).toBe('dismissed');
    await expect(
      owner.mutation(api.workingAgreements.keep, {
        agreementId,
        agentId,
        forEveryEmployee: false,
        via: 'promotion-card',
      }),
    ).rejects.toThrow('This working agreement has changed since this page loaded.');

    const active = await harness.run(
      async (ctx) =>
        await ctx.db.insert('workingAgreements', {
          userId: 'owner',
          agentId,
          kind: 'preference',
          statement: NO_EMAIL,
          scope: 'global',
          sourceType: 'plan-approval',
          status: 'active',
          effectiveFrom: 1,
          createdAt: 1,
          appliedTo: [],
        }),
    );
    await owner.mutation(api.workingAgreements.retire, { agreementId: active, agentId });
    expect((await agreementsOf(harness)).find((row) => row._id === active)).toMatchObject({
      status: 'retired',
      effectiveUntil: expect.any(Number),
    });
    expect((await eventsOf(harness, 'agreement.retired')).map((event) => event.payload)).toEqual([
      { agreementId, everyEmployee: false, how: 'dismissed' },
      { agreementId: active, everyEmployee: false, how: 'retired' },
    ]);
  });

  it("refuses another owner's agreement, and an employee's card for another employee's", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const mateo = await seedEmployee(harness, { name: 'Mateo' });
    const agreementId = await proposal(harness, agentId);
    await expect(
      harness.withIdentity(STRANGER).mutation(api.workingAgreements.retire, {
        agreementId,
        agentId,
      }),
    ).rejects.toThrow(AGREEMENT_NOT_YOURS);
    await expect(
      harness.withIdentity(OWNER).mutation(api.workingAgreements.dismiss, {
        agreementId,
        agentId: mateo,
      }),
    ).rejects.toThrow("This working agreement is not this employee's.");
  });
});

describe('a keep whose check is slow, doubled or overtaken (second pass)', (): void => {
  /** An active agreement of Priya's, kept long ago. */
  async function active(harness: Harness, agentId: Id<'agents'>): Promise<Id<'workingAgreements'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('workingAgreements', {
          userId: 'owner',
          agentId,
          kind: 'preference',
          statement: NO_EMAIL,
          scope: 'global',
          sourceType: 'plan-approval',
          status: 'active',
          approvedAt: 1,
          approvedVia: 'plan-approval',
          effectiveFrom: 1,
          createdAt: 1,
          appliedTo: [],
        }),
    );
  }

  it('checks a kept agreement again after each wait while the model is down, then takes effect', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const original = await active(harness, agentId);
    recorded.refusalDown = true;
    const { agreementId } = await harness.withIdentity(OWNER).mutation(api.workingAgreements.edit, {
      agreementId: original,
      agentId,
      statement: NO_EMAIL_AGAIN,
    });
    await drain(harness);
    expect((await agreementsOf(harness)).find((row) => row._id === agreementId)?.status).toBe(
      'proposed',
    );
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(30_000));
    expect(promptsOf('day0-agreement-refusal').length).toBeGreaterThanOrEqual(2);
    recorded.refusalDown = false;
    await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(600_000));
    const rows = await agreementsOf(harness);
    expect(rows.find((row) => row._id === agreementId)?.status).toBe('active');
    expect(rows.find((row) => row._id === original)?.status).toBe('superseded');
  });

  it("checks a kept agreement whose retries were spent at the employee's next stored plan", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const original = await active(harness, agentId);
    recorded.refusalDown = true;
    const { agreementId } = await harness.withIdentity(OWNER).mutation(api.workingAgreements.edit, {
      agreementId: original,
      agentId,
      statement: NO_EMAIL_AGAIN,
    });
    for (let wait = 0; wait < 6; wait += 1) {
      await harness.finishAllScheduledFunctions(() => vi.advanceTimersByTime(600_000));
    }
    expect((await agreementsOf(harness)).find((row) => row._id === agreementId)?.status).toBe(
      'proposed',
    );
    recorded.refusalDown = false;
    vi.advanceTimersByTime(60 * 60_000);
    await planApplying(harness, agentId, 'LOG-7', []);
    expect((await agreementsOf(harness)).find((row) => row._id === agreementId)?.status).toBe(
      'active',
    );
  });

  it('withdraws a kept agreement still waiting on its check, and a check that answers later changes nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const original = await active(harness, agentId);
    const owner = harness.withIdentity(OWNER);
    const { agreementId } = await owner.mutation(api.workingAgreements.edit, {
      agreementId: original,
      agentId,
      statement: NO_EMAIL_AGAIN,
    });
    await owner.mutation(api.workingAgreements.dismiss, { agreementId, agentId });
    await drain(harness);
    const rows = await agreementsOf(harness);
    expect(rows.find((row) => row._id === agreementId)?.status).toBe('dismissed');
    expect(rows.find((row) => row._id === original)?.status).toBe('active');
  });

  it('refuses a second change of an agreement while the first waits on its check', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const original = await active(harness, agentId);
    const owner = harness.withIdentity(OWNER);
    await owner.mutation(api.workingAgreements.edit, {
      agreementId: original,
      agentId,
      statement: NO_EMAIL_AGAIN,
    });
    await expect(
      owner.mutation(api.workingAgreements.edit, {
        agreementId: original,
        agentId,
        statement: 'A second change.',
      }),
    ).rejects.toThrow('This working agreement has a change waiting on its check.');
    await expect(
      owner.mutation(api.workingAgreements.keep, {
        agreementId: original,
        agentId,
        forEveryEmployee: true,
        via: 'agreements-card',
      }),
    ).rejects.toThrow('This working agreement has a change waiting on its check.');
  });

  it('does not bring back an agreement retired while its change waited on its check', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const original = await active(harness, agentId);
    const owner = harness.withIdentity(OWNER);
    const { agreementId } = await owner.mutation(api.workingAgreements.edit, {
      agreementId: original,
      agentId,
      statement: NO_EMAIL_AGAIN,
    });
    await owner.mutation(api.workingAgreements.retire, { agreementId: original, agentId });
    await drain(harness);
    const rows = await agreementsOf(harness);
    expect(rows.find((row) => row._id === original)?.status).toBe('retired');
    expect(rows.find((row) => row._id === agreementId)?.status).toBe('dismissed');
    expect(
      await harness.query(internal.workingAgreements.selectedForCandidate, {
        workItemId: await seedItem(harness, agentId, 'LOG-8', 'claimed'),
      }),
    ).toEqual([]);
  });

  it('keeps one agreement for the same note kept twice, and refuses an edit past the limit', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const owner = harness.withIdentity(OWNER);
    for (const externalId of ['LOG-1', 'LOG-2']) {
      const workItemId = await seedItem(harness, agentId, externalId, 'plan-pending');
      await owner.mutation(api.planApproval.approvePlan, {
        workItemId,
        note: 'Use the Delay notice B template.',
        keepNote: true,
      });
    }
    await drain(harness);
    expect(await agreementsOf(harness)).toHaveLength(1);
    const [kept] = await agreementsOf(harness);
    await expect(
      owner.mutation(api.workingAgreements.edit, {
        agreementId: kept!._id,
        agentId,
        statement: 'word '.repeat(120),
      }),
    ).rejects.toThrow('A working agreement keeps at most 500 characters.');
  });

  it('refuses a keep that claims the plan approval as its card', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await cancelWith(harness, agentId, 'LOG-1', NO_EMAIL);
    await cancelWith(harness, agentId, 'LOG-2', NO_EMAIL_AGAIN);
    const [proposal] = await agreementsOf(harness);
    await expect(
      harness.withIdentity(OWNER).mutation(api.workingAgreements.keep, {
        agreementId: proposal!._id,
        agentId,
        forEveryEmployee: false,
        via: 'plan-approval' as never,
      }),
    ).rejects.toThrow();
  });

  it('marks as judged only the corrections whose group was recorded or that grouped with none', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const item = await seedItem(harness, agentId, 'LOG-1', 'cancelled');
    const [c1, c2, c3] = await harness.run(async (ctx) => {
      const base = {
        agentId,
        workItemId: item,
        kind: 'plan-rejection' as const,
        itemTitle: 'Exception: LOG-1',
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        surfaces: ['linear'],
        createdAt: 1,
        appliedTo: [],
      };
      return await Promise.all(
        ['one', 'two', 'three'].map((text) => ctx.db.insert('corrections', { ...base, text })),
      );
    });
    await harness.mutation(internal.workingAgreements.recordProposals, {
      agentId,
      judged: [c1!, c2!, c3!],
      proposals: [
        { correctionIds: [c1!, c2!], statement: 'two' },
        { correctionIds: [c2!, c3!], statement: 'three' },
      ],
    });
    const rows = await correctionsOf(harness);
    expect(rows.find((row) => row._id === c3)?.agreementJudgedAt).toBeUndefined();
    expect(rows.find((row) => row._id === c1)?.agreementJudgedAt).toEqual(expect.any(Number));
    expect(await agreementsOf(harness)).toHaveLength(1);
  });
});

describe('selection for a candidate', (): void => {
  it('carries at most 8 rows and 2,000 characters, newest kept first, and never another owner', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await seedItem(harness, agentId, 'LOG-1', 'claimed');
    await harness.run(async (ctx) => {
      for (let at = 0; at < 12; at += 1) {
        await ctx.db.insert('workingAgreements', {
          userId: 'owner',
          ...(at % 2 === 0 ? { agentId } : {}),
          kind: 'preference',
          statement: `${'w'.repeat(240)} ${at}`,
          scope: 'global',
          sourceType: 'plan-approval',
          status: 'active',
          effectiveFrom: 100 + at,
          createdAt: 100 + at,
          appliedTo: [],
        });
      }
      // Another owner's every-employee row: the read leads with the owner scope.
      await ctx.db.insert('workingAgreements', {
        userId: 'stranger',
        kind: 'preference',
        statement: 'Another owner.',
        scope: 'global',
        sourceType: 'plan-approval',
        status: 'active',
        effectiveFrom: 999,
        createdAt: 999,
        appliedTo: [],
      });
    });
    const selected = await harness.query(internal.workingAgreements.selectedForCandidate, {
      workItemId,
    });
    expect(selected).toHaveLength(8);
    expect(selected.reduce((sum, row) => sum + row.statement.length, 0)).toBeLessThanOrEqual(2_000);
    expect(selected.map((row) => row.effectiveFrom)).toEqual([
      111, 110, 109, 108, 107, 106, 105, 104,
    ]);
    expect(selected.some((row) => row.userId !== 'owner')).toBe(false);
  });

  it('applies a person-scoped agreement through the confirmed person the requester or owner resolves to, and no other (13-J)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const [ana, dee] = await harness.run(async (ctx) => {
      const person = async (displayName: string, status: 'active' | 'dismissed') =>
        await ctx.db.insert('people', {
          userId: 'owner',
          displayName,
          nameKey: displayName.toLowerCase(),
          status,
          source: 'manager',
          evidence: [],
          createdAt: 1,
          updatedAt: 1,
        });
      return [await person('Ana Ruiz', 'active'), await person('Dee Dismissed', 'dismissed')];
    });
    await harness.run(async (ctx) => {
      for (const [personId, statement] of [
        [ana, 'Thank Ana Ruiz by name.'],
        [dee, 'Thank Dee by name.'],
      ] as const) {
        await ctx.db.insert('workingAgreements', {
          userId: 'owner',
          agentId,
          kind: 'preference',
          statement,
          scope: 'person',
          personId,
          sourceType: 'manager-card',
          status: 'active',
          effectiveFrom: 1,
          createdAt: 1,
          appliedTo: [],
        });
      }
    });
    let tickets = 0;
    const statementsFor = async (fields: Partial<Doc<'workItems'>>): Promise<string[]> => {
      tickets += 1;
      const workItemId = await seedItem(harness, agentId, `LOG-${tickets}`, 'claimed');
      await harness.run(async (ctx) => {
        await ctx.db.patch(workItemId, fields);
      });
      const selected = await harness.query(internal.workingAgreements.selectedForCandidate, {
        workItemId,
      });
      return selected.map((row) => row.statement);
    };

    expect(await statementsFor({ requesterPerson: { kind: 'person', personId: ana } })).toEqual([
      'Thank Ana Ruiz by name.',
    ]);
    expect(await statementsFor({ ownerPerson: { kind: 'person', personId: ana } })).toEqual([
      'Thank Ana Ruiz by name.',
    ]);
    expect(await statementsFor({ requesterPerson: { kind: 'person', personId: dee } })).toEqual([]);
    expect(await statementsFor({ requesterPerson: { kind: 'unknown' } })).toEqual([]);
    expect(await statementsFor({})).toEqual([]);
  });
});
