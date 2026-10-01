/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { SkillSandboxRun } from '../../src/lib/skill-sandbox';
import { transferExpiresAt } from '../../src/agent/manager-transfer';
import { versionBodyHash } from '../../src/work/skill-library';
import { runThroughBody } from '../fixtures/run-through-charter-2026-09-14';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, fixtureAddressOf, managerIdentity } from './fakes/manager-identity';

/**
 * An adoption across a handover (the wave 10 review's B1 and M2): a stored copy of the old
 * owner's version, parked on the mover's row when its check stopped short, must never reach the
 * new owner, and no press of Retry may register a body its version's checks refuse.
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
const COLLEAGUE = managerIdentity('colleague');
const NAME = 'kanban-comment-and-close';

/** The old owner's verified body: no line of it may reach the new owner. */
const BODY = [
  '# Ticket comment-and-close',
  '## When to invoke',
  'A ticket asks to be closed once its work is done. OLD-OWNER-BODY',
  '## Inputs',
  '- `<record-id>`: the ticket identifier from the candidate id.',
  '## Procedure',
  'Call `save_comment` on `<record-id>` that the work is done, then `update_issue` to close it.',
  '## Verification',
  'The ticket reads closed.',
].join('\n');

const SMOKE = [
  '# OLD-OWNER-SMOKE',
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

/** Two employees of the owner (Priya writes, Sol adopts) and a colleague's own employee. */
interface Office {
  readonly harness: Harness;
  readonly priya: Id<'agents'>;
  readonly sol: Id<'agents'>;
  readonly offered: Id<'skillVersions'>;
  readonly skillId: Id<'skills'>;
}

/** An employee with an approved charter (the run-through's) naming a kanban system. */
async function employee(harness: Harness, name: string, owner: string): Promise<Id<'agents'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: fixtureAddressOf(owner),
      name,
      userId: owner,
      state: 'active',
      createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId,
      version: '0.1',
      body: {
        ...runThroughBody(),
        namedSystems: [{ name: 'Linear', class: 'kanban', whereMentioned: 'the one-to-one' }],
      },
      approved: true,
      approvedAt: 1,
      createdAt: 1,
    });
    return agentId;
  });
}

/**
 * The owner's office as bed 2 left it: Priya's verified version in the library, Sol's proposal
 * offered it, and Adopt pressed while no sandbox answered, so Sol's row is parked with a copy of
 * Priya's body and smoke test.
 */
async function parkedAdoption(): Promise<Office> {
  const harness = convexTest(schema, allConvexModules());
  const priya = await employee(harness, 'Priya', 'owner');
  const sol = await employee(harness, 'Sol', 'owner');
  const offered = await harness.run(
    async (ctx) =>
      await ctx.db.insert('skillVersions', {
        userId: 'owner',
        name: NAME,
        description: 'Ticket comment-and-close on a kanban surface.',
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        version: 1,
        body: BODY,
        smokeTest: SMOKE,
        bodyHash: versionBodyHash(BODY, SMOKE),
        requiredScopes: ['linear:read', 'linear:write'],
        harnessTools: ['save_comment', 'update_issue'],
        authorAgentId: priya,
        authorName: 'Priya',
        readRefs: [],
        verifiedAt: Date.UTC(2026, 8, 18, 9),
        createdAt: 1,
      }),
  );
  const workItemId = await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId: sol,
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
  const skillId = await harness.mutation(internal.skills.propose, {
    agentId: sol,
    workItemId,
    name: NAME,
    description: 'Ticket comment-and-close on a kanban surface.',
    rationale: 'No registered skill covers comment-and-close on a kanban surface.',
    requiredScopes: ['linear:read', 'linear:write'],
    surfaceClass: 'kanban',
    operation: 'comment-and-close',
    offeredVersionId: offered,
  });
  recorded.sandbox = SKIPPED;
  await harness.withIdentity(OWNER).mutation(api.skillAdoption.adopt, { skillId });
  await harness.finishAllScheduledFunctions(vi.runAllTimers);
  return { harness, priya, sol, offered, skillId };
}

/** Hand Sol to the colleague, who takes Sol on. */
async function handOver(office: Office): Promise<void> {
  const transferId = await office.harness.run(
    async (ctx) =>
      await ctx.db.insert('managerTransfers', {
        agentId: office.sol,
        agentName: 'Sol',
        fromOwnerKey: 'owner',
        fromAddress: MANAGER_ADDRESS,
        toAddress: fixtureAddressOf('colleague'),
        state: 'asked',
        requestedAt: Date.now(),
        expiresAt: transferExpiresAt(Date.now()),
      }),
  );
  const accepted = await office.harness
    .withIdentity(COLLEAGUE)
    .mutation(api.transferAcceptance.accept, { transferId });
  expect(accepted.state).toBe('accepted');
  await office.harness.finishAllScheduledFunctions(vi.runAllTimers);
}

async function row(harness: Harness, skillId: Id<'skills'>): Promise<Doc<'skills'>> {
  const found = await harness.run(async (ctx) => await ctx.db.get(skillId));
  if (found === null) throw new Error('skill missing');
  return found;
}

/** Every version of an owner's library. */
async function libraryOf(harness: Harness, owner: string): Promise<Doc<'skillVersions'>[]> {
  return await harness.run(async (ctx) =>
    (await ctx.db.query('skillVersions').collect()).filter((version) => version.userId === owner),
  );
}

beforeEach((): void => {
  useSurfaceMode('mock');
  vi.useFakeTimers();
  recorded.sandboxRuns.length = 0;
  recorded.sandbox = undefined;
});

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

