/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { SkillSandboxRun } from '../../src/lib/skill-sandbox';
import { versionBodyHash } from '../../src/work/skill-library';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { acceptedHandoverWords, seedAcceptingHandover } from './fakes/accepting-handover';

/**
 * `skillAdoption`: a sibling's verified skill offered at `needs-skill`, adopted with one approval
 * and verified again under the adopter's own contract before it runs (A3, 10-A).
 */

const recorded = vi.hoisted(() => ({
  sandboxRuns: [] as Array<{ skillBody: string; smokeTest: string }>,
  sandbox: undefined as SkillSandboxRun | undefined,
}));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/lib/skill-sandbox', () => ({
  configuredSkillSandboxBackend: (): string => 'local',
  authorAndVerifySkill: async (args: {
    skillBody: string;
    smokeTest: string;
  }): Promise<SkillSandboxRun> => {
    recorded.sandboxRuns.push({ skillBody: args.skillBody, smokeTest: args.smokeTest });
    if (!recorded.sandbox) throw new Error('no sandbox result queued');
    return recorded.sandbox;
  },
}));

type Harness = TestConvex<typeof schema>;

const OWNER = managerIdentity();
const NAME = 'kanban-comment-and-close';

const BODY = [
  '# Ticket comment-and-close',
  '## When to invoke',
  'A ticket asks to be closed once its work is done.',
  '## Inputs',
  '- `<record-id>`: the ticket identifier from the candidate id.',
  '## Procedure',
  'Call `save_comment` on `<record-id>` that the work is done, then `update_issue` to close it.',
  '## Verification',
  'The ticket reads closed.',
].join('\n');

const SMOKE = [
  'def run(inputs: dict) -> dict:',
  '    return {"actions": [{"tool": "save_comment", "args": {"id": inputs["record_id"]}}]}',
  'for case in ({"record_id": "OPS-3"}, {"record_id": "OPS-9"}):',
  '    print("ok", run(case)["actions"][0]["args"]["id"])',
].join('\n');

const PASSED: SkillSandboxRun = {
  backend: 'local',
  sandboxId: 'local:adopt-1',
  stdout: 'ok OPS-3\nok OPS-9\n',
  stderr: '',
  ok: true,
  skipped: false,
};

const SKIPPED: SkillSandboxRun = {
  backend: 'local',
  sandboxId: '',
  stdout: '',
  stderr: '',
  ok: false,
  skipped: true,
  skipReason: 'no sandbox backend answered',
};

const FAILED: SkillSandboxRun = {
  backend: 'local',
  sandboxId: 'local:adopt-2',
  stdout: '',
  stderr: 'Traceback: KeyError record_id',
  ok: false,
  skipped: false,
  failureReason: 'smoke.py exited 1',
};

/** An employee of an owner, with an approved charter naming the given systems' classes. */
async function employee(
  harness: Harness,
  name: string,
  options: { readonly owner?: string; readonly charterClasses?: readonly string[] } = {},
): Promise<Id<'agents'>> {
  const owner = options.owner ?? 'owner';
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: owner === 'owner' ? MANAGER_ADDRESS : `${owner}@day0.local`,
      name,
      userId: owner,
      state: 'active',
      createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId,
      version: '0.1',
      body: {
        namedSystems: (options.charterClasses ?? ['kanban']).map((systemClass) => ({
          name: systemClass === 'kanban' ? 'Linear' : 'Slack',
          class: systemClass,
          whereMentioned: 'the one-to-one',
        })),
      },
      approved: true,
      approvedAt: 1,
      createdAt: 1,
    });
    return agentId;
  });
}

/** A connected Linear surface of an employee, with the tools the manager approved on it. */
async function linear(
  harness: Harness,
  agentId: Id<'agents'>,
  surface: Partial<Doc<'surfaces'>> = {},
): Promise<void> {
  await harness.run(async (ctx) => {
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'connected',
      whereFound: [],
      endpoint: 'https://mcp.linear.app/mcp',
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      approvedToolAllowlist: ['get_issue', 'save_comment', 'update_issue'],
      createdAt: 1,
      ...surface,
    });
  });
}

