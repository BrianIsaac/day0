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
 * `storedVerification.verifyStoredSkill`: a stored body and smoke test verified in the sandbox under
 * the holding employee's contract and the one global lease, for an adoption and a re-check.
 */

const recorded = vi.hoisted(() => ({
  outputs: [] as Array<{ body: string; smokeTest: string }>,
  prompts: [] as string[],
  sandboxRuns: [] as Array<{ skillBody: string; smokeTest: string }>,
  started: undefined as (() => void) | undefined,
  gate: undefined as Promise<void> | undefined,
  sandbox: undefined as SkillSandboxRun | undefined,
}));

const { schemaChecked } = await vi.hoisted(async () => await import('./fakes/mastra'));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: schemaChecked(async (args: { user: string }): Promise<unknown> => {
    recorded.prompts.push(args.user);
    const next = recorded.outputs.shift();
    if (!next) throw new Error('no authored output queued');
    return next;
  }),
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/lib/skill-sandbox', () => ({
  configuredSkillSandboxBackend: (): string => 'local',
  authorAndVerifySkill: async (args: {
    skillBody: string;
    smokeTest: string;
  }): Promise<SkillSandboxRun> => {
    recorded.sandboxRuns.push({ skillBody: args.skillBody, smokeTest: args.smokeTest });
    recorded.started?.();
    await recorded.gate;
    if (!recorded.sandbox) throw new Error('no sandbox result queued');
    return recorded.sandbox;
  },
}));

type Harness = TestConvex<typeof schema>;

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

const SMOKE = [
  'def run(inputs: dict) -> dict:',
  '    return {"actions": [{"tool": "ticket.update", "args": {"slug": inputs["record_id"]}}]}',
  'for case in ({"record_id": "OPS-3"}, {"record_id": "OPS-9"}):',
  '    print("ok", run(case)["actions"][0]["args"]["slug"])',
].join('\n');

const PASSED: SkillSandboxRun = {
  backend: 'local',
  sandboxId: 'local:stored-1',
  stdout: 'ok OPS-3\nok OPS-9\n',
  stderr: '',
  ok: true,
  skipped: false,
};

/** Priya, who wrote version 1, and Mateo, a sibling of the same owner. */
async function seedOffice(
  harness: Harness,
  version: { smokeTest?: string } = { smokeTest: SMOKE },
): Promise<{ priya: Id<'agents'>; mateo: Id<'agents'>; versionId: Id<'skillVersions'> }> {
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
      name: 'kanban-comment-and-close',
      description: 'Ticket comment-and-close.',
      surfaceClass: 'kanban',
      operation: 'comment-and-close',
      version: 1,
      body: BODY,
      ...version,
      bodyHash: versionBodyHash(BODY, version.smokeTest),
      requiredScopes: [],
      harnessTools: [],
      authorAgentId: priya,
      authorName: 'Priya',
      readRefs: [],
      verifiedAt: 1,
      createdAt: 1,
    });
    return { priya, mateo, versionId };
  });
}

/** A row of Mateo's approved to adopt the version (10-A's Adopt, before it schedules this). */
async function adoptingRow(
  harness: Harness,
  agentId: Id<'agents'>,
  versionId: Id<'skillVersions'>,
): Promise<Id<'skills'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('skills', {
        agentId,
        name: 'kanban-comment-and-close',
        description: 'Ticket comment-and-close.',
        body: '',
        sourceType: 'agent-authored',
        state: 'approved',
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        offeredVersionId: versionId,
        createdAt: 2,
      }),
  );
}

/** Priya's registered row of the version, due a re-check. */
async function registeredRow(
  harness: Harness,
  agentId: Id<'agents'>,
  versionId: Id<'skillVersions'>,
): Promise<Id<'skills'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('skills', {
        agentId,
        name: 'kanban-comment-and-close',
        description: 'Ticket comment-and-close.',
        body: BODY,
        sourceType: 'agent-authored',
        state: 'registered',
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        versionId,
        recheckDueAt: 5,
        recheckReason: 'its check was not kept',
        registeredAt: 1,
        createdAt: 1,
      }),
  );
}

