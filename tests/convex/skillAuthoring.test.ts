/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { clipRefusedDraft, REFUSED_DRAFT_PROMPT_CHARS } from '../../src/work/authored-skill';
import type { SkillSandboxRun } from '../../src/lib/skill-sandbox';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

const recorded = vi.hoisted(() => ({
  users: [] as string[],
  schemas: [] as unknown[],
  outputs: [] as Array<{ body: string; smokeTest: string }>,
  sandboxRuns: 0,
  sandboxPrograms: [] as string[],
  sandbox: undefined as SkillSandboxRun | undefined,
}));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async <T>(args: { user: string; schema: unknown }): Promise<T> => {
    recorded.users.push(args.user);
    recorded.schemas.push(args.schema);
    const next = recorded.outputs.shift();
    if (!next) throw new Error('no authored output queued');
    return next as T;
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/lib/skill-sandbox', () => ({
  // The bundled sandbox: the path that takes the verification lease.
  configuredSkillSandboxBackend: (): string => 'local',
  authorAndVerifySkill: async (args: { smokeTest: string }): Promise<SkillSandboxRun> => {
    recorded.sandboxRuns += 1;
    recorded.sandboxPrograms.push(args.smokeTest);
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

async function seedApprovedSkill(harness: Harness): Promise<{ skillId: Id<'skills'>; workItemId: Id<'workItems'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'REVOPS-7',
      title: 'Refresh the Looker pipeline tile',
      contentSummary: 'The Friday standup states 74% pipeline coverage; enter 74% on the tile.',
      contentRefs: ['ticket://REVOPS-7'],
      state: 'needs-skill',
      observedAt: 1,
      createdAt: 1,
    });
    const skillId = await ctx.db.insert('skills', {
      agentId,
      name: 'analytics-refresh-value',
      description: 'Value refresh on an analytics surface, parameterised from each work item and its runbook.',
      body: '',
      rationale: 'No registered skill covers value refresh on an analytics surface.',
      sourceType: 'agent-authored',
      state: 'approved',
      proposedFor: workItemId,
      requiredScopes: ['boss:message', 'linear:read', 'looker-pipeline-tile:write'],
      surfaceClass: 'analytics',
      operation: 'refresh-value',
      createdAt: 1,
    });
    await ctx.db.patch(workItemId, { proposedSkillId: skillId });
    return { skillId, workItemId };
  });
}

async function readSkill(harness: Harness, skillId: Id<'skills'>): Promise<Doc<'skills'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(skillId));
  if (!row) throw new Error('skill missing');
  return row;
}

