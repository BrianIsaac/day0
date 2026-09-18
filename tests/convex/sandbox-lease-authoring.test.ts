/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { SkillSandboxRun } from '../../src/lib/skill-sandbox';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * An authoring run holds the sandbox lease across its verification, and a run
 * that arrives while another holds it waits and then verifies, rather than
 * queueing on the socket behind a smoke test that may run to the 60 s cap and
 * timing out at the client's 75 s wait.
 */

const recorded = vi.hoisted(() => ({
  outputs: [] as Array<{ body: string; smokeTest: string }>,
  sandboxRuns: 0,
  /** Which backend the deployment is configured for. */
  backend: 'local' as 'local' | 'daytona',
  /** Resolved by the sandbox mock when a verification starts. */
  started: undefined as (() => void) | undefined,
  /** Held open while a verification is "running" in the sandbox. */
  gate: undefined as Promise<void> | undefined,
  sandbox: undefined as SkillSandboxRun | undefined,
}));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async <T>(): Promise<T> => {
    const next = recorded.outputs.shift();
    if (!next) throw new Error('no authored output queued');
    return next as T;
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/lib/skill-sandbox', () => ({
  configuredSkillSandboxBackend: (): string => recorded.backend,
  authorAndVerifySkill: async (): Promise<SkillSandboxRun> => {
    recorded.sandboxRuns += 1;
    recorded.started?.();
    await recorded.gate;
    if (!recorded.sandbox) throw new Error('no sandbox result queued');
    return recorded.sandbox;
  },
}));

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };

const reusableBody = [
  '# Value refresh on an analytics surface',
  '## When to invoke',
  'A ticket asks for the tile figure to be set to a stated value.',
  '## Inputs',
  '- `<record-id>`: the ticket identifier from the candidate id.',
  '- `<requested-value>`: the figure the candidate names.',
  '## Procedure',
  'Sign in with `{{secret}}`, fill `Pipeline coverage` with `<requested-value>`, click `Save`, comment on `<record-id>`.',
  '## Verification',
  'The snapshot shows the audit line.',
].join('\n');

const smokeTest = [
  'def run(inputs: dict) -> dict:',
  '    return {"actions": [{"tool": "mcp.call", "args": {"value": inputs["requested_value"]}}]}',
  'for case in ({"record_id": "OPS-3", "requested_value": "61%"}, {"record_id": "OPS-9", "requested_value": "58%"}):',
  '    print("ok", run(case)["actions"][0]["args"]["value"])',
].join('\n');

async function seedApprovedSkill(harness: Harness, name: string): Promise<Id<'skills'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name,
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    return await ctx.db.insert('skills', {
      agentId,
      name: 'analytics-refresh-value',
      description: 'Value refresh on an analytics surface, parameterised from each work item and its runbook.',
      body: '',
      rationale: 'No registered skill covers value refresh on an analytics surface.',
      sourceType: 'agent-authored',
      state: 'approved',
      requiredScopes: ['boss:message', 'looker-pipeline-tile:write'],
      surfaceClass: 'analytics',
      operation: 'refresh-value',
      createdAt: 1,
    });
  });
}

async function readSkill(harness: Harness, skillId: Id<'skills'>): Promise<Doc<'skills'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(skillId));
  if (!row) throw new Error('skill missing');
  return row;
}