async function row(harness: Harness, skillId: Id<'skills'>): Promise<Doc<'skills'>> {
  const found = await harness.run(async (ctx) => await ctx.db.get(skillId));
  if (found === null) throw new Error('skill missing');
  return found;
}

/** A run that holds the lease, the way another employee's verification would. */
async function otherRun(harness: Harness): Promise<{ skillId: Id<'skills'>; runId: Id<'events'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Aiko',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const skillId = await ctx.db.insert('skills', {
      agentId,
      name: 'chat-thread-reply',
      description: 'Reply.',
      body: '',
      sourceType: 'agent-authored',
      state: 'authoring',
      createdAt: 1,
    });
    const runId = await ctx.db.insert('events', {
      agentId,
      type: 'skill.authoring-claimed',
      payload: { skillId },
      createdAt: 1,
    });
    return { skillId, runId };
  });
}

describe('verifyStoredSkill', (): void => {
  beforeEach((): void => {
    useSurfaceMode('mock');
    recorded.outputs.length = 0;
    recorded.prompts.length = 0;
    recorded.sandboxRuns.length = 0;
    recorded.started = undefined;
    recorded.gate = undefined;
    recorded.sandbox = PASSED;
  });

  afterEach((): void => {
    vi.useRealTimers();
    restoreSurfaceMode();
  });

  it('verifyStoredSkill registers on a pass and fails with the log on a failure, under the one lease', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { mateo, versionId } = await seedOffice(harness);
    const adopting = await adoptingRow(harness, mateo, versionId);
    const other = await otherRun(harness);
    // The sandbox mock holds the verification open while the test reads the lease.
    const started = new Promise<void>((resolve): void => {
      recorded.started = resolve;
    });
    let finish = (): void => {};
    recorded.gate = new Promise<void>((resolve): void => {
      finish = resolve;
    });

    const pass = harness.action(internal.storedVerification.verifyStoredSkill, {
      skillId: adopting,
    });
    await started;
    const during = await harness.mutation(internal.sandboxLease.take, other);
    finish();
    await expect(pass).resolves.toEqual({ ok: true });

    expect(during).toMatchObject({ taken: false, heldBy: adopting });
    expect(recorded.sandboxRuns).toEqual([{ skillBody: BODY, smokeTest: SMOKE }]);
    expect(recorded.prompts).toEqual([]);
    expect(await row(harness, adopting)).toMatchObject({
      state: 'registered',
      body: BODY,
      versionId,
    });
    expect((await row(harness, adopting)).adoptedAt).toBeDefined();
    expect(
      await harness.run(async (ctx) => await ctx.db.query('skillVersions').collect()),
    ).toHaveLength(1);
    // Released: the other employee's run takes it without waiting for the expiry.
    await expect(harness.mutation(internal.sandboxLease.take, other)).resolves.toMatchObject({
      taken: true,
    });
    await harness.mutation(internal.sandboxLease.release, other);

    // The same version fails for another adopter: the row is failed with the sandbox's log.
    const failing = await adoptingRow(harness, mateo, versionId);
    recorded.sandbox = {
      backend: 'local',
      sandboxId: 'local:stored-2',
      stdout: '',
      stderr: 'Traceback: KeyError record_id',
      ok: false,
      failureReason: 'smoke test exited 1',
      skipped: false,
    };
    const failed = await harness.action(internal.storedVerification.verifyStoredSkill, {
      skillId: failing,
    });

    expect(failed.ok).toBe(false);
    const after = await row(harness, failing);
    expect(after.state).toBe('failed');
    expect(after.verificationLog).toContain('smoke test exited 1');
    expect(after.verificationLog).toContain('Traceback: KeyError record_id');
    expect(after.versionId).toBeUndefined();
    expect(await harness.run(async (ctx) => await ctx.db.query('sandboxLeases').collect())).toEqual(
      [],
    );
  });

  it('fails an adoption whose version is withdrawn while it waits, and writes no version of it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { mateo, versionId } = await seedOffice(harness);
    const adopting = await adoptingRow(harness, mateo, versionId);
    const started = new Promise<void>((resolve): void => {
      recorded.started = resolve;
    });
    let finish = (): void => {};
    recorded.gate = new Promise<void>((resolve): void => {
      finish = resolve;
    });

    const run = harness.action(internal.storedVerification.verifyStoredSkill, {
      skillId: adopting,
    });
    await started;
    await harness.run(async (ctx) => await ctx.db.patch(versionId, { revokedAt: 7 }));
    finish();

    await expect(run).resolves.toMatchObject({ ok: false });
    const after = await row(harness, adopting);
    expect(after.state).toBe('failed');
    expect(after.verificationLog).toContain('withdrawn');
    expect(
      await harness.run(async (ctx) => await ctx.db.query('skillVersions').collect()),
    ).toHaveLength(1);
  });

  it('leaves a registered row running and still due when its re-check is refused at registration (the wave 10 review, K-m1)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { priya, versionId } = await seedOffice(harness);
    const held = await registeredRow(harness, priya, versionId);
    await harness.run(async (ctx) => {
      await ctx.db.patch(held, { recheckDueAt: 3, recheckReason: 'its check was not kept' });
    });
    const started = new Promise<void>((resolve): void => {
      recorded.started = resolve;
    });
    let finish = (): void => {};
    recorded.gate = new Promise<void>((resolve): void => {
      finish = resolve;
    });

    const run = harness.action(internal.storedVerification.verifyStoredSkill, { skillId: held });
    await started;
    // Handed over while the check ran: the version stayed with the old owner, so the registration
    // is refused, and the body the employee runs is not.
    await harness.run(async (ctx) => await ctx.db.patch(priya, { userId: 'colleague' }));
    finish();

    await expect(run).resolves.toMatchObject({ ok: false });
    const after = await row(harness, held);
    expect(after).toMatchObject({
      state: 'registered',
      versionId,
      recheckReason: 'its check was not kept',
    });
    expect(after.authoringRunId).toBeUndefined();
  });

  it('counts attempts of the draft only: a registration clears them, so a later failed re-check can be retried (the wave 10 review, K-m4)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { priya, versionId } = await seedOffice(harness);
    const held = await registeredRow(harness, priya, versionId);
    // Registered on its third attempt.
    await harness.run(async (ctx) => await ctx.db.patch(held, { authoringAttempts: 3 }));

    await harness.action(internal.storedVerification.verifyStoredSkill, { skillId: held });
    expect((await row(harness, held)).authoringAttempts).toBeUndefined();

    recorded.sandbox = {
      backend: 'local',
      sandboxId: 'local:stored-3',
      stdout: '',
      stderr: 'Traceback: KeyError record_id',
      ok: false,
      failureReason: 'smoke test exited 1',
      skipped: false,
    };
    await harness.action(internal.storedVerification.verifyStoredSkill, { skillId: held });
    expect((await row(harness, held)).state).toBe('failed');
    const retry = await harness.mutation(internal.skills.claimAuthoringRun, { skillId: held });
    expect(retry.claimed).toBe(true);
  });

  it('re-checks a registered row in use, and clears its chip on a pass', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { priya, versionId } = await seedOffice(harness);
    const held = await registeredRow(harness, priya, versionId);

    await expect(
      harness.action(internal.storedVerification.verifyStoredSkill, { skillId: held }),
    ).resolves.toEqual({ ok: true });

    const after = await row(harness, held);
    expect(after).toMatchObject({ state: 'registered', versionId });
    expect(after.recheckDueAt).toBeUndefined();
    expect(after.recheckReason).toBeUndefined();
    expect(after.authoringRunId).toBeUndefined();
  });

  it('says on the record that the claim is a check of a stored version, not a writing (A-m9)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { priya, versionId } = await seedOffice(harness);
    const held = await registeredRow(harness, priya, versionId);

    await harness.action(internal.storedVerification.verifyStoredSkill, { skillId: held });

    const claims = await harness.run(async (ctx) =>
      (await ctx.db.query('events').collect()).filter(
        (event) => event.type === 'skill.authoring-claimed',
      ),
    );
    expect(claims.map((event) => event.payload)).toEqual([
      expect.objectContaining({ skillId: held, purpose: 'verify-stored' }),
    ]);
  });

  it('writes a smoke test for the unchanged body of a version whose check was not kept, then keeps it', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { priya, versionId } = await seedOffice(harness, {});
    const held = await registeredRow(harness, priya, versionId);
    recorded.outputs.push({ body: '# A rewrite nobody asked for', smokeTest: SMOKE });

    await expect(
      harness.action(internal.storedVerification.verifyStoredSkill, { skillId: held }),
    ).resolves.toEqual({ ok: true });

    expect(recorded.prompts).toHaveLength(1);
    expect(recorded.prompts[0]).toContain('it stays exactly as it is');
    expect(recorded.prompts[0]).toContain(BODY);
    // The sandbox ran the registered body, never the model's rewrite.
    expect(recorded.sandboxRuns).toEqual([{ skillBody: BODY, smokeTest: SMOKE }]);
    const version = await harness.run(async (ctx) => await ctx.db.get(versionId));
    expect(version).toMatchObject({ smokeTest: SMOKE, bodyHash: versionBodyHash(BODY, SMOKE) });
    expect(await row(harness, held)).toMatchObject({ state: 'registered', body: BODY });
    expect((await row(harness, held)).recheckDueAt).toBeUndefined();
  });

  it('reads the documentation a window at a time when it writes a kept check, so a corpus past one read is no failure (F2 D5)', async (): Promise<void> => {
    // The deployment's own read limit: 16 MiB a query.
    const harness = convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
    const { priya, versionId } = await seedOffice(harness, {});
    const held = await registeredRow(harness, priya, versionId);
    await harness.run(async (ctx) => await ctx.db.patch(held, { targetSurface: 'linear' }));
    const sourceId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('docSources', {
          userId: 'owner',
          label: 'Company folder',
          kind: 'folder',
          locator: 'company',
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    // Thirty pages of about 600 KB, 18 MB in all, the runbook for the target near the end; one
    // write each, as a sync stores them.
    for (let index = 0; index < 30; index += 1) {
      const runbook = index === 27;
      await harness.run(async (ctx) => {
        await ctx.db.insert('docPages', {
          sourceId,
          ref: `page-${String(index).padStart(2, '0')}.md`,
          title: runbook ? 'How to close a Linear ticket' : `Handbook page ${index}`,
          markdown: `# ${runbook ? 'Close the ticket in Linear with a summary comment.' : 'Notes'}\n\n${'x'.repeat(600 * 1024)}`,
          updatedAt: 1,
        });
      });
    }
    recorded.outputs.push({ body: BODY, smokeTest: SMOKE });

    await expect(
      harness.action(internal.storedVerification.verifyStoredSkill, { skillId: held }),
    ).resolves.toEqual({ ok: true });

    expect(recorded.prompts).toHaveLength(1);
    expect(recorded.prompts[0]).toContain('### How to close a Linear ticket');
  }, 60_000);

  it('leaves a registered row running and still due when no sandbox ran', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { priya, versionId } = await seedOffice(harness);
    const held = await registeredRow(harness, priya, versionId);
    recorded.sandbox = {
      backend: 'local',
      sandboxId: '(skipped)',
      stdout: '',
      stderr: '',
      ok: false,
      skipped: true,
      skipReason: 'the sandbox service did not answer',
    };

    const result = await harness.action(internal.storedVerification.verifyStoredSkill, {
      skillId: held,
    });

    expect(result).toEqual({ ok: false, reason: 'the sandbox service did not answer' });
    const after = await row(harness, held);
    expect(after).toMatchObject({
      state: 'registered',
      body: BODY,
      recheckReason: 'its check was not kept',
    });
    expect(after.authoringRunId).toBeUndefined();
  });

  it('fails a registered row whose re-check the sandbox refuses, with the log', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { priya, versionId } = await seedOffice(harness);
    const held = await registeredRow(harness, priya, versionId);
    recorded.sandbox = {
      backend: 'local',
      sandboxId: 'local:stored-3',
      stdout: '',
      stderr: 'Traceback: the tool is gone',
      ok: false,
      failureReason: 'smoke test exited 1',
      skipped: false,
    };

    const result = await harness.action(internal.storedVerification.verifyStoredSkill, {
      skillId: held,
    });

    expect(result.ok).toBe(false);
    const after = await row(harness, held);
    expect(after.state).toBe('failed');
    expect(after.verificationLog).toContain('Traceback: the tool is gone');
    expect(after.versionId).toBe(versionId);
  });

  it('refuses a version withdrawn from every employee, or one of another owner, before any claim', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { mateo, versionId } = await seedOffice(harness);
    const adopting = await adoptingRow(harness, mateo, versionId);
    await harness.run(async (ctx) => await ctx.db.patch(versionId, { revokedAt: 9 }));

    await expect(
      harness.action(internal.storedVerification.verifyStoredSkill, { skillId: adopting }),
    ).resolves.toEqual({ ok: false, reason: 'the version was withdrawn from every employee' });

    await harness.run(
      async (ctx) => await ctx.db.patch(versionId, { revokedAt: undefined, userId: 'rival' }),
    );
    await expect(
      harness.action(internal.storedVerification.verifyStoredSkill, { skillId: adopting }),
    ).resolves.toEqual({
      ok: false,
      reason: "the version is not one of this employee's owner's",
    });
    expect(recorded.sandboxRuns).toEqual([]);
    expect(await row(harness, adopting)).toMatchObject({ state: 'approved' });
  });

  it('moves a registered row onto a newer version of its name when that version is named', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { priya, mateo, versionId } = await seedOffice(harness);
    const held = await registeredRow(harness, mateo, versionId);
    const newerBody = BODY.replace('then close it', 'then close it once it reads back');
    const newer = await harness.run(
      async (ctx) =>
        await ctx.db.insert('skillVersions', {
          userId: 'owner',
          name: 'kanban-comment-and-close',
          description: 'Ticket comment-and-close.',
          surfaceClass: 'kanban',
          operation: 'comment-and-close',
          version: 2,
          body: newerBody,
          smokeTest: SMOKE,
          bodyHash: versionBodyHash(newerBody, SMOKE),
          requiredScopes: [],
          harnessTools: [],
          authorAgentId: priya,
          authorName: 'Priya',
          readRefs: [],
          verifiedAt: 2,
          createdAt: 2,
        }),
    );

    await expect(
      harness.action(internal.storedVerification.verifyStoredSkill, {
        skillId: held,
        versionId: newer,
      }),
    ).resolves.toEqual({ ok: true });

    expect(recorded.sandboxRuns).toEqual([{ skillBody: newerBody, smokeTest: SMOKE }]);
    expect(await row(harness, held)).toMatchObject({
      state: 'registered',
      body: newerBody,
      versionId: newer,
    });
    expect((await row(harness, held)).recheckDueAt).toBeUndefined();
  });

  it('refuses a row with no stored version and leaves it as it was', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { priya } = await seedOffice(harness);
    const bare = await harness.run(
      async (ctx) =>
        await ctx.db.insert('skills', {
          agentId: priya,
          name: 'kanban-comment-and-close',
          description: 'Ticket comment-and-close.',
          body: '',
          sourceType: 'agent-authored',
          state: 'approved',
          createdAt: 1,
        }),
    );

    await expect(
      harness.action(internal.storedVerification.verifyStoredSkill, { skillId: bare }),
    ).resolves.toEqual({ ok: false, reason: 'the skill holds no stored version to verify' });
    expect(await row(harness, bare)).toMatchObject({ state: 'approved' });
  });
});