describe('the static gate on an authored skill, through the authoring action', (): void => {
  beforeEach((): void => {
    useSurfaceMode('mock');
    recorded.users.length = 0;
    recorded.schemas.length = 0;
    recorded.outputs.length = 0;
    recorded.sandboxRuns = 0;
    recorded.sandboxPrograms.length = 0;
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

  it('refuses the 14 Sep body before any sandbox runs, tells the retry why, and registers the parameterised rewrite', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { skillId, workItemId } = await seedApprovedSkill(harness);
    recorded.outputs.push({
      body: reusableBody.replace('## Procedure', '## Procedure\nThe sole approved value for this skill is 74% for REVOPS-7.'),
      smokeTest,
    });

    await expect(
      harness.withIdentity(OWNER).action(api.skillActions.authorAndRegisterSkill, { skillId }),
    ).resolves.toEqual({
      ok: false,
      reason:
        "the authored skill is not a reusable procedure: SKILL.md carries the first work item's value `REVOPS-7`; a skill reads it from the candidate at execution and names the input it stands for; SKILL.md carries the first work item's value `74%`; a skill reads it from the candidate at execution and names the input it stands for",
    });
    expect(recorded.sandboxRuns).toBe(0);
    const failed = await readSkill(harness, skillId);
    expect(failed.state).toBe('failed');
    expect(failed.verificationLog).toContain('`REVOPS-7`');
    const item = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(item?.state).toBe('needs-skill');
    const events = await harness.run(async (ctx) => await ctx.db.query('events').collect());
    expect(events.map((event) => event.type)).toContain('skill.author-failed');

    recorded.outputs.push({ body: reusableBody, smokeTest });
    await expect(
      harness.withIdentity(OWNER).action(api.skillActions.authorAndRegisterSkill, { skillId }),
    ).resolves.toEqual({ ok: true });
    expect(recorded.users).toHaveLength(2);
    expect(recorded.users[1]).toContain('Previous authoring attempt failed before registration');
    expect(recorded.users[1]).toContain("carries the first work item's value `74%`");
    expect(recorded.users[1]).toContain('Shape: value refresh on an analytics surface (analytics-refresh-value).');
    expect(recorded.sandboxRuns).toBe(1);
    const registered = await readSkill(harness, skillId);
    expect(registered.state).toBe('registered');
    expect(registered.body).toBe(reusableBody);
  });

  it('keeps a refused draft on the row, redacted and bounded, and clears it once a later attempt registers', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { skillId } = await seedApprovedSkill(harness);
    const padding = `\n${'The audit line is read back after the save. '.repeat(400)}`;
    const refusedBody = `${reusableBody}\nPost to <audit-channel> with Authorization: Bearer xoxb-1234567890-abcdefghijkl.${padding}`;
    recorded.outputs.push({ body: refusedBody, smokeTest });

    const result = await harness
      .withIdentity(OWNER)
      .action(api.skillActions.authorAndRegisterSkill, { skillId });

    expect(result.ok).toBe(false);
    expect(recorded.sandboxRuns).toBe(0);
    const failed = await readSkill(harness, skillId);
    expect(failed.state).toBe('failed');
    expect(failed.body).toBe('');
    expect(failed.refusedBody).toContain('Post to <audit-channel>');
    expect(failed.refusedBody).toContain('<redacted>');
    expect(failed.refusedBody).not.toContain('xoxb-');
    expect(failed.refusedBody!.length).toBeLessThan(refusedBody.length);
    expect(failed.refusedBody).toContain('more characters not kept');
    expect(failed.refusedSmokeTest).toBe(smokeTest);

    recorded.outputs.push({ body: reusableBody, smokeTest });
    await expect(
      harness.withIdentity(OWNER).action(api.skillActions.authorAndRegisterSkill, { skillId }),
    ).resolves.toEqual({ ok: true });
    const registered = await readSkill(harness, skillId);
    expect(registered.refusedBody).toBeUndefined();
    expect(registered.refusedSmokeTest).toBeUndefined();

    const retryPrompt = recorded.users[1]!;
    expect(retryPrompt).toContain('SKILL.md uses `<audit-channel>` without declaring it under `## Inputs`');
    expect(retryPrompt).toContain('--- Required correction ---');
    // The row keeps the draft whole; the prompt carries it bounded for the model's window.
    expect(retryPrompt).toContain(`Refused SKILL.md:\n${clipRefusedDraft(failed.refusedBody!, REFUSED_DRAFT_PROMPT_CHARS.body)}`);
    expect(retryPrompt).not.toContain(failed.refusedBody!);
    expect(retryPrompt).toContain(`Refused smoke.py:\n${smokeTest}`);
    expect(retryPrompt).not.toContain('xoxb-');
  });

  it('keeps the draft a smoke-test preflight refuses, and drops it again when the model itself fails', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { skillId } = await seedApprovedSkill(harness);
    const broken = 'def run(inputs: dict) -> dict:\n    return {"actions": [}\nprint(run({}))\n';
    recorded.outputs.push({ body: reusableBody, smokeTest: broken });

    const result = await harness
      .withIdentity(OWNER)
      .action(api.skillActions.authorAndRegisterSkill, { skillId });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('smoke test rejected before sandbox');
    const failed = await readSkill(harness, skillId);
    expect(failed.refusedBody).toBe(reusableBody);
    expect(failed.refusedSmokeTest).toBe(broken.trim());

    const again = await harness
      .withIdentity(OWNER)
      .action(api.skillActions.authorAndRegisterSkill, { skillId });
    expect(again.reason).toContain('authoring failed before any sandbox ran');
    const modelFailed = await readSkill(harness, skillId);
    expect(modelFailed.refusedBody).toBeUndefined();
    expect(modelFailed.refusedSmokeTest).toBeUndefined();
  });

  it('runs the author program as written in mock mode', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { skillId } = await seedApprovedSkill(harness);
    recorded.outputs.push({ body: reusableBody, smokeTest });

    await expect(
      harness.withIdentity(OWNER).action(api.skillActions.authorAndRegisterSkill, { skillId }),
    ).resolves.toEqual({ ok: true });
    expect(recorded.sandboxPrograms).toEqual([smokeTest]);
    const { authorSchema } = await import('../../convex/skillActions');
    expect(recorded.schemas).toEqual([authorSchema]);
  });

  it('removes a markdown fence from the smoke test before the gate and says so in the log', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { skillId } = await seedApprovedSkill(harness);
    recorded.outputs.push({ body: reusableBody, smokeTest: '```python\n' + smokeTest + '\n```' });

    await expect(
      harness.withIdentity(OWNER).action(api.skillActions.authorAndRegisterSkill, { skillId }),
    ).resolves.toEqual({ ok: true });
    expect(recorded.sandboxRuns).toBe(1);
    const registered = await readSkill(harness, skillId);
    expect(registered.verificationLog).toContain('markdown fence');
    expect(registered.verificationLog).toContain('ran in the local sandbox');
  });

  it('keeps the unfenced smoke test when a fenced one is refused, with the fence note on the reason', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { skillId } = await seedApprovedSkill(harness);
    const broken = 'def run(inputs: dict) -> dict:\n    return {"actions": [}\nprint(run({}))';
    recorded.outputs.push({ body: reusableBody, smokeTest: '```\n' + broken + '\n```' });

    const result = await harness
      .withIdentity(OWNER)
      .action(api.skillActions.authorAndRegisterSkill, { skillId });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('does not parse at line 2, column');
    const failed = await readSkill(harness, skillId);
    expect(failed.refusedSmokeTest).toBe(broken);
    expect(failed.verificationLog).toContain('markdown fence');
    expect(failed.verificationLog).toContain('does not parse at line 2, column');
  });

  it('refuses a smoke test whose representative input is the first work item', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { skillId } = await seedApprovedSkill(harness);
    recorded.outputs.push({ body: reusableBody, smokeTest: smokeTest.replace('"OPS-3"', '"REVOPS-7"') });

    const result = await harness
      .withIdentity(OWNER)
      .action(api.skillActions.authorAndRegisterSkill, { skillId });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("smoke.py carries the first work item's value `REVOPS-7`");
    expect(recorded.sandboxRuns).toBe(0);
  });

  it('refuses a body without declared inputs or with a foreign double-brace placeholder', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { skillId } = await seedApprovedSkill(harness);
    recorded.outputs.push({
      body: '# Refresh\nFill the tile with {{value}} and comment on <record-id>.',
      smokeTest,
    });

    const result = await harness
      .withIdentity(OWNER)
      .action(api.skillActions.authorAndRegisterSkill, { skillId });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('SKILL.md uses `{{value}}`');
    expect(result.reason).toContain('SKILL.md declares no `## Inputs` section');
    expect(recorded.sandboxRuns).toBe(0);
  });
});

