/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { CHECK_STALE_MS } from '../../src/work/agreement-vocabulary';
import { runThroughBody } from '../fixtures/run-through-charter-2026-09-14';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * RM32 (a), wave 17: a charter's refusal of an agreement for every employee is judged a second
 * time, and the agreement ends for everyone only when both judgements refuse.
 *
 * The input is 16-FX's F1, as its bed `day0-w16fx` met it on 12 October: two employees with the
 * same run-through charter body, Mateo established (1.0, then 1.1) and Ines on her first charter,
 * and the owner's agreement for every employee "Name the vessel in every customer comment.". The
 * hosted model allowed it against Mateo's charter and refused it, `widens-scope`, against Ines's,
 * and that one refusal ended the agreement for all fifty-one employees. The model is scripted at
 * its seam with the bed's two answers: each test says which judgement of Ines's charter gets which.
 */

const STATEMENT = 'Name the vessel in every customer comment.';

const recorded = vi.hoisted(() => ({
  model: [] as Array<{ agent: string; user: string }>,
  /** The verdicts the refusal judgement answers, in the order it is asked; `keep` once spent. */
  verdicts: [] as Array<'keep' | 'widens-scope' | 'contradicts-will-not-do' | 'down'>,
}));

vi.mock('../../src/lib/mastra', async () => {
  const { schemaChecked: checked } = await import('./fakes/mastra');
  return {
    MODEL_CONFIG: 'openai/mock',
    MODEL_PROVIDER_MAX_RETRIES: 2,
    makeAgent: (name: string): { name: string } => ({ name }),
    agentJson: checked((call) => {
      recorded.model.push({ agent: call.agent.name, user: call.user });
      if (call.agent.name !== 'day0-agreement-refusal') {
        throw new Error(`unscripted agent ${call.agent.name}`);
      }
      const verdict = recorded.verdicts.shift() ?? 'keep';
      if (verdict === 'down') throw new Error('model down');
      return { verdict, clause: verdict === 'contradicts-will-not-do' ? 1 : null };
    }),
    agentText: async (): Promise<string> => '',
  };
});

type Harness = TestConvex<typeof schema>;
const OWNER = managerIdentity();

beforeEach((): void => {
  useSurfaceMode('real');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T02:36:00Z'));
});

afterEach((): void => {
  recorded.model.length = 0;
  recorded.verdicts.length = 0;
  vi.useRealTimers();
  restoreSurfaceMode();
});

/** Rounds of scheduled work a drain runs before it calls the chain endless. */
const DRAIN_ROUND_LIMIT = 50;

/** Run every scheduled job that is due, and every job those schedule. */
async function drain(harness: Harness): Promise<void> {
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

/** An employee of the owner with the run-through charter approved in each version named. */
async function seedEmployee(
  harness: Harness,
  name: string,
  versions: readonly string[],
): Promise<Id<'agents'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name,
      userId: 'owner',
      state: 'active',
      autonomousActions: false,
      createdAt: 1,
    });
    for (const [at, version] of versions.entries()) {
      await ctx.db.insert('charters', {
        agentId,
        version,
        approved: true,
        approvedAt: at + 1,
        createdAt: at + 1,
        body: runThroughBody(),
      });
    }
    return agentId;
  });
}

/** F1's office: Mateo established, Ines on her first charter, the agreement for every employee. */
async function f1Office(harness: Harness): Promise<{
  mateo: Id<'agents'>;
  ines: Id<'agents'>;
  agreementId: Id<'workingAgreements'>;
}> {
  const mateo = await seedEmployee(harness, 'Mateo', ['1.0', '1.1']);
  const ines = await seedEmployee(harness, 'Ines', ['1.0']);
  const agreementId = await harness.run(
    async (ctx) =>
      await ctx.db.insert('workingAgreements', {
        userId: 'owner',
        kind: 'preference',
        statement: STATEMENT,
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
  return { mateo, ines, agreementId };
}

async function agreementsOf(harness: Harness): Promise<Doc<'workingAgreements'>[]> {
  return await harness.run(async (ctx) => await ctx.db.query('workingAgreements').collect());
}

async function eventsOf(harness: Harness, type: string): Promise<Doc<'events'>[]> {
  return (await harness.run(async (ctx) => await ctx.db.query('events').collect())).filter(
    (event) => event.type === type,
  );
}

/** The agreements an employee's planner reads for a new candidate. */
async function plannerReads(
  harness: Harness,
  agentId: Id<'agents'>,
  externalId: string,
): Promise<string[]> {
  const workItemId = await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId,
        title: `Exception: ${externalId}`,
        contentSummary: 'Notify the customer.',
        contentRefs: [],
        state: 'claimed',
        verdict: { decision: 'claim', value: 60, risk: 20, requiredPermissions: [] },
        observedAt: 1,
        createdAt: 1,
      }),
  );
  return (await harness.query(internal.workingAgreements.selectedForCandidate, { workItemId })).map(
    (row) => row._id,
  );
}

