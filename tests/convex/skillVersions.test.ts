/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  copyVersionsForMove,
  deleteOwnerLibrary,
  holdersOf,
  LIBRARY_LOOKUP_LIMIT,
  ownerVersions,
  releaseAuthor,
  sharedSkillsOn,
  stampRecheckDue,
  stampRecheckDueOnSurfaces,
} from '../../convex/skillVersions';
import { openRevision } from '../../convex/skillControls';
import { versionBodyHash } from '../../src/work/skill-library';
import { allConvexModules } from './all-modules';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

afterEach((): void => {
  vi.unstubAllEnvs();
});

type Harness = TestConvex<typeof schema>;

const NAME = 'kanban-comment-and-close';
const BODY_ONE = '# Comment and close\n\nCall `save_comment` on <record-id>, then close it.';
const BODY_TWO =
  '# Comment and close\n\nCall `save_comment` on <record-id>; close it once it reads back.';
const SMOKE = 'CASES = [{"record-id": "A-1"}, {"record-id": "B-2"}]\ndef run(inputs): return {}';

/** An owned employee. */
async function employee(harness: Harness, name: string, owner = 'owner'): Promise<Id<'agents'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('agents', {
        bossEmail: owner === 'owner' ? MANAGER_ADDRESS : `${owner}@day0.local`,
        name,
        userId: owner,
        state: 'active',
        createdAt: 1,
      }),
  );
}

/**
 * A shaped, agent-authored skill held by an authoring run, as a claim leaves it: keyed on its
 * employee's owner, as every insert writes it (K-m3).
 */
async function claimedSkill(
  harness: Harness,
  agentId: Id<'agents'>,
  extra: Partial<Doc<'skills'>> = {},
): Promise<{ skillId: Id<'skills'>; runId: Id<'events'> }> {
  return await harness.run(async (ctx) => {
    const ownerKey = (await ctx.db.get(agentId))?.userId;
    const runId = await ctx.db.insert('events', {
      agentId,
      type: 'skill.authoring-claimed',
      payload: {},
      createdAt: 1,
    });
    const skillId = await ctx.db.insert('skills', {
      agentId,
      name: NAME,
      description: 'Ticket comment-and-close on a kanban surface.',
      body: '',
      sourceType: 'agent-authored',
      state: 'authoring',
      requiredScopes: ['linear:write'],
      targetSurface: 'linear',
      surfaceClass: 'kanban',
      operation: 'comment-and-close',
      authoringRunId: runId,
      authoringClaimedAt: 1,
      createdAt: 1,
      ...(ownerKey === undefined ? {} : { ownerKey }),
      ...extra,
    });
    return { skillId, runId };
  });
}

/** Register a claimed skill with a passing smoke test, or with none kept (`null`). */
async function register(
  harness: Harness,
  claimed: { skillId: Id<'skills'>; runId: Id<'events'> },
  body: string,
  smokeTest: string | null = SMOKE,
): Promise<void> {
  await expect(
    harness.mutation(internal.skills.completeRegistration, {
      ...claimed,
      body,
      verificationLog: 'ok: true',
      ...(smokeTest !== null ? { smokeTest } : {}),
      harnessTools: ['save_comment'],
    }),
  ).resolves.toEqual({ registered: true });
}

async function skill(harness: Harness, skillId: Id<'skills'>): Promise<Doc<'skills'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(skillId));
  if (row === null) throw new Error('skill missing');
  return row;
}

async function versionsOf(harness: Harness, owner = 'owner'): Promise<Doc<'skillVersions'>[]> {
  return await harness.run(
    async (ctx) =>
      await ctx.db
        .query('skillVersions')
        .withIndex('by_owner_name_version', (q) => q.eq('userId', owner).eq('name', NAME))
        .collect(),
  );
}

async function eventsOf(harness: Harness, type: string): Promise<Doc<'events'>[]> {
  return await harness.run(async (ctx) =>
    (await ctx.db.query('events').collect()).filter((event) => event.type === type),
  );
}