describe('real-mode authoring, where the harness is the smoke test', (): void => {
  const casesSmokeTest = [
    'def run(inputs: dict) -> dict:',
    '    return {"actions": [{"action": "mcp.call", "tool": "save_comment", "id": inputs["record-id"]}]}',
    '',
    'CASES = [{"record-id": "OPS-3"}, {"record-id": "OPS-9"}]',
  ].join('\n');

  beforeEach((): void => {
    useSurfaceMode('real');
    recorded.users.length = 0;
    recorded.schemas.length = 0;
    recorded.outputs.length = 0;
    recorded.sandboxRuns = 0;
    recorded.sandboxPrograms.length = 0;
    recorded.sandbox = {
      backend: 'local',
      sandboxId: 'local:run-real',
      stdout: 'case 1: run() emitted 1 action\ncase 2: run() emitted 1 action\n',
      stderr: '',
      ok: true,
      skipped: false,
    };
  });

  afterEach((): void => {
    restoreSurfaceMode();
  });

  it('asks in the real-mode schema, sends the sandbox the harness, and registers', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { skillId } = await seedApprovedSkill(harness);
    recorded.outputs.push({ body: reusableBody, smokeTest: casesSmokeTest });

    await expect(
      harness.withIdentity(OWNER).action(api.skillActions.authorAndRegisterSkill, { skillId }),
    ).resolves.toEqual({ ok: true });
    const { realAuthorSchema } = await import('../../convex/skillActions');
    const { harnessedSmokeTest, smokeHarnessContract } = await import('../../src/work/smoke-harness');
    expect(recorded.schemas).toEqual([realAuthorSchema]);
    // The contract is the stored body and the agent's connected surfaces: none on this seed.
    expect(recorded.sandboxPrograms).toEqual([
      harnessedSmokeTest(casesSmokeTest, smokeHarnessContract(reusableBody, [], undefined, 0)),
    ]);
    const registered = await readSkill(harness, skillId);
    expect(registered.state).toBe('registered');
    expect(registered.verificationLog).toContain('case 1: run() emitted 1 action');
  });

  it('parks the author program, not the harness, when no sandbox ran, and harnesses it again on Retry', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { skillId } = await seedApprovedSkill(harness);
    recorded.outputs.push({ body: reusableBody, smokeTest: casesSmokeTest });
    recorded.sandbox = {
      backend: 'none',
      sandboxId: '(skipped)',
      stdout: '',
      stderr: '',
      ok: false,
      skipped: true,
      skipReason: 'the local sandbox is not running',
    };

    const parked = await harness
      .withIdentity(OWNER)
      .action(api.skillActions.authorAndRegisterSkill, { skillId });
    expect(parked.ok).toBe(false);
    expect((await readSkill(harness, skillId)).pendingSmokeTest).toBe(casesSmokeTest);

    recorded.sandbox = {
      backend: 'local',
      sandboxId: 'local:run-retry',
      stdout: 'case 1\ncase 2\n',
      stderr: '',
      ok: true,
      skipped: false,
    };
    await expect(
      harness.withIdentity(OWNER).action(api.skillActions.authorAndRegisterSkill, { skillId }),
    ).resolves.toEqual({ ok: true });
    const { harnessedSmokeTest, smokeHarnessContract } = await import('../../src/work/smoke-harness');
    const harnessed = harnessedSmokeTest(casesSmokeTest, smokeHarnessContract(reusableBody, [], undefined, 0));
    expect(recorded.users).toHaveLength(1);
    expect(recorded.sandboxPrograms).toEqual([harnessed, harnessed]);
  });
});