/** A version of the owner's library, written by `author`, offerable unless told otherwise. */
async function version(
  harness: Harness,
  author: Id<'agents'>,
  fields: Partial<Doc<'skillVersions'>> = {},
): Promise<Id<'skillVersions'>> {
  return await harness.run(async (ctx) => {
    const writer = await ctx.db.get(author);
    const smokeTest = 'smokeTest' in fields ? fields.smokeTest : SMOKE;
    const body = fields.body ?? BODY;
    return await ctx.db.insert('skillVersions', {
      userId: writer!.userId!,
      name: NAME,
      description: 'Ticket comment-and-close on a kanban surface.',
      surfaceClass: 'kanban',
      operation: 'comment-and-close',
      version: 1,
      body,
      ...(smokeTest !== undefined ? { smokeTest } : {}),
      bodyHash: versionBodyHash(body, smokeTest),
      requiredScopes: ['linear:read', 'linear:write'],
      harnessTools: ['save_comment', 'update_issue'],
      harnessToolsBySurface: [
        { slug: 'linear', surfaceClass: 'kanban', tools: ['save_comment', 'update_issue'] },
      ],
      authorAgentId: author,
      authorName: writer!.name,
      readRefs: [],
      verifiedAt: Date.UTC(2026, 8, 18, 9),
      createdAt: 1,
      ...fields,
    });
  });
}

/** A work item of an employee waiting on a skill of the shape. */
async function waitingItem(harness: Harness, agentId: Id<'agents'>): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-21',
        title: 'Close REVOPS-21 with the audit note',
        contentSummary: 'Comment the audit note on REVOPS-21 and close it.',
        contentRefs: [],
        state: 'needs-skill',
        observedAt: 1,
        createdAt: 1,
      }),
  );
}

async function offerFor(
  harness: Harness,
  agentId: Id<'agents'>,
): Promise<Id<'skillVersions'> | null> {
  return await harness.query(internal.skillAdoption.offerFor, {
    agentId,
    name: NAME,
    surfaceClass: 'kanban',
    operation: 'comment-and-close',
  });
}

/** Propose the shape for the employee's waiting item, with the offer `offerFor` finds. */
async function propose(harness: Harness, agentId: Id<'agents'>): Promise<Id<'skills'>> {
  const workItemId = await waitingItem(harness, agentId);
  const offered = await offerFor(harness, agentId);
  return await harness.mutation(internal.skills.propose, {
    agentId,
    workItemId,
    name: NAME,
    description: 'Ticket comment-and-close on a kanban surface.',
    rationale: 'No registered skill covers comment-and-close on a kanban surface.',
    requiredScopes: ['linear:read', 'linear:write', 'boss:message'],
    surfaceClass: 'kanban',
    operation: 'comment-and-close',
    ...(offered !== null ? { offeredVersionId: offered } : {}),
  });
}

async function row(harness: Harness, skillId: Id<'skills'>): Promise<Doc<'skills'>> {
  const found = await harness.run(async (ctx) => await ctx.db.get(skillId));
  if (found === null) throw new Error('skill missing');
  return found;
}

async function eventsOf(harness: Harness, type: string): Promise<Doc<'events'>[]> {
  return await harness.run(async (ctx) =>
    (await ctx.db.query('events').collect()).filter((event) => event.type === type),
  );
}

async function liveGrants(harness: Harness, agentId: Id<'agents'>): Promise<string[]> {
  return (
    await harness.run(
      async (ctx) =>
        await ctx.db
          .query('permissionGrants')
          .withIndex('by_agent_scope', (q) => q.eq('agentId', agentId))
          .collect(),
    )
  )
    .filter((grant) => grant.revokedAt === undefined)
    .map((grant) => grant.scope)
    .sort();
}

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