describe('skillVersions: registration writes the library', (): void => {
  it('registration writes version 1 for a new shape and version 2 for a revision of the same name', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const first = await claimedSkill(harness, priya);
    await register(harness, first, BODY_ONE);

    const [one] = await versionsOf(harness);
    expect(one).toMatchObject({
      userId: 'owner',
      version: 1,
      body: BODY_ONE,
      smokeTest: SMOKE,
      bodyHash: versionBodyHash(BODY_ONE, SMOKE),
      surfaceClass: 'kanban',
      operation: 'comment-and-close',
      requiredScopes: ['linear:write'],
      harnessTools: ['save_comment'],
      targetSurface: 'linear',
      authorAgentId: priya,
      authorName: 'Priya',
    });
    expect((await skill(harness, first.skillId)).versionId).toBe(one._id);

    const revision = await claimedSkill(harness, priya, {
      state: 'approved',
      revisionOf: first.skillId,
    });
    await register(harness, revision, BODY_TWO);

    const versions = await versionsOf(harness);
    expect(versions.map((row) => [row.version, row.body])).toEqual([
      [1, BODY_ONE],
      [2, BODY_TWO],
    ]);
    expect(versions[1].supersedes).toBe(one._id);
    expect(versions[0].supersededAt).toBeDefined();
    expect(await skill(harness, first.skillId)).toMatchObject({ state: 'superseded' });
    expect(await skill(harness, revision.skillId)).toMatchObject({
      state: 'registered',
      versionId: versions[1]._id,
    });
    const registered = await eventsOf(harness, 'skill.registered');
    expect(registered.map((event) => event.payload)).toEqual([
      { skillId: first.skillId, name: NAME, version: 1, versionId: one._id },
      {
        skillId: revision.skillId,
        name: NAME,
        version: 2,
        versionId: versions[1]._id,
        supersedes: { skillId: first.skillId, version: 1 },
      },
    ]);
  });

  it('stamps every other holder of an older version with the newer number, and keeps it running', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [priya, mateo] = [await employee(harness, 'Priya'), await employee(harness, 'Mateo')];
    const first = await claimedSkill(harness, priya);
    await register(harness, first, BODY_ONE);
    const second = await claimedSkill(harness, mateo);
    await register(harness, second, BODY_TWO);

    expect(await skill(harness, first.skillId)).toMatchObject({
      state: 'registered',
      body: BODY_ONE,
      recheckReason: 'v2 is verified; this runs v1',
    });
    expect((await skill(harness, first.skillId)).recheckDueAt).toBeDefined();
    expect((await skill(harness, second.skillId)).recheckDueAt).toBeUndefined();
    expect((await eventsOf(harness, 'skill.recheck-due')).map((event) => event.payload)).toEqual([
      {
        skillId: first.skillId,
        name: NAME,
        reason: 'v2 is verified; this runs v1',
        versionId: (await skill(harness, first.skillId)).versionId,
      },
    ]);
  });

  it('stamps no row of another owner that points at the older version (the wave 10 review K-m3)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [priya, mateo] = [await employee(harness, 'Priya'), await employee(harness, 'Mateo')];
    const first = await claimedSkill(harness, priya);
    await register(harness, first, BODY_ONE);
    const [one] = await versionsOf(harness);
    // No writer leaves a pointer across owners today; the boundary holds in the read itself.
    const stranger = await claimedSkill(harness, await employee(harness, 'Wren', 'colleague'), {
      state: 'registered',
      body: BODY_ONE,
      versionId: one._id,
    });

    await register(harness, await claimedSkill(harness, mateo), BODY_TWO);

    expect((await skill(harness, first.skillId)).recheckDueAt).toBeDefined();
    const unstamped = await skill(harness, stranger.skillId);
    expect([unstamped.recheckDueAt, unstamped.recheckReason]).toEqual([undefined, undefined]);
    expect(
      (await eventsOf(harness, 'skill.recheck-due')).map((event) => event.payload.skillId),
    ).toEqual([first.skillId]);
  });

  it('links a row that registers the version offered to it, as adopted, answers the offer and writes no copy', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [priya, mateo] = [await employee(harness, 'Priya'), await employee(harness, 'Mateo')];
    await register(harness, await claimedSkill(harness, priya), BODY_ONE);
    const [offered] = await versionsOf(harness);
    const adopter = await claimedSkill(harness, mateo, { offeredVersionId: offered._id });
    await register(harness, adopter, BODY_ONE);

    const versions = await versionsOf(harness);
    expect(versions).toHaveLength(1);
    const row = await skill(harness, adopter.skillId);
    expect(row.versionId).toBe(versions[0]._id);
    expect(row.adoptedAt).toBeDefined();
    expect(row.offeredVersionId).toBeUndefined();
    expect((await eventsOf(harness, 'skill.registered')).at(-1)?.payload).toMatchObject({
      version: 1,
      adopted: true,
    });
  });

  it('links an identical body another employee wrote on its own without calling it adopted', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [priya, mateo] = [await employee(harness, 'Priya'), await employee(harness, 'Mateo')];
    await register(harness, await claimedSkill(harness, priya), BODY_ONE);
    const independent = await claimedSkill(harness, mateo);
    await register(harness, independent, BODY_ONE);

    const row = await skill(harness, independent.skillId);
    expect(row.versionId).toBe((await versionsOf(harness))[0]._id);
    expect(row.adoptedAt).toBeUndefined();
    expect((await eventsOf(harness, 'skill.registered')).at(-1)?.payload).not.toHaveProperty(
      'adopted',
    );
  });

  it("records only the pages of the owner's own documentation a run read", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const [ours, theirs] = await harness.run(async (ctx) =>
      Promise.all(
        ['owner', 'previous'].map(
          async (userId) =>
            await ctx.db.insert('docSources', {
              userId,
              label: `${userId} runbooks`,
              kind: 'folder',
              locator: '.',
              status: 'synced',
              createdAt: 1,
              updatedAt: 1,
            }),
        ),
      ),
    );
    // A run that began before a handover read the previous owner's page.
    await harness.mutation(internal.skills.completeRegistration, {
      ...(await claimedSkill(harness, priya)),
      body: BODY_ONE,
      verificationLog: 'ok: true',
      smokeTest: SMOKE,
      readRefs: [
        { sourceId: ours, ref: 'linear.md', title: 'Linear runbook' },
        { sourceId: theirs, ref: 'old.md', title: 'Their runbook' },
      ],
    });

    expect((await versionsOf(harness))[0].readRefs).toEqual([
      { sourceId: ours, ref: 'linear.md', title: 'Linear runbook' },
    ]);
  });

  it('keeps the chip a trigger stamped while the passing check ran', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const held = await claimedSkill(harness, priya);
    await register(harness, held, BODY_ONE);
    const recheck = await harness.mutation(internal.skills.claimAuthoringRun, {
      skillId: held.skillId,
      purpose: 'verify-stored',
    });
    if (!recheck.claimed) throw new Error(recheck.reason);
    const claimedAt = (await skill(harness, held.skillId)).authoringClaimedAt!;
    await harness.run(
      async (ctx) =>
        await stampRecheckDue(ctx, {
          skillId: held.skillId,
          reason: 'the approved tools changed',
          now: claimedAt + 1,
        }),
    );

    await register(harness, { skillId: held.skillId, runId: recheck.runId }, BODY_ONE);

    expect(await skill(harness, held.skillId)).toMatchObject({
      state: 'registered',
      recheckReason: 'the approved tools changed',
    });
  });

  it('keeps the chip when a trigger fires during the check on a row already due', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const held = await claimedSkill(harness, priya);
    await register(harness, held, BODY_ONE);
    await harness.run(
      async (ctx) =>
        await stampRecheckDue(ctx, {
          skillId: held.skillId,
          reason: 'its check was not kept',
          now: 1,
        }),
    );
    const recheck = await harness.mutation(internal.skills.claimAuthoringRun, {
      skillId: held.skillId,
      purpose: 'verify-stored',
    });
    if (!recheck.claimed) throw new Error(recheck.reason);
    const claimedAt = (await skill(harness, held.skillId)).authoringClaimedAt!;
    await harness.run(
      async (ctx) =>
        await stampRecheckDue(ctx, {
          skillId: held.skillId,
          reason: 'the approved tools changed',
          now: claimedAt,
        }),
    );

    await register(harness, { skillId: held.skillId, runId: recheck.runId }, BODY_ONE);

    const after = await skill(harness, held.skillId);
    expect(after.recheckDueAt).toBe(claimedAt);
    expect(after.recheckReason).toBe('its check was not kept');
  });

  it('keeps an adopted row adopted when it moves onto a newer version another employee wrote', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [priya, mateo] = [await employee(harness, 'Priya'), await employee(harness, 'Mateo')];
    await register(harness, await claimedSkill(harness, priya), BODY_ONE);
    const [first] = await versionsOf(harness);
    const adopter = await claimedSkill(harness, mateo, { offeredVersionId: first._id });
    await register(harness, adopter, BODY_ONE);
    const revision = await claimedSkill(harness, priya, { name: NAME });
    await register(harness, revision, BODY_TWO);
    const newer = (await versionsOf(harness)).find((version) => version.version === 2)!;
    await harness.run(
      async (ctx) => await ctx.db.patch(adopter.skillId, { authoringRunId: adopter.runId }),
    );

    await register(harness, adopter, BODY_TWO);

    const row = await skill(harness, adopter.skillId);
    expect(row.versionId).toBe(newer._id);
    expect(row.adoptedAt).toBeDefined();
  });

  it('fences a re-check in flight out of the row its revision supersedes', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const original = await claimedSkill(harness, priya);
    await register(harness, original, BODY_ONE);
    const recheck = await harness.mutation(internal.skills.claimAuthoringRun, {
      skillId: original.skillId,
      purpose: 'verify-stored',
    });
    if (!recheck.claimed) throw new Error(recheck.reason);
    const revision = await claimedSkill(harness, priya, {
      state: 'approved',
      revisionOf: original.skillId,
    });
    await register(harness, revision, BODY_TWO);

    await expect(
      harness.mutation(internal.skills.completeRegistration, {
        skillId: original.skillId,
        runId: recheck.runId,
        body: BODY_ONE,
        verificationLog: 'ok: true',
        smokeTest: SMOKE,
      }),
    ).resolves.toEqual({ registered: false });
    await expect(
      harness.mutation(internal.skills.failAuthoringRun, {
        skillId: original.skillId,
        runId: recheck.runId,
        rowReason: 'failed',
        reason: 'failed',
        eventType: 'skill.verification-failed',
      }),
    ).resolves.toEqual({ recorded: false });
    expect(await skill(harness, original.skillId)).toMatchObject({ state: 'superseded' });
    expect((await skill(harness, original.skillId)).authoringRunId).toBeUndefined();
    expect(await skill(harness, revision.skillId)).toMatchObject({ state: 'registered' });
  });

  it('keeps a builtin, an unshaped row and an owner-less employee out of the library', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const owned = await employee(harness, 'Priya');
    const ownerless = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Legacy',
          state: 'active',
          createdAt: 1,
        }),
    );
    const unshaped = await claimedSkill(harness, owned, {
      name: 'linear-action-revops-7',
      surfaceClass: undefined,
      operation: undefined,
    });
    await register(harness, unshaped, BODY_ONE);
    const legacy = await claimedSkill(harness, ownerless);
    await register(harness, legacy, BODY_ONE);

    expect(await harness.run(async (ctx) => await ctx.db.query('skillVersions').collect())).toEqual(
      [],
    );
    expect((await skill(harness, unshaped.skillId)).versionId).toBeUndefined();
    expect((await eventsOf(harness, 'skill.registered')).map((event) => event.payload)).toEqual([
      { skillId: unshaped.skillId, name: 'linear-action-revops-7' },
      { skillId: legacy.skillId, name: NAME },
    ]);
  });
});