describe('an authoring run and the verification sandbox lease', (): void => {
  beforeEach((): void => {
    useSurfaceMode('mock');
    recorded.outputs.length = 0;
    recorded.sandboxRuns = 0;
    recorded.backend = 'local';
    recorded.started = undefined;
    recorded.gate = undefined;
    recorded.sandbox = {
      backend: 'local',
      sandboxId: 'local:run-1',
      stdout: 'ok 61%\nok 58%\n',
      stderr: '',
      ok: true,
      skipped: false,
    };
  });

  afterEach((): void => {
    restoreSurfaceMode();
  });

  it('holds the lease across its verification and releases it when the skill registers', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const skillId = await seedApprovedSkill(harness, 'Priya');
    recorded.outputs.push({ body: reusableBody, smokeTest });
    const otherSkillId = await seedApprovedSkill(harness, 'Mateo');
    const otherRunId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('events', {
          agentId: (await ctx.db.get(otherSkillId))!.agentId,
          type: 'skill.authoring-claimed',
          payload: { skillId: otherSkillId },
          createdAt: 1,
        }),
    );
    // The sandbox mock holds the verification open until the test has looked
    // at the lease, which is the only moment the claim is about.
    const verificationStarted = new Promise<void>((resolve): void => {
      recorded.started = resolve;
    });
    let releaseVerification = (): void => {};
    recorded.gate = new Promise<void>((resolve): void => {
      releaseVerification = resolve;
    });

    const run = harness
      .withIdentity(OWNER)
      .action(api.skillActions.authorAndRegisterSkill, { skillId });
    await verificationStarted;
    const heldDuringVerification = await harness.mutation(internal.sandboxLease.take, {
      skillId: otherSkillId,
      runId: otherRunId,
    });
    releaseVerification();
    await expect(run).resolves.toEqual({ ok: true });

    expect(heldDuringVerification).toMatchObject({ taken: false, heldBy: skillId });
    expect((await readSkill(harness, skillId)).state).toBe('registered');
    // Released: the next run takes it without waiting for the expiry.
    await expect(
      harness.mutation(internal.sandboxLease.take, { skillId: otherSkillId, runId: otherRunId }),
    ).resolves.toMatchObject({ taken: true });
  });

  it('releases the lease when the verification fails, so one bad smoke test does not hold the queue', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const skillId = await seedApprovedSkill(harness, 'Priya');
    recorded.outputs.push({ body: reusableBody, smokeTest });
    recorded.sandbox = {
      backend: 'local',
      sandboxId: 'local:run-2',
      stdout: '',
      stderr: 'Traceback',
      ok: false,
      failureReason: 'smoke test exited 1',
      skipped: false,
    };

    const result = await harness
      .withIdentity(OWNER)
      .action(api.skillActions.authorAndRegisterSkill, { skillId });

    expect(result.ok).toBe(false);
    expect((await readSkill(harness, skillId)).state).toBe('failed');
    expect(await harness.run(async (ctx) => await ctx.db.query('sandboxLeases').collect())).toEqual([]);
  });

  it('does not queue behind a lease when the hosted sandbox is the one configured', async (): Promise<void> => {
    // Daytona runs a sandbox per verification, so serialising employees there
    // would buy nothing and cost each of them the wait.
    recorded.backend = 'daytona';
    const harness = convexTest(schema, allConvexModules());
    const skillId = await seedApprovedSkill(harness, 'Priya');
    recorded.outputs.push({ body: reusableBody, smokeTest });
    const holderSkillId = await seedApprovedSkill(harness, 'Mateo');
    const holderRunId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('events', {
          agentId: (await ctx.db.get(holderSkillId))!.agentId,
          type: 'skill.authoring-claimed',
          payload: { skillId: holderSkillId },
          createdAt: 1,
        }),
    );
    await harness.mutation(internal.sandboxLease.take, {
      skillId: holderSkillId,
      runId: holderRunId,
    });

    await expect(
      harness.withIdentity(OWNER).action(api.skillActions.authorAndRegisterSkill, { skillId }),
    ).resolves.toEqual({ ok: true });
    expect(recorded.sandboxRuns).toBe(1);
    // The other run's lease is untouched, and this run took none.
    const rows = await harness.run(async (ctx) => await ctx.db.query('sandboxLeases').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.skillId).toBe(holderSkillId);
  });

  it('waits for the holder rather than queueing on the socket, and records the wait', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const waiting = await seedApprovedSkill(harness, 'Priya');
    recorded.outputs.push({ body: reusableBody, smokeTest });
    const holderSkillId = await seedApprovedSkill(harness, 'Mateo');
    const holderRunId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('events', {
          agentId: (await ctx.db.get(holderSkillId))!.agentId,
          type: 'skill.authoring-claimed',
          payload: { skillId: holderSkillId },
          createdAt: 1,
        }),
    );
    await harness.mutation(internal.sandboxLease.take, {
      skillId: holderSkillId,
      runId: holderRunId,
    });

    let settled = false;
    const run = harness
      .withIdentity(OWNER)
      .action(api.skillActions.authorAndRegisterSkill, { skillId: waiting })
      .finally((): void => {
        settled = true;
      });
    // The run authors, reaches the sandbox, finds the lease held, and waits.
    const waitingEventsNow = async (): Promise<Doc<'events'>[]> =>
      (await harness.run(async (ctx) => await ctx.db.query('events').collect())).filter(
        (event) => event.type === 'skill.sandbox-waiting',
      );
    const deadline = Date.now() + 15_000;
    let waitingEvents = await waitingEventsNow();
    while (waitingEvents.length === 0 && !settled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      waitingEvents = await waitingEventsNow();
    }
    expect(settled).toBe(false);
    expect(recorded.sandboxRuns).toBe(0);
    expect(waitingEvents).toHaveLength(1);
    expect(waitingEvents[0]!.payload).toMatchObject({ skillId: waiting });

    await harness.mutation(internal.sandboxLease.release, {
      skillId: holderSkillId,
      runId: holderRunId,
    });
    await expect(run).resolves.toEqual({ ok: true });
    expect(recorded.sandboxRuns).toBe(1);
    expect((await readSkill(harness, waiting)).state).toBe('registered');
  }, 30_000);
});