describe('skillAdoption: the offer at needs-skill (real mode)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
  });

  it("offers the owner's newest offerable version of the shape", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const mateo = await employee(harness, 'Mateo');
    await linear(harness, mateo);
    await version(harness, priya, { version: 1 });
    const newest = await version(harness, priya, { version: 2, body: `${BODY}\n` });

    expect(await offerFor(harness, mateo)).toBe(newest);
    const skillId = await propose(harness, mateo);
    expect((await row(harness, skillId)).offeredVersionId).toBe(newest);
    const [offered] = await eventsOf(harness, 'skill.adoption-offered');
    expect(offered).toMatchObject({
      agentId: mateo,
      payload: { skillId, name: NAME, versionId: newest, version: 2, authorName: 'Priya' },
    });
  });

  it('offers nothing across owners', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const elsewhere = await employee(harness, 'Tomas', { owner: 'another-owner' });
    const mateo = await employee(harness, 'Mateo');
    await linear(harness, mateo);
    await version(harness, elsewhere);

    expect(await offerFor(harness, mateo)).toBeNull();
    const skillId = await propose(harness, mateo);
    expect((await row(harness, skillId)).offeredVersionId).toBeUndefined();
    expect(await eventsOf(harness, 'skill.adoption-offered')).toEqual([]);
  });

  it('a proposal given another owner’s version keeps no offer', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const elsewhere = await employee(harness, 'Tomas', { owner: 'another-owner' });
    const mateo = await employee(harness, 'Mateo');
    const theirs = await version(harness, elsewhere);
    const workItemId = await waitingItem(harness, mateo);

    const skillId = await harness.mutation(internal.skills.propose, {
      agentId: mateo,
      workItemId,
      name: NAME,
      description: 'Ticket comment-and-close on a kanban surface.',
      rationale: 'No registered skill covers it.',
      requiredScopes: ['linear:write'],
      surfaceClass: 'kanban',
      operation: 'comment-and-close',
      offeredVersionId: theirs,
    });

    expect((await row(harness, skillId)).offeredVersionId).toBeUndefined();
  });

  it('offers nothing when the adopter has no connected surface of the class, lacks a harness tool in its approved allowlist, or has no charter evidence for the system', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    await version(harness, priya);
    const unconnected = await employee(harness, 'Una');
    await linear(harness, unconnected, { verdict: 'approved', lastVerifiedAt: undefined });
    const expired = await employee(harness, 'Eli');
    await linear(harness, expired, { lastVerifiedAt: 1 });
    const narrower = await employee(harness, 'Nia');
    await linear(harness, narrower, { approvedToolAllowlist: ['get_issue', 'save_comment'] });
    const unchartered = await employee(harness, 'Cai', { charterClasses: ['chat'] });
    await linear(harness, unchartered);
    const evidenced = await employee(harness, 'Eve', { charterClasses: ['chat'] });
    await linear(harness, evidenced, {
      discoveryEvidence: [
        {
          kind: 'charter',
          ref: 'charter',
          quote: 'closes REVOPS tickets in Linear',
          current: true,
          firstSeenAt: 1,
          lastSeenAt: 1,
        },
      ],
    });

    for (const agentId of [unconnected, expired, narrower, unchartered]) {
      expect(await offerFor(harness, agentId)).toBeNull();
    }
    expect(await offerFor(harness, evidenced)).not.toBeNull();
  });

  it('offers nothing for a revoked, superseded or not-offerable version', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const mateo = await employee(harness, 'Mateo');
    await linear(harness, mateo);
    const revoked = await version(harness, priya, { revokedAt: 5, revokedReason: 'withdrawn' });
    expect(await offerFor(harness, mateo)).toBeNull();
    await harness.run(async (ctx) => await ctx.db.delete(revoked));
    const superseded = await version(harness, priya, { supersededAt: 5 });
    expect(await offerFor(harness, mateo)).toBeNull();
    await harness.run(async (ctx) => await ctx.db.delete(superseded));
    await version(harness, priya, { smokeTest: undefined });
    expect(await offerFor(harness, mateo)).toBeNull();
  });

  it('offers nothing of the adopter’s own writing', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const mateo = await employee(harness, 'Mateo');
    await linear(harness, mateo);
    await version(harness, mateo);
    expect(await offerFor(harness, mateo)).toBeNull();
  });

  it('offers nothing with the flag off', async (): Promise<void> => {
    vi.stubEnv('DAY0_SHARED_SKILLS', 'false');
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const mateo = await employee(harness, 'Mateo');
    await linear(harness, mateo);
    await version(harness, priya);

    expect(await offerFor(harness, mateo)).toBeNull();
  });

  it('a later proposal of the name withdraws an offer the evaluation no longer makes', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const mateo = await employee(harness, 'Mateo');
    await linear(harness, mateo);
    const offered = await version(harness, priya);
    const skillId = await propose(harness, mateo);
    expect((await row(harness, skillId)).offeredVersionId).toBe(offered);

    await harness.run(async (ctx) => await ctx.db.patch(offered, { revokedAt: 9 }));
    expect(await propose(harness, mateo)).toBe(skillId);

    expect((await row(harness, skillId)).offeredVersionId).toBeUndefined();
    expect(await eventsOf(harness, 'skill.adoption-offered')).toHaveLength(1);
  });

  it('refuses to adopt an offer that no longer stands, in words for the manager', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const mateo = await employee(harness, 'Mateo');
    await linear(harness, mateo);
    const offered = await version(harness, priya);
    const skillId = await propose(harness, mateo);
    await harness.run(async (ctx) => {
      const [surface] = await ctx.db.query('surfaces').collect();
      await ctx.db.patch(surface!._id, { approvedToolAllowlist: ['get_issue'] });
    });

    await expect(
      harness.withIdentity(OWNER).mutation(api.skillAdoption.adopt, { skillId }),
    ).rejects.toThrow(
      `${NAME} cannot be adopted: the approved tools of Linear do not include save_comment.`,
    );
    expect((await row(harness, skillId)).state).toBe('proposed');
    const [view] = await harness.withIdentity(OWNER).query(api.skillAdoption.adoptions, {
      agentId: mateo,
    });
    expect(view).toMatchObject({
      skillId,
      state: 'offered',
      versionId: offered,
      refusal: 'the approved tools of Linear do not include save_comment',
    });
  });

  it("refuses another owner's caller", async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const mateo = await employee(harness, 'Mateo');
    await linear(harness, mateo);
    await version(harness, priya);
    const skillId = await propose(harness, mateo);

    const stranger = harness.withIdentity(managerIdentity('stranger'));
    await expect(stranger.mutation(api.skillAdoption.adopt, { skillId })).rejects.toThrow(
      'forbidden',
    );
    await expect(stranger.mutation(api.skillAdoption.setOfferAside, { skillId })).rejects.toThrow(
      'forbidden',
    );
    await expect(stranger.query(api.skillAdoption.adoptions, { agentId: mateo })).rejects.toThrow(
      'forbidden',
    );
  });
});