describe('skillVersions: lookups are the owner’s', (): void => {
  it("a lookup by shape never returns another owner's version", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const ours = await employee(harness, 'Priya', 'owner');
    const theirs = await employee(harness, 'Tomas', 'rival');
    await register(harness, await claimedSkill(harness, ours), BODY_ONE);
    await register(harness, await claimedSkill(harness, theirs), BODY_TWO);
    const shape = { agentId: ours, surfaceClass: 'kanban', operation: 'comment-and-close' };

    const mine = await harness
      .withIdentity(managerIdentity())
      .query(api.skillVersions.library, shape);
    const rival = await harness
      .withIdentity(managerIdentity('rival'))
      .query(api.skillVersions.library, { ...shape, agentId: theirs });

    expect(mine.map((entry) => [entry.userId, entry.body, entry.checkKept])).toEqual([
      ['owner', BODY_ONE, true],
    ]);
    expect(rival.map((entry) => [entry.userId, entry.body])).toEqual([['rival', BODY_TWO]]);
    expect(mine[0]).not.toHaveProperty('smokeTest');
    // The other owner cannot name this owner's employee to read its library.
    await expect(
      harness.withIdentity(managerIdentity('rival')).query(api.skillVersions.library, shape),
    ).rejects.toThrow('This employee is not yours.');
    // The helper itself answers only the owner it is given.
    const direct = await harness.run(
      async (ctx) =>
        await ownerVersions(ctx.db, 'rival', {
          by: 'shape',
          surfaceClass: 'kanban',
          operation: 'comment-and-close',
        }),
    );
    expect(direct.map((row) => row.userId)).toEqual(['rival']);
  });

  it('names a version’s holders among the owner’s employees, and the version offered to a proposal', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [priya, mateo] = [await employee(harness, 'Priya'), await employee(harness, 'Mateo')];
    const first = await claimedSkill(harness, priya);
    await register(harness, first, BODY_ONE);
    const adopter = await claimedSkill(harness, mateo);
    await register(harness, adopter, BODY_ONE);
    const [version] = await versionsOf(harness);
    const offeredRow = await harness.run(
      async (ctx) =>
        await ctx.db.insert('skills', {
          agentId: mateo,
          name: 'other',
          description: 'Proposed.',
          body: '',
          sourceType: 'agent-authored',
          state: 'proposed',
          offeredVersionId: version._id,
          createdAt: 1,
        }),
    );

    const read = await harness
      .withIdentity(managerIdentity())
      .query(api.skillVersions.forSkill, { skillId: first.skillId });
    expect(read.held?.version.version).toBe(1);
    expect(read.held?.holders.map((holder) => holder.agentName).sort()).toEqual(['Mateo', 'Priya']);
    const offered = await harness
      .withIdentity(managerIdentity())
      .query(api.skillVersions.forSkill, { skillId: offeredRow });
    expect(offered).toMatchObject({
      held: null,
      offered: { _id: version._id, authorName: 'Priya' },
    });
    await expect(
      harness
        .withIdentity(managerIdentity('rival'))
        .query(api.skillVersions.forSkill, { skillId: first.skillId }),
    ).rejects.toThrow('This skill is not yours.');
  });
});

