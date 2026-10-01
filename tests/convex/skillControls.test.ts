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

/**
 * `convex/skillControls.ts`: the manager's five controls on a skill (the enhancements plan,
 * section 4.1): Retire, Withdraw for every employee (A12), Re-check now, Give up, and Ask for a
 * revision as a new version.
 */

const recorded = vi.hoisted(() => ({
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
  authorAndVerifySkill: async (): Promise<SkillSandboxRun> => {
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
  'Comment on `<record-id>` that the work is done, then close it.',
  '## Verification',
  'The ticket reads closed.',
].join('\n');

const REVISED_BODY = BODY.replace('that the work is done', 'with the figures, then');

const SMOKE = [
  'def run(inputs: dict) -> dict:',
  '    return {"actions": [{"tool": "ticket.update", "args": {"slug": inputs["record_id"]}}]}',
  'for case in ({"record_id": "OPS-3"}, {"record_id": "OPS-9"}):',
  '    print("ok", run(case)["actions"][0]["args"]["slug"])',
].join('\n');

const PASSED: SkillSandboxRun = {
  backend: 'local',
  sandboxId: 'local:recheck-1',
  stdout: 'ok OPS-3\nok OPS-9\n',
  stderr: '',
  ok: true,
  skipped: false,
};

const FAILED: SkillSandboxRun = {
  backend: 'local',
  sandboxId: 'local:recheck-2',
  stdout: '',
  stderr: 'Traceback: KeyError record_id',
  ok: false,
  failureReason: 'smoke test exited 1',
  skipped: false,
};

interface Office {
  readonly priya: Id<'agents'>;
  readonly mateo: Id<'agents'>;
  readonly versionId: Id<'skillVersions'>;
  readonly priyaSkill: Id<'skills'>;
  readonly mateoSkill: Id<'skills'>;
}

/** Priya, who wrote version 1 of the skill, and Mateo, who holds the same version. */
async function seedOffice(harness: Harness): Promise<Office> {
  return await harness.run(async (ctx) => {
    const employee = async (name: string): Promise<Id<'agents'>> =>
      await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name,
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
    const priya = await employee('Priya');
    const mateo = await employee('Mateo');
    const versionId = await ctx.db.insert('skillVersions', {
      userId: 'owner',
      name: NAME,
      description: 'Ticket comment-and-close.',
      surfaceClass: 'kanban',
      operation: 'comment-and-close',
      version: 1,
      body: BODY,
      smokeTest: SMOKE,
      bodyHash: versionBodyHash(BODY, SMOKE),
      requiredScopes: [],
      harnessTools: [],
      authorAgentId: priya,
      authorName: 'Priya',
      readRefs: [],
      verifiedAt: 1,
      createdAt: 1,
    });
    const holder = async (agentId: Id<'agents'>): Promise<Id<'skills'>> =>
      await ctx.db.insert('skills', {
        agentId,
        name: NAME,
        description: 'Ticket comment-and-close.',
        body: BODY,
        sourceType: 'agent-authored',
        state: 'registered',
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        requiredScopes: ['linear:read', 'linear:write'],
        versionId,
        registeredAt: 1,
        createdAt: 1,
      });
    return {
      priya,
      mateo,
      versionId,
      priyaSkill: await holder(priya),
      mateoSkill: await holder(mateo),
    };
  });
}

/** A work item of the employee's, in the given state, from Linear unless said. */
async function seedItem(
  harness: Harness,
  agentId: Id<'agents'>,
  fields: Partial<Doc<'workItems'>> & Pick<Doc<'workItems'>, 'state' | 'externalId'>,
): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        title: `Close ${fields.externalId}`,
        contentSummary: 'Synthetic.',
        contentRefs: [],
        observedAt: 1,
        createdAt: 1,
        ...fields,
      }),
  );
}

async function skill(harness: Harness, skillId: Id<'skills'>): Promise<Doc<'skills'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(skillId));
  if (row === null) throw new Error('skill missing');
  return row;
}

async function item(harness: Harness, workItemId: Id<'workItems'>): Promise<Doc<'workItems'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (row === null) throw new Error('work item missing');
  return row;
}

async function eventsOf(
  harness: Harness,
  agentId: Id<'agents'>,
  type: Doc<'events'>['type'],
): Promise<Doc<'events'>[]> {
  return (await harness.run(async (ctx) => await ctx.db.query('events').collect())).filter(
    (event) => event.agentId === agentId && event.type === type,
  );
}