/**
 * The check of an employee's charter against the owner's agreements, as its approval schedules
 * it.
 */
async function checkCharter(harness: Harness, agentId: Id<'agents'>): Promise<void> {
  await harness.action(internal.workingAgreementActions.checkForCharter, { agentId, attempt: 0 });
  await drain(harness);
}

/** The hold of the agreement on the employee's card, as the Agreements card reads it. */
async function holdOnCard(
  harness: Harness,
  agentId: Id<'agents'>,
  agreementId: Id<'workingAgreements'>,
): Promise<{ _id: Id<'workingAgreements'>; refusal?: unknown } | undefined> {
  const holdId = (await agreementsOf(harness)).find(
    (row) => row.supersedes === agreementId && row.status === 'refused',
  )?._id;
  return (
    await harness.withIdentity(OWNER).query(api.workingAgreements.listForAgent, { agentId })
  ).find((row) => row._id === holdId);
}

describe('a charter’s refusal of an agreement for every employee, judged twice (RM32 (a); 16-FX’s F1)', (): void => {
  it('keeps the agreement in effect for every other employee when a first charter’s refusal is not repeated by the second judgement, and holds it for that employee, saying so', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { mateo, ines, agreementId } = await f1Office(harness);
    // The bed's two answers for the one statement against the one charter body.
    recorded.verdicts.push('widens-scope', 'keep');
    await checkCharter(harness, ines);

    const prompts = recorded.model.map((call) => call.user);
    expect(prompts).toHaveLength(2);
    // D-8 (a): the second judgement reads the charter's clauses in reverse order.
    expect(prompts[1]).not.toBe(prompts[0]);
    expect(prompts[0]).toContain(`--- Statement ---\n${STATEMENT}`);
    expect(prompts[1]).toContain(`--- Statement ---\n${STATEMENT}`);

    const rows = await agreementsOf(harness);
    expect(rows.find((row) => row._id === agreementId)).toMatchObject({ status: 'active' });
    expect(await plannerReads(harness, mateo, 'LOG-1')).toEqual([agreementId]);
    expect(await plannerReads(harness, ines, 'LOG-2')).toEqual([]);

    const hold = rows.find((row) => row.supersedes === agreementId);
    expect(hold).toMatchObject({
      agentId: ines,
      status: 'refused',
      statement: STATEMENT,
      refusal: { reason: 'unchecked-for-employee', judgedAt: Date.now() },
    });
    expect((await eventsOf(harness, 'agreement.refused')).map((event) => event.payload)).toEqual([
      {
        agreementId,
        everyEmployee: true,
        reason: 'unchecked-for-employee',
        holdId: hold?._id,
        refusedOnce: { reason: 'widens-scope' },
      },
    ]);
    expect((await holdOnCard(harness, ines, agreementId))?.refusal).toEqual({
      reason: 'unchecked-for-employee',
      checkable: true,
      refusedOnce: { reason: 'widens-scope' },
    });
  });

  it('ends the agreement for every employee when both judgements of a first charter refuse it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { mateo, ines, agreementId } = await f1Office(harness);
    recorded.verdicts.push('widens-scope', 'widens-scope');
    await checkCharter(harness, ines);

    expect(recorded.model).toHaveLength(2);
    const rows = await agreementsOf(harness);
    expect(rows.find((row) => row._id === agreementId)).toMatchObject({
      status: 'refused',
      refusal: { reason: 'widens-scope' },
    });
    expect(rows.filter((row) => row.supersedes === agreementId)).toEqual([]);
    expect(await plannerReads(harness, mateo, 'LOG-1')).toEqual([]);
    expect((await eventsOf(harness, 'agreement.refused')).map((event) => event.payload)).toEqual([
      { agreementId, everyEmployee: true, reason: 'widens-scope' },
    ]);
  });

  it('asks once, and holds nothing, for a charter the first judgement allows the agreement against', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { mateo, agreementId } = await f1Office(harness);
    await checkCharter(harness, mateo);
    expect(recorded.model).toHaveLength(1);
    expect(await agreementsOf(harness)).toHaveLength(1);
    expect(await plannerReads(harness, mateo, 'LOG-1')).toEqual([agreementId]);
  });

  it('judges an amended charter’s refusal twice too: one refusal of two holds it for that employee and ends nothing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { mateo, ines, agreementId } = await f1Office(harness);
    recorded.verdicts.push('contradicts-will-not-do', 'keep');
    await checkCharter(harness, mateo);

    expect(recorded.model).toHaveLength(2);
    expect((await agreementsOf(harness)).find((row) => row._id === agreementId)?.status).toBe(
      'active',
    );
    expect(await plannerReads(harness, mateo, 'LOG-1')).toEqual([]);
    expect(await plannerReads(harness, ines, 'LOG-2')).toEqual([agreementId]);
    expect((await holdOnCard(harness, mateo, agreementId))?.refusal).toEqual({
      reason: 'unchecked-for-employee',
      checkable: true,
      refusedOnce: {
        reason: 'contradicts-will-not-do',
        clause: 'Post to public Slack channels.',
      },
    });
  });

  it('tries the check again, settling nothing, when the second judgement cannot be had', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { ines, agreementId } = await f1Office(harness);
    recorded.verdicts.push('widens-scope', 'down');
    await checkCharter(harness, ines);

    const rows = await agreementsOf(harness);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ _id: agreementId, status: 'active' });
    const retries = await harness.run(
      async (ctx) =>
        (await ctx.db.system.query('_scheduled_functions').collect()).filter(
          (job) =>
            job.state.kind === 'pending' && job.name === 'workingAgreementActions:checkForCharter',
        ).length,
    );
    expect(retries).toBe(1);
  });

  it('keeps a disputed hold for the manager: the sweep and a stored plan do not judge it again, and Check now does', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { mateo, ines, agreementId } = await f1Office(harness);
    recorded.verdicts.push('widens-scope', 'keep');
    await checkCharter(harness, ines);
    recorded.model.length = 0;

    // Past the stale window, where a hold no check could be had for is checked again by itself.
    vi.setSystemTime(Date.now() + CHECK_STALE_MS + 60_000);
    const scheduled = await harness.run(async (ctx) => {
      const { scheduleDueHoldChecks } = await import('../../convex/workingAgreements');
      return await scheduleDueHoldChecks(ctx, ines, Date.now());
    });
    await drain(harness);
    expect(scheduled).toBe(0);
    expect(recorded.model).toEqual([]);

    // Check now: both judgements refuse this time, and only then does it end for everyone.
    const hold = await holdOnCard(harness, ines, agreementId);
    if (!hold) throw new Error('no hold on the card');
    recorded.verdicts.push('widens-scope', 'widens-scope');
    await harness
      .withIdentity(OWNER)
      .mutation(api.workingAgreements.recheck, { agreementId: hold._id, agentId: ines });
    await drain(harness);
    expect(recorded.model).toHaveLength(2);
    const rows = await agreementsOf(harness);
    expect(rows.find((row) => row._id === agreementId)).toMatchObject({
      status: 'refused',
      refusal: { reason: 'widens-scope' },
    });
    expect(rows.find((row) => row._id === hold._id)?.status).toBe('dismissed');
    expect(await plannerReads(harness, mateo, 'LOG-1')).toEqual([]);
  });

  it('stamps a disputed hold the sweep passes over, so it is not stale again until the next window, and judges nothing (the second pass)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { ines, agreementId } = await f1Office(harness);
    recorded.verdicts.push('widens-scope', 'keep');
    await checkCharter(harness, ines);
    vi.setSystemTime(Date.now() + CHECK_STALE_MS + 60_000);
    const sweep = async (): Promise<number> =>
      await harness.run(async (ctx) => {
        const { scheduleDueHoldChecks } = await import('../../convex/workingAgreements');
        return await scheduleDueHoldChecks(ctx, ines, Date.now());
      });
    expect(await sweep()).toBe(0);
    // Passed over now: not stale again until the next window, so the next pass reads no events.
    const hold = (await agreementsOf(harness)).find((row) => row.supersedes === agreementId);
    expect(hold?.refusal?.judgedAt).toBe(Date.now());
    expect((await holdOnCard(harness, ines, agreementId))?.refusal).toMatchObject({
      refusedOnce: { reason: 'widens-scope' },
    });
    expect(await sweep()).toBe(0);
    expect(recorded.model).toHaveLength(2);
  });

  it('judges a disputed hold again when the manager resumes the employee, as it does every agreement the pause held (the second pass: said, not guarded)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { ines, agreementId } = await f1Office(harness);
    recorded.verdicts.push('widens-scope', 'keep');
    await checkCharter(harness, ines);
    recorded.model.length = 0;
    recorded.verdicts.push('widens-scope', 'keep');
    await harness.run(async (ctx) => {
      const { scheduleHeldChecks } = await import('../../convex/workingAgreements');
      await scheduleHeldChecks(ctx, ines);
    });
    await drain(harness);
    // Judged twice again, disputed again: still held, still in effect for everyone else.
    expect(recorded.model).toHaveLength(2);
    const rows = await agreementsOf(harness);
    expect(rows.find((row) => row._id === agreementId)?.status).toBe('active');
    expect(
      rows.filter((row) => row.supersedes === agreementId && row.status === 'refused'),
    ).toHaveLength(1);
  });

  it('lifts a disputed hold when Check now’s first judgement allows the agreement', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { ines, agreementId } = await f1Office(harness);
    recorded.verdicts.push('widens-scope', 'keep');
    await checkCharter(harness, ines);
    const hold = await holdOnCard(harness, ines, agreementId);
    if (!hold) throw new Error('no hold on the card');
    recorded.model.length = 0;
    await harness
      .withIdentity(OWNER)
      .mutation(api.workingAgreements.recheck, { agreementId: hold._id, agentId: ines });
    await drain(harness);
    expect(recorded.model).toHaveLength(1);
    expect((await agreementsOf(harness)).find((row) => row._id === hold._id)?.status).toBe(
      'dismissed',
    );
    expect(await plannerReads(harness, ines, 'LOG-2')).toEqual([agreementId]);
  });

  it('ends an owed check too when the judgement that lifts a disputed hold of an established employee allows the agreement', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { mateo, agreementId } = await f1Office(harness);
    const owner = harness.withIdentity(OWNER);
    // The amended charter's check could not be had after its last retry: owed (RM28 (b)).
    recorded.verdicts.push('down');
    await harness.action(internal.workingAgreementActions.checkForCharter, {
      agentId: mateo,
      attempt: 3,
    });
    await drain(harness);
    expect(await eventsOf(harness, 'agreement.check-owed')).toHaveLength(1);
    // Check now on the owed check: the two judgements disagree, so it is held for Mateo.
    recorded.verdicts.push('widens-scope', 'keep');
    await owner.mutation(api.workingAgreements.recheck, { agreementId, agentId: mateo });
    await drain(harness);
    const hold = await holdOnCard(harness, mateo, agreementId);
    if (!hold) throw new Error('no hold on the card');
    // Check now on the hold: allowed. In effect for Mateo again, and nothing is owed.
    await owner.mutation(api.workingAgreements.recheck, { agreementId: hold._id, agentId: mateo });
    await drain(harness);
    expect(await eventsOf(harness, 'agreement.checked')).toHaveLength(1);
    const listed = await owner.query(api.workingAgreements.listForAgent, { agentId: mateo });
    expect(listed.map((row) => [row._id, row.status, row.checkOwed])).toEqual([
      [agreementId, 'active', undefined],
    ]);
  });

  it('records a second disputed check on the hold that already stands, once, with the newer refusal on the card', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { ines, agreementId } = await f1Office(harness);
    recorded.verdicts.push('widens-scope', 'keep');
    await checkCharter(harness, ines);
    const hold = await holdOnCard(harness, ines, agreementId);
    if (!hold) throw new Error('no hold on the card');
    vi.setSystemTime(Date.now() + 60_000);
    recorded.verdicts.push('contradicts-will-not-do', 'keep');
    await harness
      .withIdentity(OWNER)
      .mutation(api.workingAgreements.recheck, { agreementId: hold._id, agentId: ines });
    await drain(harness);

    const holds = (await agreementsOf(harness)).filter((row) => row.supersedes === agreementId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      _id: hold._id,
      status: 'refused',
      refusal: { reason: 'unchecked-for-employee', judgedAt: Date.now() },
    });
    expect((await holdOnCard(harness, ines, agreementId))?.refusal).toEqual({
      reason: 'unchecked-for-employee',
      checkable: true,
      refusedOnce: {
        reason: 'contradicts-will-not-do',
        clause: 'Post to public Slack channels.',
      },
    });
  });
});