describe('skillVersions: whose version an adopted skill runs (the real-Linear walk, m2)', (): void => {
  it('names the version and author of each adopted registered skill, to the owner only, and nothing for one the employee wrote', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [priya, mateo] = [await employee(harness, 'Priya'), await employee(harness, 'Mateo')];
    await register(harness, await claimedSkill(harness, priya), BODY_ONE);
    const [version] = await versionsOf(harness);
    const adopted = await claimedSkill(harness, mateo);
    await register(harness, adopted, BODY_ONE);
    await harness.run(async (ctx) => {
      await ctx.db.patch(adopted.skillId, { adoptedAt: 5, versionId: version._id });
      // A row pointing at another owner's version names nothing of it.
      const stray = await ctx.db.insert('skillVersions', {
        ...(await ctx.db.get(version._id))!,
        _id: undefined,
        _creationTime: undefined,
        userId: 'rival',
        authorName: 'Rival author',
      } as never);
      await ctx.db.insert('skills', {
        agentId: mateo,
        name: 'stray',
        description: 'Adopted from elsewhere.',
        body: BODY_ONE,
        sourceType: 'agent-authored',
        state: 'registered',
        adoptedAt: 6,
        versionId: stray,
        createdAt: 1,
      });
    });

    const asOwner = harness.withIdentity(managerIdentity());
    expect(await asOwner.query(api.skillVersions.adoptedSources, { agentId: mateo })).toEqual([
      { skillId: adopted.skillId, version: 1, authorName: 'Priya' },
    ]);
    expect(await asOwner.query(api.skillVersions.adoptedSources, { agentId: priya })).toEqual([]);
    await expect(
      harness
        .withIdentity(managerIdentity('rival'))
        .query(api.skillVersions.adoptedSources, { agentId: mateo }),
    ).rejects.toThrow('This employee is not yours.');
  });
});