describe('a parked adoption across a handover (the wave 10 review, B1)', (): void => {
  it("the move clears the parked copy with its offer, so the new manager reads nothing of the old owner's", async (): Promise<void> => {
    const office = await parkedAdoption();
    expect(await row(office.harness, office.skillId)).toMatchObject({
      state: 'authoring',
      body: BODY,
      pendingSmokeTest: SMOKE,
      offeredVersionId: office.offered,
    });

    await handOver(office);

    const seen = await office.harness
      .withIdentity(COLLEAGUE)
      .query(api.skills.get, { skillId: office.skillId });
    expect(seen).toMatchObject({ state: 'proposed', body: '' });
    expect(seen?.offeredVersionId).toBeUndefined();
    expect(seen?.pendingSmokeTest).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain('OLD-OWNER-BODY');
    expect(JSON.stringify(seen)).not.toContain('OLD-OWNER-SMOKE');
  });

  it("one press of Retry registers nothing of the old owner's in the new manager's library", async (): Promise<void> => {
    const office = await parkedAdoption();
    await handOver(office);
    recorded.sandbox = PASSED;
    recorded.sandboxRuns.length = 0;

    const retried = await office.harness
      .withIdentity(COLLEAGUE)
      .action(api.skillActions.authorAndRegisterSkill, { skillId: office.skillId });
    await office.harness.finishAllScheduledFunctions(vi.runAllTimers);

    expect(retried.ok).toBe(false);
    expect(recorded.sandboxRuns).toEqual([]);
    expect((await row(office.harness, office.skillId)).state).not.toBe('registered');
    const library = await libraryOf(office.harness, 'colleague');
    expect(library.filter((version) => version.bodyHash === versionBodyHash(BODY, SMOKE))).toEqual(
      [],
    );
    expect(JSON.stringify(library)).not.toContain('OLD-OWNER-BODY');
  });

  it("a check in flight at the move parks nothing on the new owner's row when it stops short", async (): Promise<void> => {
    const office = await parkedAdoption();
    // A Check it again whose run has claimed the row, and is waiting on the sandbox, at the move.
    const runId = await office.harness.run(async (ctx) => {
      const claimed = await ctx.db.insert('events', {
        agentId: office.sol,
        type: 'skill.authoring-claimed',
        payload: { skillId: office.skillId, name: NAME, fromState: 'authoring' },
        createdAt: Date.now(),
      });
      await ctx.db.patch(office.skillId, {
        body: '',
        pendingSmokeTest: undefined,
        authoringRunId: claimed,
        authoringClaimedAt: Date.now(),
      });
      return claimed;
    });
    await handOver(office);

    const parked = await office.harness.mutation(internal.skills.parkUnverified, {
      skillId: office.skillId,
      runId,
      sandboxId: '(skipped)',
      body: BODY,
      smokeTest: SMOKE,
      verificationLog: 'the stored skill was not verified: no sandbox; Retry runs its check',
      reason: 'no sandbox',
    });

    expect(parked.recorded).toBe(false);
    const after = await row(office.harness, office.skillId);
    expect(JSON.stringify(after)).not.toContain('OLD-OWNER-BODY');
    expect(after.pendingSmokeTest).toBeUndefined();
  });
});

describe('the authoring action on a parked stored copy (the wave 10 review, B1 line 2)', (): void => {
  it("registers a parked adoption copy under its version's checks: a withdrawn version is refused", async (): Promise<void> => {
    const office = await parkedAdoption();
    await office.harness.run(async (ctx) => {
      await ctx.db.patch(office.offered, { revokedAt: Date.now(), revokedReason: 'wrong' });
    });
    recorded.sandbox = PASSED;

    const retried = await office.harness
      .withIdentity(OWNER)
      .action(api.skillActions.authorAndRegisterSkill, { skillId: office.skillId });

    expect(retried.ok).toBe(false);
    const after = await row(office.harness, office.skillId);
    expect(after.state).toBe('failed');
    expect(after.verificationLog).toContain('was withdrawn from every employee');
    expect(
      (await libraryOf(office.harness, 'owner')).filter((version) => version.version > 1),
    ).toEqual([]);
  });

  it('refuses a parked stored copy whose row has no offer left', async (): Promise<void> => {
    const office = await parkedAdoption();
    // A row that lost its offer and kept the copy: no writer leaves this shape now, and the
    // action refuses it whatever wrote it.
    await office.harness.run(async (ctx) => {
      await ctx.db.patch(office.skillId, { offeredVersionId: undefined });
    });
    recorded.sandbox = PASSED;
    recorded.sandboxRuns.length = 0;

    const retried = await office.harness
      .withIdentity(OWNER)
      .action(api.skillActions.authorAndRegisterSkill, { skillId: office.skillId });

    expect(retried.ok).toBe(false);
    expect(recorded.sandboxRuns).toEqual([]);
    const after = await row(office.harness, office.skillId);
    expect(after.state).not.toBe('registered');
    expect(after.body).toBe('');
    expect(after.pendingSmokeTest).toBeUndefined();
  });

  it('registers a parked adoption copy once a sandbox answers, as the offered version', async (): Promise<void> => {
    const office = await parkedAdoption();
    recorded.sandbox = PASSED;

    const retried = await office.harness
      .withIdentity(OWNER)
      .action(api.skillActions.authorAndRegisterSkill, { skillId: office.skillId });

    expect(retried).toEqual({ ok: true });
    expect(await row(office.harness, office.skillId)).toMatchObject({
      state: 'registered',
      versionId: office.offered,
    });
  });
});
