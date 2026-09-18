/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import type { SkillSandboxRun } from '../../src/lib/skill-sandbox';
import { declaredSkillInputs, undeclaredSkillInputs } from '../../src/work/skill-inputs';
import {
  UNDECLARED_BODY_2026_09_19,
  UNDECLARED_NAMES_2026_09_19,
  UNDECLARED_SMOKE_TEST_2026_09_19,
} from '../fixtures/skill-undeclared-inputs-2026-09-19';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

const recorded = vi.hoisted(() => ({
  outputs: [] as Array<{ body: string; smokeTest: string }>,
  sandboxRuns: 0,
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
  configuredSkillSandboxBackend: (): string => 'local',
  authorAndVerifySkill: async (): Promise<SkillSandboxRun> => {
    recorded.sandboxRuns += 1;
    return {
      backend: 'local',
      sandboxId: 'local:run-f2',
      stdout: 'case 1: run() emitted 3 actions\ncase 2: run() emitted 2 actions\n',
      stderr: '',
      ok: true,
      skipped: false,
    };
  },
}));

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };

/** Mateo's rows as the rehearsal had them when the skill was approved. */
async function seedApprovedSkill(harness: Harness): Promise<Id<'skills'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@example.com',
      name: 'Mateo',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: ['FIN', 1].join('-'),
      title: 'Post the September close status note',
      contentSummary: 'Post the close status note for the September close on this ticket.',
      contentRefs: [],
      state: 'needs-skill',
      observedAt: 1,
      createdAt: 1,
    });
    return await ctx.db.insert('skills', {
      agentId,
      name: 'kanban-comment-and-close',
      description: 'Ticket comment-and-close on a kanban surface, parameterised from each work item and its runbook.',
      body: '',
      rationale: 'No registered skill covers ticket comment-and-close on a kanban surface.',
      sourceType: 'agent-authored',
      state: 'approved',
      proposedFor: workItemId,
      requiredScopes: ['boss:message', 'linear:read', 'linear:write'],
      surfaceClass: 'kanban',
      targetSurface: 'linear',
      operation: 'comment-and-close',
      createdAt: 1,
    });
  });
}

async function readSkill(harness: Harness, skillId: Id<'skills'>): Promise<Doc<'skills'>> {
  const row = await harness.run(async (ctx) => await ctx.db.get(skillId));
  if (!row) throw new Error('skill missing');
  return row;
}

describe('an authored body that uses a placeholder it never declared (live run 1, authoring 3)', (): void => {
  beforeEach((): void => {
    recorded.outputs.length = 0;
    recorded.sandboxRuns = 0;
  });

  afterEach((): void => {
    restoreSurfaceMode();
  });

  it('is the recorded draft: two placeholders used only in its example JSON, never declared', (): void => {
    expect(undeclaredSkillInputs(UNDECLARED_BODY_2026_09_19)).toEqual(UNDECLARED_NAMES_2026_09_19);
    expect(declaredSkillInputs(UNDECLARED_BODY_2026_09_19)).toContain('record-id');
  });

  it('is still refused before any sandbox in mock mode, as the recorded runs were', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const skillId = await seedApprovedSkill(harness);
    recorded.outputs.push({ body: UNDECLARED_BODY_2026_09_19, smokeTest: UNDECLARED_SMOKE_TEST_2026_09_19 });

    const result = await harness
      .withIdentity(OWNER)
      .action(api.skillActions.authorAndRegisterSkill, { skillId });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('SKILL.md uses `<closing-state-name>` without declaring it under `## Inputs`');
    expect(recorded.sandboxRuns).toBe(0);
  });

  it.fails('registers first time in real mode, each missing input declared and the repair named in the log', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const skillId = await seedApprovedSkill(harness);
    recorded.outputs.push({ body: UNDECLARED_BODY_2026_09_19, smokeTest: UNDECLARED_SMOKE_TEST_2026_09_19 });

    await expect(
      harness.withIdentity(OWNER).action(api.skillActions.authorAndRegisterSkill, { skillId }),
    ).resolves.toEqual({ ok: true });

    expect(recorded.sandboxRuns).toBe(1);
    const registered = await readSkill(harness, skillId);
    expect(registered.state).toBe('registered');
    expect(undeclaredSkillInputs(registered.body)).toEqual([]);
    expect(declaredSkillInputs(registered.body)).toEqual(expect.arrayContaining(UNDECLARED_NAMES_2026_09_19));
    // Declared where the author declared the rest, and nothing else of the body moved.
    const inputs = registered.body.slice(registered.body.indexOf('## Inputs'), registered.body.indexOf('## Procedure'));
    expect(inputs).toContain('`<closing-state-name>`');
    expect(inputs).toContain('`<reply-text>`');
    expect(registered.body.replace(/\n- `<(?:closing-state-name|reply-text)>`[^\n]*/g, '')).toBe(UNDECLARED_BODY_2026_09_19);
    expect(registered.verificationLog).toContain('SKILL.md used `<closing-state-name>` and `<reply-text>` without declaring them');
    expect(registered.verificationLog).toContain('ran in the local sandbox');
  });
});