describe('authoring keeps what registration records (10-K)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('mock');
    recorded.outputs.length = 0;
    recorded.prompts.length = 0;
    recorded.sandboxRuns.length = 0;
    recorded.started = undefined;
    recorded.gate = undefined;
    recorded.sandbox = PASSED;
  });

  afterEach((): void => {
    restoreSurfaceMode();
  });

  it('registers an authored skill with its passing smoke test kept on version 1', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { mateo } = await seedOffice(harness);
    const skillId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('skills', {
          agentId: mateo,
          name: 'kanban-comment-and-close',
          description: 'Ticket comment-and-close.',
          body: '',
          sourceType: 'agent-authored',
          state: 'approved',
          surfaceClass: 'kanban',
          operation: 'comment-and-close',
          createdAt: 3,
        }),
    );
    const bodyTwo = BODY.replace('then close it', 'then close it once it reads back');
    recorded.outputs.push({ body: bodyTwo, smokeTest: SMOKE });

    await expect(
      harness.withIdentity(managerIdentity()).action(api.skillActions.authorAndRegisterSkill, {
        skillId,
      }),
    ).resolves.toEqual({ ok: true });

    const authored = await row(harness, skillId);
    const version = await harness.run(async (ctx) => await ctx.db.get(authored.versionId!));
    expect(version).toMatchObject({
      version: 2,
      body: bodyTwo,
      smokeTest: SMOKE,
      authorAgentId: mateo,
      authorName: 'Mateo',
      readRefs: [],
    });
  });
});