describe('skillVersions: the re-check stamp', (): void => {
  it('stamps a registered row once, keeps the first reason, records every trigger, and leaves other states alone', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const held = await claimedSkill(harness, priya);
    await register(harness, held, BODY_ONE);
    const failed = await claimedSkill(harness, priya, { name: 'kanban-other', state: 'failed' });

    const results = await harness.run(async (ctx) => [
      await stampRecheckDue(ctx, {
        skillId: held.skillId,
        reason: 'its check was not kept',
        now: 10,
      }),
      await stampRecheckDue(ctx, {
        skillId: held.skillId,
        reason: 'the approved tools changed',
        now: 20,
      }),
      await stampRecheckDue(ctx, {
        skillId: failed.skillId,
        reason: 'the approved tools changed',
        now: 20,
      }),
    ]);

    expect(results).toEqual([true, false, false]);
    expect(await skill(harness, held.skillId)).toMatchObject({
      recheckDueAt: 10,
      recheckReason: 'its check was not kept',
    });
    expect((await skill(harness, failed.skillId)).recheckDueAt).toBeUndefined();
    expect(
      (await eventsOf(harness, 'skill.recheck-due')).map((event) => event.payload.reason),
    ).toEqual(['its check was not kept', 'the approved tools changed']);
  });

  it('is cleared only by a passing re-check, which keeps the smoke test a backfilled version lacked', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const held = await claimedSkill(harness, priya);
    await register(harness, held, BODY_ONE, null);
    const [unkept] = await versionsOf(harness);
    expect(unkept.smokeTest).toBeUndefined();
    await harness.run(async (ctx) => {
      await stampRecheckDue(ctx, {
        skillId: held.skillId,
        reason: 'its check was not kept',
        now: 10,
      });
      await ctx.db.patch(held.skillId, { authoringRunId: held.runId });
    });

    await register(harness, held, BODY_ONE, SMOKE);

    const [kept] = await versionsOf(harness);
    expect(kept).toMatchObject({
      _id: unkept._id,
      version: 1,
      smokeTest: SMOKE,
      bodyHash: versionBodyHash(BODY_ONE, SMOKE),
    });
    const row = await skill(harness, held.skillId);
    expect(row.recheckDueAt).toBeUndefined();
    expect(row.recheckReason).toBeUndefined();
    expect(row.versionId).toBe(unkept._id);
  });

  it('stamps an employee’s registered skills on the surfaces named, with each surface’s reason', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const onLinear = await claimedSkill(harness, priya);
    await register(harness, onLinear, BODY_ONE);
    const onSlack = await claimedSkill(harness, priya, {
      name: 'chat-thread-reply',
      targetSurface: 'slack',
      surfaceClass: 'chat',
      operation: 'thread-reply',
    });
    await register(harness, onSlack, BODY_TWO);

    const stamped = await harness.run(
      async (ctx) =>
        await stampRecheckDueOnSurfaces(ctx, {
          agentId: priya,
          slugs: ['linear'],
          reasonFor: (slug) => `cut ${slug}`,
          now: 30,
        }),
    );

    expect(stamped).toBe(1);
    expect((await skill(harness, onLinear.skillId)).recheckReason).toBe('cut linear');
    expect((await skill(harness, onSlack.skillId)).recheckDueAt).toBeUndefined();
  });
});