describe('skillAdoption: adopting and the stored verification (mock mode)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('mock');
    recorded.sandboxRuns.length = 0;
    recorded.sandbox = PASSED;
  });

  it('refuses Adopt once a new manager has accepted the employee, in the accepted handover’s words, and grants nothing (the wave 10 review, M1)', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const ines = await employee(harness, 'Ines');
    await version(harness, priya);
    const skillId = await propose(harness, ines);
    await seedAcceptingHandover(harness, ines, 'Ines');

    await expect(
      harness.withIdentity(OWNER).mutation(api.skillAdoption.adopt, { skillId }),
    ).rejects.toMatchObject({ data: acceptedHandoverWords('Ines') });

    expect((await row(harness, skillId)).state).toBe('proposed');
    expect(await liveGrants(harness, ines)).toEqual([]);
    expect(await eventsOf(harness, 'skill.adopted')).toEqual([]);
  });

  it("adopt grants only the adopter's missing scopes and schedules the stored verification", async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const mateo = await employee(harness, 'Mateo');
    const offered = await version(harness, priya);
    await harness.run(async (ctx) => {
      await ctx.db.insert('permissionGrants', {
        agentId: mateo,
        scope: 'linear:read',
        createdAt: 1,
      });
      await ctx.db.insert('permissionGrants', {
        agentId: priya,
        scope: 'audit:write',
        createdAt: 1,
      });
    });
    const skillId = await propose(harness, mateo);
    const [card] = await harness.withIdentity(OWNER).query(api.skillAdoption.adoptions, {
      agentId: mateo,
    });
    expect(card).toMatchObject({
      skillId,
      name: NAME,
      description: 'Ticket comment-and-close on a kanban surface.',
      state: 'offered',
      versionId: offered,
      version: 1,
      authorName: 'Priya',
      missingScopes: ['linear:write', 'boss:message'],
    });
    expect(card).not.toHaveProperty('refusal');

    await expect(
      harness.withIdentity(OWNER).mutation(api.skillAdoption.adopt, { skillId }),
    ).resolves.toEqual({ scopes: ['linear:write', 'boss:message'] });

    expect(await liveGrants(harness, mateo)).toEqual([
      'boss:message',
      'linear:read',
      'linear:write',
    ]);
    expect(await liveGrants(harness, priya)).toEqual(['audit:write']);
    expect(await row(harness, skillId)).toMatchObject({
      state: 'approved',
      offeredVersionId: offered,
    });
    expect((await eventsOf(harness, 'skill.approved'))[0]?.payload).toEqual({
      skillId,
      name: NAME,
      scopes: ['linear:write', 'boss:message'],
    });
    expect((await eventsOf(harness, 'skill.adopted'))[0]?.payload).toEqual({
      skillId,
      name: NAME,
      versionId: offered,
      version: 1,
      authorName: 'Priya',
    });
    const scheduled = await harness.run(
      async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
    );
    expect(scheduled.map((job) => [job.name, job.args[0]])).toEqual([
      ['skillActions:verifyStoredSkill', { skillId }],
    ]);
    const [verifying] = await harness.withIdentity(OWNER).query(api.skillAdoption.adoptions, {
      agentId: mateo,
    });
    expect(verifying).toMatchObject({ skillId, state: 'verifying', missingScopes: [] });

    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(recorded.sandboxRuns).toEqual([{ skillBody: BODY, smokeTest: SMOKE }]);
    const registered = await row(harness, skillId);
    expect(registered).toMatchObject({ state: 'registered', body: BODY, versionId: offered });
    expect(registered.offeredVersionId).toBeUndefined();
    expect(registered.adoptedAt).toBeDefined();
    expect((await eventsOf(harness, 'skill.registered'))[0]?.payload).toMatchObject({
      skillId,
      versionId: offered,
      adopted: true,
    });
    expect(
      await harness.withIdentity(OWNER).query(api.skillAdoption.adoptions, { agentId: mateo }),
    ).toEqual([]);
    expect(
      await harness.run(async (ctx) => await ctx.db.query('skillVersions').collect()),
    ).toHaveLength(1);
  });

  it('a failed re-verification leaves the row failed with the log and offers Write a new one instead', async (): Promise<void> => {
    vi.useFakeTimers();
    recorded.sandbox = FAILED;
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const mateo = await employee(harness, 'Mateo');
    const offered = await version(harness, priya);
    const skillId = await propose(harness, mateo);

    await harness.withIdentity(OWNER).mutation(api.skillAdoption.adopt, { skillId });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    const failed = await row(harness, skillId);
    expect(failed).toMatchObject({ state: 'failed', offeredVersionId: offered });
    expect(failed.verificationLog).toContain('smoke.py exited 1');
    expect(failed.verificationLog).toContain('KeyError record_id');
    const [card] = await harness.withIdentity(OWNER).query(api.skillAdoption.adoptions, {
      agentId: mateo,
    });
    expect(card).toMatchObject({ skillId, state: 'failed', versionId: offered });
    expect(card?.log).toContain('KeyError record_id');

    // Write a new one instead: the offer goes, and the row is the employee's own to author.
    await expect(
      harness.withIdentity(OWNER).mutation(api.skillAdoption.setOfferAside, { skillId }),
    ).resolves.toEqual({ ok: true });
    expect((await row(harness, skillId)).offeredVersionId).toBeUndefined();
    expect(
      await harness.withIdentity(OWNER).query(api.skillAdoption.adoptions, { agentId: mateo }),
    ).toEqual([]);
    await expect(
      harness.withIdentity(OWNER).mutation(api.skillAdoption.setOfferAside, { skillId }),
    ).rejects.toThrow(`${NAME} has no adoption to set aside.`);
  });

  it('Write a new one instead on an offer leaves a plain proposal, and Decline is the rejection', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const mateo = await employee(harness, 'Mateo');
    await version(harness, priya);
    const setAside = await propose(harness, mateo);
    await harness
      .withIdentity(OWNER)
      .mutation(api.skillAdoption.setOfferAside, { skillId: setAside });
    expect(await row(harness, setAside)).toMatchObject({ state: 'proposed' });
    expect((await row(harness, setAside)).offeredVersionId).toBeUndefined();
    await expect(
      harness.withIdentity(OWNER).mutation(api.skillAdoption.adopt, { skillId: setAside }),
    ).rejects.toThrow(`${NAME} has no skill offered to adopt.`);

    await harness.withIdentity(OWNER).mutation(api.skills.reject, { skillId: setAside });
    expect((await row(harness, setAside)).state).toBe('rejected');
  });

  it('a check that stopped short draws as stalled, and Check it again verifies the version again', async (): Promise<void> => {
    vi.useFakeTimers();
    recorded.sandbox = SKIPPED;
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const mateo = await employee(harness, 'Mateo');
    const offered = await version(harness, priya);
    const skillId = await propose(harness, mateo);
    await harness.withIdentity(OWNER).mutation(api.skillAdoption.adopt, { skillId });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    const parked = await row(harness, skillId);
    expect(parked).toMatchObject({ state: 'authoring', offeredVersionId: offered });
    expect(parked.authoringRunId).toBeUndefined();
    const [card] = await harness.withIdentity(OWNER).query(api.skillAdoption.adoptions, {
      agentId: mateo,
    });
    expect(card).toMatchObject({ skillId, state: 'verifying', rowState: 'authoring' });
    expect(card).not.toHaveProperty('claimedAt');
    expect(card?.log).toContain('no sandbox backend');

    recorded.sandbox = PASSED;
    await expect(
      harness.withIdentity(OWNER).mutation(api.skillAdoption.verifyAgain, { skillId }),
    ).resolves.toEqual({ ok: true });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    const registered = await row(harness, skillId);
    expect(registered).toMatchObject({ state: 'registered', versionId: offered });
    expect(registered.adoptedAt).toBeDefined();
  });

  it('Check it again refuses an offer that no longer stands and a row a live run holds', async (): Promise<void> => {
    vi.useFakeTimers();
    recorded.sandbox = SKIPPED;
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const mateo = await employee(harness, 'Mateo');
    const offered = await version(harness, priya);
    const skillId = await propose(harness, mateo);
    await expect(
      harness.withIdentity(OWNER).mutation(api.skillAdoption.verifyAgain, { skillId }),
    ).rejects.toThrow(`${NAME} has no stopped check to run again.`);
    await harness.withIdentity(OWNER).mutation(api.skillAdoption.adopt, { skillId });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    await harness.run(async (ctx) => {
      await ctx.db.patch(skillId, {
        authoringRunId: (await ctx.db.query('events').first())!._id,
        authoringClaimedAt: Date.now(),
      });
    });
    await expect(
      harness.withIdentity(OWNER).mutation(api.skillAdoption.verifyAgain, { skillId }),
    ).rejects.toThrow(`${NAME} is being checked now.`);
    await harness.run(async (ctx) => {
      await ctx.db.patch(skillId, { authoringRunId: undefined, authoringClaimedAt: undefined });
      await ctx.db.patch(offered, { revokedAt: 9, revokedReason: 'withdrawn' });
    });
    await expect(
      harness.withIdentity(OWNER).mutation(api.skillAdoption.verifyAgain, { skillId }),
    ).rejects.toThrow(
      `${NAME} cannot be checked again: the offered skill was withdrawn from every employee.`,
    );
    const [card] = await harness.withIdentity(OWNER).query(api.skillAdoption.adoptions, {
      agentId: mateo,
    });
    expect(card).toMatchObject({
      state: 'verifying',
      refusal: 'the offered skill was withdrawn from every employee',
    });
  });

  it('Write a new one instead on a stalled adoption drops the parked copy, so the authoring writes anew', async (): Promise<void> => {
    vi.useFakeTimers();
    recorded.sandbox = SKIPPED;
    const harness = convexTest(schema, allConvexModules());
    const priya = await employee(harness, 'Priya');
    const mateo = await employee(harness, 'Mateo');
    await version(harness, priya);
    const skillId = await propose(harness, mateo);
    await harness.withIdentity(OWNER).mutation(api.skillAdoption.adopt, { skillId });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await row(harness, skillId)).pendingSmokeTest).toBe(SMOKE);

    await harness.withIdentity(OWNER).mutation(api.skillAdoption.setOfferAside, { skillId });

    const setAside = await row(harness, skillId);
    expect(setAside).toMatchObject({ state: 'authoring', body: '' });
    expect(setAside.offeredVersionId).toBeUndefined();
    expect(setAside.pendingSmokeTest).toBeUndefined();
  });
});