const APPROVED_PLAN = { steps: [{ kind: 'write', text: 'Comment and close.' }] };

describe('skillControls', (): void => {
  beforeEach((): void => {
    // Scheduled work runs only when a test drains it.
    vi.useFakeTimers();
    useSurfaceMode('mock');
    recorded.sandbox = PASSED;
  });

  afterEach((): void => {
    vi.useRealTimers();
    restoreSurfaceMode();
  });

  describe('retire', (): void => {
    it('retire takes one holder out and returns its plan-approved items to needs-skill', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const office = await seedOffice(harness);
      // One item linked to the skill by its proposal, one of the skill's shape the executor would
      // have picked it for, and one of another shape that no retire of this skill reaches.
      const linked = await seedItem(harness, office.priya, {
        state: 'plan-approved',
        externalId: 'REVOPS-1',
        proposedSkillId: office.priyaSkill,
        plan: APPROVED_PLAN,
      });
      const shaped = await seedItem(harness, office.priya, {
        state: 'plan-approved',
        externalId: 'REVOPS-2',
        plan: APPROVED_PLAN,
      });
      const otherShape = await seedItem(harness, office.priya, {
        state: 'plan-approved',
        externalId: 'thread-1',
        sourceSystem: 'slack',
        sourceCategory: 'chat',
        plan: APPROVED_PLAN,
      });
      const mateoItem = await seedItem(harness, office.mateo, {
        state: 'plan-approved',
        externalId: 'REVOPS-3',
        plan: APPROVED_PLAN,
      });
      // A re-check is running on the row: the retire fences it out.
      await harness.run(async (ctx) => {
        await ctx.db.patch(office.priyaSkill, {
          authoringRunId: await ctx.db.insert('events', {
            agentId: office.priya,
            type: 'skill.authoring-claimed',
            payload: { skillId: office.priyaSkill, name: NAME, fromState: 'registered' },
            createdAt: 5,
          }),
          authoringClaimedAt: Date.now(),
        });
      });

      await expect(
        harness.withIdentity(OWNER).mutation(api.skillControls.retire, {
          skillId: office.priyaSkill,
          reason: '  it closes the wrong tickets ',
        }),
      ).resolves.toEqual({ retired: true, returnedItems: 2 });

      const retired = await skill(harness, office.priyaSkill);
      expect(retired).toMatchObject({
        state: 'retired',
        retiredReason: 'it closes the wrong tickets',
      });
      expect(retired.retiredAt).toBeTypeOf('number');
      expect(retired.authoringRunId).toBeUndefined();
      expect(retired.authoringClaimedAt).toBeUndefined();
      // The version and the other holder are untouched.
      expect((await skill(harness, office.mateoSkill)).state).toBe('registered');
      expect(
        (await harness.run(async (ctx) => await ctx.db.get(office.versionId)))?.revokedAt,
      ).toBeUndefined();

      const waitingReason = `the skill ${NAME} was retired, so this waits for a skill again`;
      for (const workItemId of [linked, shaped]) {
        const parked = await item(harness, workItemId);
        expect(parked).toMatchObject({
          state: 'needs-skill',
          verdict: {
            decision: 'needs-skill',
            reason: waitingReason,
            suggestedSkillName: NAME,
            suggestedSkillShape: { surfaceClass: 'kanban', operation: 'comment-and-close' },
          },
        });
        // The plan was approved for the body that is gone: the next one is approved afresh.
        expect(parked.plan).toBeUndefined();
        expect(parked.proposedSkillId).not.toBe(office.priyaSkill);
      }
      expect((await item(harness, otherShape)).state).toBe('plan-approved');
      expect((await item(harness, mateoItem)).state).toBe('plan-approved');

      // The proposal step is asked for the skill again; an item is only ever linked to a row of
      // the name that may still become callable, never to the retired one.
      await harness.finishAllScheduledFunctions(vi.runAllTimers);
      for (const workItemId of [linked, shaped]) {
        const parked = await item(harness, workItemId);
        expect(parked.state).toBe('needs-skill');
        if (parked.proposedSkillId !== undefined) {
          expect(await skill(harness, parked.proposedSkillId)).toMatchObject({
            name: NAME,
            state: 'proposed',
          });
        }
      }

      const [event] = await eventsOf(harness, office.priya, 'skill.retired');
      expect(event?.payload).toEqual({
        skillId: office.priyaSkill,
        name: NAME,
        reason: 'it closes the wrong tickets',
        versionId: office.versionId,
        returnedItems: [linked, shaped],
      });
      expect(
        (await eventsOf(harness, office.priya, 'work.waiting-for-skill')).map(
          (waiting) => waiting.payload,
        ),
      ).toEqual([
        {
          workItemId: linked,
          name: NAME,
          reason: waitingReason,
          previousState: 'plan-approved',
        },
        {
          workItemId: shaped,
          name: NAME,
          reason: waitingReason,
          previousState: 'plan-approved',
        },
      ]);
    });

    it('keeps an item another callable skill of the same shape still covers', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const office = await seedOffice(harness);
      await harness.run(async (ctx) => {
        await ctx.db.insert('skills', {
          agentId: office.priya,
          name: 'kanban-comment-and-close-legacy',
          description: 'Another one of the shape.',
          body: BODY,
          sourceType: 'agent-authored',
          state: 'registered',
          surfaceClass: 'kanban',
          operation: 'comment-and-close',
          registeredAt: 1,
          createdAt: 1,
        });
      });
      const shaped = await seedItem(harness, office.priya, {
        state: 'plan-approved',
        externalId: 'REVOPS-2',
        plan: APPROVED_PLAN,
      });

      await harness
        .withIdentity(OWNER)
        .mutation(api.skillControls.retire, { skillId: office.priyaSkill });

      expect((await item(harness, shaped)).state).toBe('plan-approved');
      expect((await skill(harness, office.priyaSkill)).retiredReason).toBe(
        'retired by the manager',
      );
    });

    it('ends a revision being written, so it cannot register the retired skill again', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const office = await seedOffice(harness);
      const { revisionId } = await harness
        .withIdentity(OWNER)
        .mutation(api.skillControls.askForRevision, { skillId: office.priyaSkill });

      await harness
        .withIdentity(OWNER)
        .mutation(api.skillControls.retire, { skillId: office.priyaSkill });

      expect((await skill(harness, revisionId)).state).toBe('rejected');
      const claim = await harness.mutation(internal.skills.claimAuthoringRun, {
        skillId: revisionId,
      });
      expect(claim).toEqual({ claimed: false, reason: 'this skill was rejected' });
    });

    it('refuses a skill that is not callable, a built-in one, and another owner', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const office = await seedOffice(harness);
      const builtin = await harness.run(
        async (ctx) =>
          await ctx.db.insert('skills', {
            agentId: office.priya,
            name: 'see-internal-docs',
            description: 'Docs.',
            body: 'Read the docs.',
            sourceType: 'builtin',
            state: 'registered',
            createdAt: 1,
          }),
      );

      await expect(
        harness.withIdentity(OWNER).mutation(api.skillControls.retire, { skillId: builtin }),
      ).rejects.toThrow('A built-in skill comes with the employee and is not retired.');
      await expect(
        harness
          .withIdentity(managerIdentity('someone-else'))
          .mutation(api.skillControls.retire, { skillId: office.priyaSkill }),
      ).rejects.toThrow('forbidden');
      await harness
        .withIdentity(OWNER)
        .mutation(api.skillControls.retire, { skillId: office.priyaSkill });
      await expect(
        harness
          .withIdentity(OWNER)
          .mutation(api.skillControls.retire, { skillId: office.priyaSkill }),
      ).rejects.toThrow(`Only a callable skill is retired; ${NAME} is retired.`);
      await expect(
        harness.withIdentity(OWNER).mutation(api.skillControls.retire, {
          skillId: office.mateoSkill,
          reason: 'x'.repeat(501),
        }),
      ).rejects.toThrow('Keep the reason to 500 characters.');
    });
  });

  describe('withdraw', (): void => {
    it('withdraw retires every holder of the version in one transaction and names them', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const office = await seedOffice(harness);
      const mateoItem = await seedItem(harness, office.mateo, {
        state: 'plan-approved',
        externalId: 'REVOPS-3',
        proposedSkillId: office.mateoSkill,
        plan: APPROVED_PLAN,
      });
      // A holder of another version of the name is not this withdrawal's.
      const otherVersionHolder = await harness.run(async (ctx) => {
        const aiko = await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Aiko',
          userId: 'owner',
          state: 'active',
          createdAt: 1,
        });
        const v2 = await ctx.db.insert('skillVersions', {
          userId: 'owner',
          name: NAME,
          description: 'Ticket comment-and-close.',
          surfaceClass: 'kanban',
          operation: 'comment-and-close',
          version: 2,
          body: REVISED_BODY,
          smokeTest: SMOKE,
          bodyHash: versionBodyHash(REVISED_BODY, SMOKE),
          requiredScopes: [],
          harnessTools: [],
          authorName: 'Aiko',
          readRefs: [],
          verifiedAt: 2,
          createdAt: 2,
        });
        return await ctx.db.insert('skills', {
          agentId: aiko,
          name: NAME,
          description: 'Ticket comment-and-close.',
          body: REVISED_BODY,
          sourceType: 'agent-authored',
          state: 'registered',
          surfaceClass: 'kanban',
          operation: 'comment-and-close',
          versionId: v2,
          registeredAt: 2,
          createdAt: 2,
        });
      });

      await expect(
        harness.withIdentity(OWNER).mutation(api.skillControls.withdraw, {
          skillId: office.priyaSkill,
          reason: 'it closes the wrong tickets',
        }),
      ).resolves.toEqual({ withdrawn: true, holders: 2 });

      const version = await harness.run(async (ctx) => await ctx.db.get(office.versionId));
      expect(version?.revokedReason).toBe('it closes the wrong tickets');
      expect(version?.revokedAt).toBeTypeOf('number');
      for (const holder of [office.priyaSkill, office.mateoSkill]) {
        expect(await skill(harness, holder)).toMatchObject({
          state: 'retired',
          retiredReason: 'it closes the wrong tickets',
        });
      }
      expect((await skill(harness, otherVersionHolder)).state).toBe('registered');
      expect(await item(harness, mateoItem)).toMatchObject({
        state: 'needs-skill',
        verdict: {
          reason: `the skill ${NAME} was withdrawn from every employee, so this waits for a skill again`,
        },
      });

      const revoked = await eventsOf(harness, office.priya, 'skill.revoked');
      expect(revoked.map((event) => event.payload)).toEqual([
        {
          skillId: office.priyaSkill,
          name: NAME,
          reason: 'it closes the wrong tickets',
          versionId: office.versionId,
          version: 1,
          holders: [
            { skillId: office.priyaSkill, agentId: office.priya, agentName: 'Priya' },
            { skillId: office.mateoSkill, agentId: office.mateo, agentName: 'Mateo' },
          ],
        },
      ]);
      expect(await eventsOf(harness, office.mateo, 'skill.revoked')).toEqual([]);
      for (const [agentId, skillId] of [
        [office.priya, office.priyaSkill],
        [office.mateo, office.mateoSkill],
      ] as const) {
        expect((await eventsOf(harness, agentId, 'skill.retired')).map((e) => e.payload)).toEqual([
          expect.objectContaining({ skillId, withdrawn: true, versionId: office.versionId }),
        ]);
      }
    });

    it('claimForExecution refuses a withdrawn row', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const office = await seedOffice(harness);
      await harness
        .withIdentity(OWNER)
        .mutation(api.skillControls.withdraw, { skillId: office.mateoSkill });
      // An item approved before the withdrawal reaches the claim afterwards.
      const late = await seedItem(harness, office.mateo, {
        state: 'plan-approved',
        externalId: 'REVOPS-4',
        plan: APPROVED_PLAN,
      });

      const claim = await harness.mutation(internal.work.claimForExecution, {
        workItemId: late,
        skillId: office.mateoSkill,
      });

      expect(claim.claimed).toBe(false);
      expect((await item(harness, late)).state).toBe('plan-approved');
      expect((await skill(harness, office.mateoSkill)).useCount).toBeUndefined();
    });

    it('refuses a skill with no library version, and a version already withdrawn', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const office = await seedOffice(harness);
      const unversioned = await harness.run(
        async (ctx) =>
          await ctx.db.insert('skills', {
            agentId: office.priya,
            name: 'linear-action-revops-7',
            description: 'Legacy.',
            body: BODY,
            sourceType: 'agent-authored',
            state: 'registered',
            registeredAt: 1,
            createdAt: 1,
          }),
      );

      await expect(
        harness.withIdentity(OWNER).mutation(api.skillControls.withdraw, { skillId: unversioned }),
      ).rejects.toThrow(
        'linear-action-revops-7 holds no library version, so no other employee holds it; retire it instead.',
      );
      await harness
        .withIdentity(OWNER)
        .mutation(api.skillControls.withdraw, { skillId: office.priyaSkill });
      await expect(
        harness
          .withIdentity(OWNER)
          .mutation(api.skillControls.withdraw, { skillId: office.mateoSkill }),
      ).rejects.toThrow(`Version 1 of ${NAME} was already withdrawn.`);
    });
  });

  describe('recheckNow', (): void => {
    it('recheckNow clears the chip on a pass and fails the row with the log on a failure', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const office = await seedOffice(harness);
      await harness.run(async (ctx) => {
        await ctx.db.patch(office.priyaSkill, {
          recheckDueAt: 3,
          recheckReason: 'the tools you approved on linear changed',
        });
      });

      await expect(
        harness
          .withIdentity(OWNER)
          .mutation(api.skillControls.recheckNow, { skillId: office.priyaSkill }),
      ).resolves.toEqual({ scheduled: true });
      await harness.finishAllScheduledFunctions(vi.runAllTimers);

      const passed = await skill(harness, office.priyaSkill);
      expect(passed).toMatchObject({ state: 'registered', versionId: office.versionId });
      expect(passed.recheckDueAt).toBeUndefined();
      expect(passed.recheckReason).toBeUndefined();

      recorded.sandbox = FAILED;
      await harness
        .withIdentity(OWNER)
        .mutation(api.skillControls.recheckNow, { skillId: office.priyaSkill });
      await harness.finishAllScheduledFunctions(vi.runAllTimers);

      const failed = await skill(harness, office.priyaSkill);
      expect(failed.state).toBe('failed');
      expect(failed.verificationLog).toContain('smoke test exited 1');
      expect(failed.verificationLog).toContain('Traceback: KeyError record_id');
    });

    it('refuses a row with no stored version, one not callable, and one a check holds now', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const office = await seedOffice(harness);
      await harness.run(async (ctx) => {
        await ctx.db.patch(office.mateoSkill, { versionId: undefined });
        await ctx.db.patch(office.priyaSkill, {
          authoringRunId: await ctx.db.insert('events', {
            agentId: office.priya,
            type: 'skill.authoring-claimed',
            payload: { skillId: office.priyaSkill, name: NAME, fromState: 'registered' },
            createdAt: 5,
          }),
          authoringClaimedAt: Date.now(),
        });
      });

      await expect(
        harness
          .withIdentity(OWNER)
          .mutation(api.skillControls.recheckNow, { skillId: office.mateoSkill }),
      ).rejects.toThrow(`${NAME} has no stored version to re-check; ask for a revision instead.`);
      await expect(
        harness
          .withIdentity(OWNER)
          .mutation(api.skillControls.recheckNow, { skillId: office.priyaSkill }),
      ).rejects.toThrow(`A check of ${NAME} is already running.`);
      await harness.run(async (ctx) => {
        await ctx.db.patch(office.priyaSkill, { state: 'failed', authoringRunId: undefined });
      });
      await expect(
        harness
          .withIdentity(OWNER)
          .mutation(api.skillControls.recheckNow, { skillId: office.priyaSkill }),
      ).rejects.toThrow(`Only a callable skill is re-checked; ${NAME} is failed.`);
    });
  });

  describe('giveUp', (): void => {
    it('give up ends a failed skill and cancels its waiting item with the reason', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const office = await seedOffice(harness);
      const source = await seedItem(harness, office.priya, {
        state: 'needs-skill',
        externalId: 'REVOPS-7',
      });
      const failing = await harness.run(async (ctx) => {
        const id = await ctx.db.insert('skills', {
          agentId: office.priya,
          name: 'analytics-refresh-value',
          description: 'Refresh a tile.',
          body: '',
          sourceType: 'agent-authored',
          state: 'failed',
          proposedFor: source,
          verificationLog: 'the sandbox run refused the draft',
          authoringAttempts: 3,
          createdAt: 1,
        });
        await ctx.db.patch(source, { proposedSkillId: id });
        return id;
      });
      const alsoWaiting = await seedItem(harness, office.priya, {
        state: 'needs-skill',
        externalId: 'REVOPS-8',
        proposedSkillId: failing,
      });
      const waitingOnAnother = await seedItem(harness, office.priya, {
        state: 'needs-skill',
        externalId: 'REVOPS-9',
        proposedSkillId: office.priyaSkill,
      });

      await expect(
        harness.withIdentity(OWNER).mutation(api.skillControls.giveUp, { skillId: failing }),
      ).resolves.toEqual({ givenUp: true, cancelled: 2 });

      const ended = await skill(harness, failing);
      expect(ended.state).toBe('rejected');
      // History is kept: the last failure's reason stays on the row.
      expect(ended.verificationLog).toBe('the sandbox run refused the draft');
      for (const workItemId of [source, alsoWaiting]) {
        expect(await item(harness, workItemId)).toMatchObject({
          state: 'cancelled',
          skipReason: 'given up after 3 attempts',
        });
      }
      expect((await item(harness, waitingOnAnother)).state).toBe('needs-skill');
      expect(
        (await eventsOf(harness, office.priya, 'skill.given-up')).map((event) => event.payload),
      ).toEqual([
        {
          skillId: failing,
          name: 'analytics-refresh-value',
          reason: 'given up after 3 attempts',
          attempts: 3,
        },
      ]);
      expect(
        (await eventsOf(harness, office.priya, 'work.cancelled')).map((event) => event.payload),
      ).toEqual([
        { workItemId: source, skillId: failing, reason: 'given up after 3 attempts' },
        { workItemId: alsoWaiting, skillId: failing, reason: 'given up after 3 attempts' },
      ]);
    });

    it('refuses a skill that has not failed', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const office = await seedOffice(harness);
      await expect(
        harness
          .withIdentity(OWNER)
          .mutation(api.skillControls.giveUp, { skillId: office.priyaSkill }),
      ).rejects.toThrow(`Only a skill that failed its check is given up; ${NAME} is registered.`);
    });
  });

  describe('askForRevision', (): void => {
    it('ask for a revision keeps the current row running until the new version registers, then supersedes it and stamps the other holders', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const office = await seedOffice(harness);
      const used = await seedItem(harness, office.priya, {
        state: 'completed',
        externalId: 'REVOPS-1',
        skillId: office.priyaSkill,
      });
      await harness.run(async (ctx) => {
        await ctx.db.patch(office.priyaSkill, { proposedFor: used });
      });

      const { revisionId } = await harness
        .withIdentity(OWNER)
        .mutation(api.skillControls.askForRevision, { skillId: office.priyaSkill });

      // History is kept, so a skill that already ran can be revised; the current row runs on.
      expect(await skill(harness, office.priyaSkill)).toMatchObject({
        state: 'registered',
        body: BODY,
      });
      expect(await skill(harness, revisionId)).toMatchObject({
        state: 'approved',
        name: NAME,
        body: '',
        revisionOf: office.priyaSkill,
        proposedFor: used,
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        requiredScopes: ['linear:read', 'linear:write'],
      });
      await expect(
        harness
          .withIdentity(OWNER)
          .mutation(api.skillControls.askForRevision, { skillId: office.priyaSkill }),
      ).rejects.toThrow(`A revision of ${NAME} is already being written.`);

      const claim = await harness.mutation(internal.skills.claimAuthoringRun, {
        skillId: revisionId,
      });
      if (!claim.claimed) throw new Error(claim.reason);
      await harness.mutation(internal.skills.completeRegistration, {
        skillId: revisionId,
        runId: claim.runId,
        body: REVISED_BODY,
        verificationLog: 'ok OPS-3\nok OPS-9',
        smokeTest: SMOKE,
      });

      expect((await skill(harness, revisionId)).state).toBe('registered');
      expect((await skill(harness, office.priyaSkill)).state).toBe('superseded');
      const versions = await harness.run(
        async (ctx) => await ctx.db.query('skillVersions').collect(),
      );
      expect(versions.map((version) => version.version).sort()).toEqual([1, 2]);
      expect(versions.find((version) => version.version === 1)?.supersededAt).toBeTypeOf('number');
      expect(await skill(harness, office.mateoSkill)).toMatchObject({
        state: 'registered',
        recheckReason: 'v2 is verified; this runs v1',
      });
      expect(
        (await eventsOf(harness, office.priya, 'skill.revision-requested')).map((e) => e.payload),
      ).toEqual([{ skillId: office.priyaSkill, name: NAME, revisionId }]);
    });

    it('refuses a skill that is not callable, and a built-in one', async (): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const office = await seedOffice(harness);
      await harness.run(async (ctx) => {
        await ctx.db.patch(office.mateoSkill, { state: 'failed' });
        await ctx.db.patch(office.priyaSkill, { sourceType: 'builtin' });
      });

      for (const skillId of [office.mateoSkill, office.priyaSkill]) {
        await expect(
          harness.withIdentity(OWNER).mutation(api.skillControls.askForRevision, { skillId }),
        ).rejects.toThrow('Only a callable skill an employee wrote is revised.');
      }
    });
  });
});