describe('skillVersions: an author leaving and an employee moving', (): void => {
  it('releases a retired author from its versions and keeps the name', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    await register(harness, await claimedSkill(harness, priya), BODY_ONE);

    expect(await harness.run(async (ctx) => await releaseAuthor(ctx, priya))).toBe(1);

    const [version] = await versionsOf(harness);
    expect(version.authorAgentId).toBeUndefined();
    expect(version.authorName).toBe('Priya');
  });

  it("deletes an owner's whole library past one batch, and only that owner's", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const deleted = await harness.run(async (ctx) => {
      for (const userId of ['owner', 'rival']) {
        const count = userId === 'owner' ? LIBRARY_LOOKUP_LIMIT + 1 : 1;
        for (let version = 1; version <= count; version += 1) {
          await ctx.db.insert('skillVersions', {
            userId,
            name: NAME,
            description: 'Ticket comment-and-close.',
            surfaceClass: 'kanban',
            operation: 'comment-and-close',
            version,
            body: BODY_ONE,
            bodyHash: `sha256:${version}`,
            requiredScopes: [],
            harnessTools: [],
            authorName: 'Priya',
            readRefs: [],
            verifiedAt: 1,
            createdAt: 1,
          });
        }
      }
      return await deleteOwnerLibrary(ctx, 'owner');
    });

    expect(deleted).toBe(LIBRARY_LOOKUP_LIMIT + 1);
    expect(await versionsOf(harness)).toEqual([]);
    expect(await versionsOf(harness, 'rival')).toHaveLength(1);
  });

  it("refuses a stored verification's registration once a move left its version behind", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [priya, mateo] = [await employee(harness, 'Priya'), await employee(harness, 'Mateo')];
    await register(harness, await claimedSkill(harness, priya), BODY_ONE);
    const [offered] = await versionsOf(harness);
    const adopting = await claimedSkill(harness, mateo, { offeredVersionId: offered._id });

    // The run verified the old owner's version; the employee is handed over before it lands.
    await harness.run(async (ctx) => await ctx.db.patch(mateo, { userId: 'lead' }));

    await expect(
      harness.mutation(internal.skills.completeRegistration, {
        ...adopting,
        body: BODY_ONE,
        verificationLog: 'ok: true',
        smokeTest: SMOKE,
        storedVersionId: offered._id,
      }),
    ).resolves.toEqual({
      registered: false,
      refusal: "the version is not one of this employee's owner's",
    });
    expect(await versionsOf(harness, 'lead')).toEqual([]);
    expect((await skill(harness, adopting.skillId)).versionId).toBeUndefined();
  });

  it("copies a mover's versions keyed on the new owner, drops the old owner's pages and offers, and stamps the cut", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [priya, mateo] = [await employee(harness, 'Priya'), await employee(harness, 'Mateo')];
    const sourceId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('docSources', {
          userId: 'owner',
          label: 'Runbooks',
          kind: 'folder',
          locator: '.',
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    const own = await claimedSkill(harness, mateo);
    await harness.mutation(internal.skills.completeRegistration, {
      ...own,
      body: BODY_ONE,
      verificationLog: 'ok: true',
      smokeTest: SMOKE,
      harnessTools: ['save_comment'],
      readRefs: [{ sourceId, ref: 'linear.md', title: 'Linear runbook' }],
    });
    // Mateo also holds a version Priya wrote, adopted.
    const authored = await claimedSkill(harness, priya, {
      name: 'chat-thread-reply',
      targetSurface: 'slack',
      surfaceClass: 'chat',
      operation: 'thread-reply',
    });
    await register(harness, authored, BODY_TWO);
    const adopted = await claimedSkill(harness, mateo, {
      name: 'chat-thread-reply',
      targetSurface: 'slack',
      surfaceClass: 'chat',
      operation: 'thread-reply',
    });
    await register(harness, adopted, BODY_TWO);
    const before = await harness.run(async (ctx) => await ctx.db.query('skillVersions').collect());

    const result = await harness.run(async (ctx) => {
      await ctx.db.patch(mateo, { userId: 'lead' });
      return await copyVersionsForMove(ctx, {
        agentId: mateo,
        toOwnerKey: 'lead',
        cutSlugs: ['linear'],
        now: 50,
      });
    });

    expect(result).toEqual({ copied: 2, stamped: 1 });
    const after = await harness.run(async (ctx) => await ctx.db.query('skillVersions').collect());
    const copies = after.filter((version) => version.userId === 'lead');
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(copy.readRefs).toEqual([]);
      expect(copy.authorAgentId === undefined || copy.authorAgentId === mateo).toBe(true);
    }
    const moved = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('skills')
          .withIndex('by_agent_name', (q) => q.eq('agentId', mateo))
          .collect(),
    );
    const copyIds = new Set(copies.map((copy) => copy._id));
    for (const row of moved) expect(copyIds.has(row.versionId!)).toBe(true);
    // The old owner's versions are untouched but for the mover's authorship.
    for (const version of before) {
      const now = after.find((row) => row._id === version._id)!;
      expect(now.userId).toBe('owner');
      expect(now.authorAgentId).toBe(
        version.authorAgentId === mateo ? undefined : version.authorAgentId,
      );
    }
    expect((await skill(harness, own.skillId)).recheckReason).toBe(
      'its connection to linear was cut when the employee was handed over',
    );
    expect((await skill(harness, adopted.skillId)).recheckDueAt).toBeUndefined();
  });
});

