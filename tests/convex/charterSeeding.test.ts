import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { CHARTER_SEEDING_ATTEMPTS, SEEDING_DID_NOT_FINISH } from '../../src/agent/charter-seeding';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/*
 * The seeding of an approved charter that did not finish (wave 13, 12-J item 6, options B and C):
 * the check past the platform's limit records an attempt the platform ended, and the empty Work
 * tab reads how the seeding stands and finds work again on the manager's word.
 */

type Harness = TestConvex<typeof schema>;

afterEach((): void => {
  restoreSurfaceMode();
});

/** Nola, with an approved charter. */
async function seed(
  harness: Harness,
): Promise<{ agentId: Id<'agents'>; charterId: Id<'charters'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Nola',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const charterId = await ctx.db.insert('charters', {
      agentId,
      version: 'v1',
      approved: true,
      approvedAt: 1,
      createdAt: 1,
      body: { proposedFunction: 'Pipeline hygiene.' },
    });
    return { agentId, charterId };
  });
}

async function failures(harness: Harness): Promise<unknown[]> {
  return (await harness.run(async (ctx) => await ctx.db.query('events').collect()))
    .filter((event) => event.type === 'charter.seeding-failed')
    .map((event) => event.payload);
}

async function scheduled(harness: Harness): Promise<Array<{ name: string; args: unknown }>> {
  return (
    await harness.run(async (ctx) => await ctx.db.system.query('_scheduled_functions').collect())
  )
    .filter((job) => job.state.kind === 'pending')
    .map((job) => ({ name: job.name, args: job.args[0] }));
}

describe('the check of a seeding attempt past the limit (option B)', (): void => {
  it('records an attempt the platform ended and schedules the next', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seed(harness);
    await expect(
      harness.mutation(internal.charterSeeding.checkAttempt, {
        agentId,
        charterId,
        attempt: 1,
        startedAt: 1,
      }),
    ).resolves.toBe('recorded');
    expect(await failures(harness)).toEqual([
      { charterId, attempt: 1, reason: SEEDING_DID_NOT_FINISH, retrying: true },
    ]);
    expect(await scheduled(harness)).toEqual([
      { name: 'onboarding:postCharterApproval', args: { agentId, charterId, attempt: 2 } },
    ]);
  });

  it('says why the last attempt died and stops trying', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seed(harness);
    await harness.mutation(internal.charterSeeding.checkAttempt, {
      agentId,
      charterId,
      attempt: CHARTER_SEEDING_ATTEMPTS,
      startedAt: 1,
    });
    expect(await failures(harness)).toEqual([
      {
        charterId,
        attempt: CHARTER_SEEDING_ATTEMPTS,
        reason: SEEDING_DID_NOT_FINISH,
        retrying: false,
      },
    ]);
    expect(await scheduled(harness)).toEqual([]);
  });

  it('leaves a charter that is no longer the approved latest alone', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seed(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('charters', {
        agentId,
        version: 'v2',
        approved: false,
        createdAt: 2,
        body: { proposedFunction: 'Pipeline hygiene, amended.' },
      });
    });
    await expect(
      harness.mutation(internal.charterSeeding.checkAttempt, {
        agentId,
        charterId,
        attempt: 1,
        startedAt: 1,
      }),
    ).resolves.toBe('superseded');
    expect(await failures(harness)).toEqual([]);
  });
});

describe('the empty Work tab’s seeding standing and Find work again (option C)', (): void => {
  it('tells the Work tab how the seeding stands, and finds work again once, on the manager’s word', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seed(harness);
    const manager = harness.withIdentity(managerIdentity());
    expect(await manager.query(api.charterSeeding.standing, { agentId })).toBeNull();
    await expect(manager.mutation(api.charterSeeding.findWorkAgain, { agentId })).rejects.toThrow(
      "No seeding of Nola's charter failed: there is nothing to try again.",
    );
    await harness.mutation(internal.charterSeeding.checkAttempt, {
      agentId,
      charterId,
      attempt: 1,
      startedAt: 1,
    });
    expect(await manager.query(api.charterSeeding.standing, { agentId })).toEqual({
      state: 'retrying',
      reason: SEEDING_DID_NOT_FINISH,
      line: `Finding work for Nola did not finish: ${SEEDING_DID_NOT_FINISH}. Day0 tries again shortly.`,
    });
    await expect(manager.mutation(api.charterSeeding.findWorkAgain, { agentId })).rejects.toThrow(
      'Day0 is still finding work for Nola.',
    );
    await harness.mutation(internal.charterSeeding.checkAttempt, {
      agentId,
      charterId,
      attempt: CHARTER_SEEDING_ATTEMPTS,
      startedAt: 1,
    });
    expect(await manager.query(api.charterSeeding.standing, { agentId })).toEqual({
      state: 'stopped',
      reason: SEEDING_DID_NOT_FINISH,
      line: `Day0 could not find work for Nola: ${SEEDING_DID_NOT_FINISH}.`,
    });
    await manager.mutation(api.charterSeeding.findWorkAgain, { agentId });
    expect(await manager.query(api.charterSeeding.standing, { agentId })).toEqual({
      state: 'finding',
      line: 'Day0 is finding work for Nola again. It appears here as it is found.',
    });
    // Beside the retry the first check scheduled, the press schedules a first attempt afresh.
    expect(await scheduled(harness)).toContainEqual({
      name: 'onboarding:postCharterApproval',
      args: { agentId, charterId, attempt: 1 },
    });
    await expect(manager.mutation(api.charterSeeding.findWorkAgain, { agentId })).rejects.toThrow(
      'Day0 is still finding work for Nola.',
    );
  });

  it('refuses another owner’s employee', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId } = await seed(harness);
    const stranger = harness.withIdentity({
      ...managerIdentity(),
      subject: 'dev-no-auth|someone-else',
      email: 'someone@acme.test',
    });
    await expect(stranger.query(api.charterSeeding.standing, { agentId })).rejects.toThrow();
    await expect(
      stranger.mutation(api.charterSeeding.findWorkAgain, { agentId }),
    ).rejects.toThrow();
  });
});