describe('authoring records the pages it read and the tools it names, in real mode (10-K)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    recorded.outputs.length = 0;
    recorded.prompts.length = 0;
    recorded.sandboxRuns.length = 0;
    recorded.started = undefined;
    recorded.gate = undefined;
    recorded.sandbox = PASSED;
  });

  afterEach((): void => {
    restoreSurfaceMode();
  });

  it('keeps the linked runbook pages as readRefs and the allowed tools SKILL.md names', async (): Promise<void> => {
    const [{ default: realSchema }, { allConvexModules: realModules }] = await Promise.all([
      import('../../convex/schema'),
      import('./all-modules'),
    ]);
    const harness = convexTest(realSchema, realModules());
    const seeded = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Runbooks',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'linear-runbook.md',
        title: 'Linear runbook',
        markdown: 'In Linear, call save_comment, then save_issue to close.',
        updatedAt: 1,
      });
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'holidays.md',
        title: 'Holidays',
        markdown: 'The office closes on public holidays.',
        updatedAt: 1,
      });
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        path: 'mcp',
        verdict: 'connected',
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        endpoint: 'https://mcp.linear.app/mcp',
        toolAllowlist: ['save_comment', 'save_issue', 'list_issues'],
        whereFound: [],
        createdAt: 1,
      });
      const skillId = await ctx.db.insert('skills', {
        agentId,
        name: 'kanban-comment-and-close',
        description: 'Ticket comment-and-close.',
        body: '',
        sourceType: 'agent-authored',
        state: 'approved',
        targetSurface: 'linear',
        surfaceClass: 'kanban',
        operation: 'comment-and-close',
        createdAt: 1,
      });
      return { sourceId, skillId };
    });
    const body = BODY.replace(
      'Comment on `<record-id>` that the work is done, then close it.',
      'Call `save_comment` on `<record-id>` that the work is done, then `save_issue` to close it.',
    );
    recorded.outputs.push({
      body,
      smokeTest: [
        'def run(inputs: dict) -> dict:',
        '    return {"actions": [{"tool": "mcp.call", "args": {"surface": "linear", "tool": "save_comment", "toolArgsJson": inputs["record-id"]}}]}',
        'CASES = [{"record-id": "OPS-3"}, {"record-id": "OPS-9"}]',
      ].join('\n'),
    });

    await expect(
      harness.withIdentity(managerIdentity()).action(api.skillActions.authorAndRegisterSkill, {
        skillId: seeded.skillId,
      }),
    ).resolves.toEqual({ ok: true });

    const registered = await harness.run(async (ctx) => await ctx.db.get(seeded.skillId));
    const version = await harness.run(async (ctx) => await ctx.db.get(registered!.versionId!));
    expect(version?.readRefs).toEqual([
      { sourceId: seeded.sourceId, ref: 'linear-runbook.md', title: 'Linear runbook' },
    ]);
    expect(version?.harnessTools).toEqual(['save_comment', 'save_issue']);
    expect(version?.harnessToolsBySurface).toEqual([
      { slug: 'linear', surfaceClass: 'kanban', tools: ['save_comment', 'save_issue'] },
    ]);
  });
});