describe('skillVersions: the shared-skills switch (K4)', (): void => {
  it('reads the deployment flag on each call, on unless it says off', (): void => {
    vi.stubEnv('DAY0_SHARED_SKILLS', '');
    expect(sharedSkillsOn()).toBe(true);
    vi.stubEnv('DAY0_SHARED_SKILLS', 'false');
    expect(sharedSkillsOn()).toBe(false);
    vi.stubEnv('DAY0_SHARED_SKILLS', 'true');
    expect(sharedSkillsOn()).toBe(true);
  });
});

describe('skillVersions: the owner key on every holder row (K-m3, R-S)', (): void => {
  it("writes the employee's owner key on a row at a built-in install, a proposal and a revision", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const builtinId = await harness.mutation(internal.skills.installBuiltin, {
      agentId: priya,
      name: 'triage',
      description: 'Triage a ticket.',
      body: '# Triage',
    });
    const workItemId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('workItems', {
          agentId: priya,
          sourceCategory: 'ticket-queue',
          sourceSystem: 'linear',
          externalId: 'REVOPS-1',
          title: 'Add the close-summary audit note',
          contentSummary: 'Synthetic.',
          contentRefs: [],
          state: 'needs-skill',
          observedAt: 1,
          createdAt: 1,
        }),
    );
    const proposedId = await harness.mutation(internal.skills.propose, {
      agentId: priya,
      workItemId,
      name: 'audit-note',
      description: 'Add an audit note.',
      rationale: 'The work needs it.',
      requiredScopes: [],
    });
    const claimed = await claimedSkill(harness, priya);
    await register(harness, claimed, BODY_ONE);
    const revisionId = await harness.run(async (ctx) => {
      const current = await ctx.db.get(claimed.skillId);
      if (current === null) throw new Error('skill missing');
      return await openRevision(ctx, current);
    });

    for (const id of [builtinId, proposedId, revisionId]) {
      expect((await skill(harness, id)).ownerKey, id).toBe('owner');
    }
  });

  it("reads a version's holders by the owner key: a row keyed for another owner is not one, and a row not keyed yet is one only of the owner's employee", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const [priya, mateo] = [await employee(harness, 'Priya'), await employee(harness, 'Mateo')];
    const tomas = await employee(harness, 'Tomas', 'rival');
    const keyed = await claimedSkill(harness, priya, { ownerKey: 'owner' });
    await register(harness, keyed, BODY_ONE);
    const [version] = await versionsOf(harness);
    const rows = await harness.run(async (ctx) => {
      const holder = {
        name: NAME,
        description: 'Ticket comment-and-close on a kanban surface.',
        body: BODY_ONE,
        sourceType: 'agent-authored' as const,
        state: 'registered' as const,
        versionId: version._id,
        createdAt: 2,
      };
      return {
        // Written before the field: between the push and the skills-owner-key pass, a withdrawal
        // must still reach it (the second pass's M2).
        unkeyed: await ctx.db.insert('skills', { ...holder, agentId: mateo }),
        rivalUnkeyed: await ctx.db.insert('skills', { ...holder, agentId: tomas }),
        rival: await ctx.db.insert('skills', { ...holder, agentId: mateo, ownerKey: 'rival' }),
      };
    });

    const holders = await harness.run(async (ctx) => await holdersOf(ctx.db, version._id));

    expect(holders.map((row) => row._id).sort()).toEqual([keyed.skillId, rows.unkeyed].sort());
  });

  it('stamps the wait of an adoption the move sends back to a proposal (skills.waitingSince, wave 13 item 7)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const adopting = await claimedSkill(harness, priya, {
      name: 'adopting',
      state: 'approved',
      ownerKey: 'owner',
    });
    const offered = await harness.run(async (ctx) => {
      const versionId = await ctx.db.insert('skillVersions', {
        userId: 'owner',
        name: 'adopting',
        description: 'Ticket comment-and-close.',
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        version: 1,
        body: BODY_ONE,
        bodyHash: 'sha256:1',
        requiredScopes: [],
        harnessTools: [],
        authorName: 'Priya',
        readRefs: [],
        verifiedAt: 1,
        createdAt: 1,
      });
      await ctx.db.patch(adopting.skillId, { offeredVersionId: versionId });
      return versionId;
    });
    expect(await skill(harness, adopting.skillId)).toMatchObject({ offeredVersionId: offered });

    await harness.run(async (ctx) => {
      await copyVersionsForMove(ctx, { agentId: priya, toOwnerKey: 'lead', cutSlugs: [], now: 5 });
    });

    expect(await skill(harness, adopting.skillId)).toMatchObject({
      state: 'proposed',
      waitingSince: 5,
    });
  });

  it("rewrites every row of a moving employee to the new owner's key", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const claimed = await claimedSkill(harness, priya, { ownerKey: 'owner' });
    await register(harness, claimed, BODY_ONE);
    const proposed = await claimedSkill(harness, priya, {
      name: 'other',
      state: 'proposed',
      ownerKey: 'owner',
    });

    await harness.run(async (ctx) => {
      await copyVersionsForMove(ctx, { agentId: priya, toOwnerKey: 'lead', cutSlugs: [], now: 5 });
    });

    expect((await skill(harness, claimed.skillId)).ownerKey).toBe('lead');
    expect((await skill(harness, proposed.skillId)).ownerKey).toBe('lead');
    const [copied] = await versionsOf(harness, 'lead');
    const holders = await harness.run(async (ctx) => await holdersOf(ctx.db, copied!._id));
    expect(holders.map((row) => row._id)).toEqual([claimed.skillId]);
  });
});

describe('stampChangedPage (14-I)', (): void => {
  it('stamps every holder of a version that read the page, past one page of the library, and passes over a withdrawn version', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const agentId = await employee(harness, 'Priya');
    const { sourceId, holders } = await harness.run(async (ctx) => {
      await ctx.db.patch(agentId, { zone: 'Europe/London' });
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Handbook',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const version = async (name: string, readsPage: boolean, revokedAt?: number) =>
        await ctx.db.insert('skillVersions', {
          userId: 'owner',
          name,
          description: name,
          surfaceClass: 'kanban',
          operation: 'comment',
          version: 1,
          body: '# Body',
          bodyHash: 'b'.repeat(64),
          requiredScopes: [],
          harnessTools: [],
          authorName: 'Priya',
          readRefs: readsPage ? [{ sourceId, ref: 'runbook.md', title: 'Runbook' }] : [],
          verifiedAt: 1,
          createdAt: 1,
          ...(revokedAt !== undefined ? { revokedAt } : {}),
        });
      const holder = async (versionId: Id<'skillVersions'>, name: string) =>
        await ctx.db.insert('skills', {
          agentId,
          name,
          description: name,
          body: '# Body',
          sourceType: 'agent-authored',
          state: 'registered',
          versionId,
          ownerKey: 'owner',
          createdAt: 1,
        });
      // The first page of the library (100 versions) reads nothing; the reader sorts after it.
      for (let index = 0; index < 100; index += 1) {
        await version(`a-${String(index).padStart(3, '0')}`, false);
      }
      return {
        sourceId,
        holders: {
          reads: await holder(await version('z-reads', true), 'z-reads'),
          withdrawn: await holder(await version('z-withdrawn', true, 5), 'z-withdrawn'),
        },
      };
    });
    await harness.mutation(internal.skillVersions.stampChangedPage, {
      userId: 'owner',
      sourceId,
      ref: 'runbook.md',
      title: 'Runbook',
      changedAt: Date.UTC(2026, 9, 7, 23, 30),
      cursor: null,
    });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await skill(harness, holders.reads)).recheckReason).toBe(
      'its runbook "Runbook" changed on 8 October 2026',
    );
    expect((await skill(harness, holders.withdrawn)).recheckDueAt).toBeUndefined();
    vi.useRealTimers();
  });
});
