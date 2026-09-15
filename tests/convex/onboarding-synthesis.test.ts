/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { DAY_ONE_TRANSCRIPT_2026_09_14 } from '../fixtures/day-one-transcript-2026-09-14';
import type { Charter } from '../../src/agent/charter';
import {
  CLEAN_CLAUSES_2026_09_16,
  GLM_DRAFT_2026_09_16,
  PROVENANCE_SUFFIX_2026_09_16,
} from '../fixtures/charter-glm-draft-2026-09-16';

/**
 * The model, scripted per agent: the labeller files the seven questions in
 * order, the charter agent answers with the 14 September clauses. The
 * synthesised constraints are whatever the test sets before the call.
 */
const scripted = vi.hoisted(() => ({
  constraints: [] as Array<{ kind: string; quote: string; wording: string[] }>,
  charterPrompts: [] as string[],
  systemPrompts: {} as Record<string, string>,
  /** When set, the charter agent answers with this payload instead of the 14 September clauses. */
  draft: undefined as unknown,
}));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string, instructions: string): { name: string } => {
    scripted.systemPrompts[name] = instructions;
    return { name };
  },
  agentJson: async ({ agent, user }: { agent: { name: string }; user: string }): Promise<unknown> => {
    if (agent.name === 'day0-question-labeller') {
      const topics = [
        'why-this-hire',
        'role-and-goals',
        'collaborators',
        'reading',
        'tools',
        'immediate',
        'open-questions',
      ];
      return { labels: topics.map((topic, index) => ({ question: index + 1, topic })) };
    }
    if (agent.name === 'day0-charter') {
      scripted.charterPrompts.push(user);
      if (scripted.draft) return scripted.draft;
      return {
        whyThisHire: 'A small RevOps team is drowning in tier-2 asks during the Q3 close.',
        proposedFunction:
          'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps team.',
        evidence: [{ text: 'Formal work is in Linear, team REVOPS, project Q3 close.', source: '' }],
        shortTermGoals: { day30: 'Clean drafts on tickets.', day60: 'Own routine tickets.', day90: 'Cover close-week tracker maintenance.' },
        proposedBoundaries: {
          willDo: ['Handle owned, prioritized Linear tickets in the Q3 close project.', 'Draft replies to asks in #revops-asks.'],
          willNotDo: ['Post to public Slack channels.'],
          escalationTriggers: ['A ticket outside the Q3 close project.'],
        },
        namedCollaborators: [{ name: 'Priya', topic: 'pipeline', introPath: 'manager' }],
        namedSystems: [
          { name: 'Linear', class: 'kanban', whereMentioned: 'Formal work is in Linear, team REVOPS, project Q3 close.' },
          { name: 'Slack', class: 'chat', whereMentioned: 'Asks arrive in Slack #revops-asks.' },
        ],
        priorityReading: ['team overview'],
        adjacentRoles: [],
        approvalChain: { boss: '', confidence: 'high' },
        openQuestions: ['Whether Northstar CRM access will be granted.', 'Who owns the Looker pipeline tile.'],
        constraints: scripted.constraints,
      };
    }
    throw new Error(`unexpected agent ${agent.name}`);
  },
  agentText: async (): Promise<string> => '',
}));

afterEach((): void => {
  scripted.constraints = [];
  scripted.charterPrompts = [];
  scripted.draft = undefined;
  restoreSurfaceMode();
});

async function deployAgent(harness: TestConvex<typeof schema>): Promise<Id<'agents'>> {
  return await harness.run(async (ctx) =>
    await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'worker 1',
      userId: 'owner',
      state: 'day-one-in-progress',
      createdAt: 1,
    }),
  );
}

async function synthesise(): Promise<Doc<'charters'>> {
  const harness = convexTest(schema, allConvexModules());
  const agentId = await deployAgent(harness);
  const owner = harness.withIdentity({ subject: 'owner' });
  const result = await owner.action(api.onboarding.synthesiseFromTranscript, {
    agentId,
    bossLabel: 'Brian',
    transcript: DAY_ONE_TRANSCRIPT_2026_09_14,
  });
  if (result.outcome !== 'synthesised') throw new Error(`outcome ${result.outcome}`);
  const charter = await harness.run(async (ctx) => await ctx.db.get(result.charterId as Id<'charters'>));
  if (!charter) throw new Error('no charter');
  return charter;
}

describe('charter synthesis from the 14 September transcript', (): void => {
  it('asks the model for the constraints beside the clauses', async (): Promise<void> => {
    useSurfaceMode('mock');
    await synthesise();
    expect(scripted.charterPrompts).toHaveLength(1);
    expect(scripted.charterPrompts[0]).toContain("if it's a ticket it has an owner and a priority");
  });

  it('carries the constraint the model listed, in the manager\'s own words', async (): Promise<void> => {
    useSurfaceMode('mock');
    scripted.constraints = [
      {
        kind: 'candidate-property',
        quote: "if it's a ticket it has an owner and a priority",
        wording: ['owned, prioritized'],
      },
      { kind: 'system-boundary', quote: 'Never post to public channels.', wording: ['Post to public Slack channels.'] },
    ];
    const charter = await synthesise();
    const body = charter.body as { constraints: unknown[]; proposedBoundaries: { willDo: string[] } };
    expect(body.constraints).toEqual([
      {
        kind: 'candidate-property',
        quote: "if it's a ticket it has an owner and a priority",
        wording: ['owned, prioritized'],
        origin: 'synthesis',
      },
      {
        kind: 'system-boundary',
        quote: 'Never post to public channels.',
        wording: ['Post to public Slack channels.'],
        origin: 'synthesis',
      },
    ]);
    expect(body.proposedBoundaries.willDo[0]).toContain('owned, prioritized');
    expect(charter.approved).toBe(false);
    expect(charter.version).toBe('0.0');
  });

  it('derives the ticket-owner constraint from the transcript when the model lists none', async (): Promise<void> => {
    useSurfaceMode('mock');
    const charter = await synthesise();
    const body = charter.body as { constraints: Array<{ quote: string; wording: string[]; origin: string }> };
    expect(body.constraints).toEqual([
      {
        kind: 'candidate-property',
        quote: "if it's a ticket it has an owner and a priority",
        wording: ['owned', 'prioritized'],
        origin: 'derived',
      },
    ]);
  });
});

describe('provenance suffixes on clauses', (): void => {
  it('tells the synthesiser that clauses carry no provenance suffix', async (): Promise<void> => {
    useSurfaceMode('mock');
    await synthesise();
    expect(scripted.systemPrompts['day0-charter']).toContain('no provenance suffix');
    expect(scripted.systemPrompts['day0-charter']).toContain('(from manager 1:1 day-1)');
  });

  it('strips the suffix GLM wrote on every clause of the 16 September draft and still verifies the constraint', async (): Promise<void> => {
    useSurfaceMode('mock');
    scripted.draft = GLM_DRAFT_2026_09_16;
    const charter = await synthesise();
    const body = charter.body as Charter;
    expect(body.proposedFunction).toBe(CLEAN_CLAUSES_2026_09_16.proposedFunction);
    expect(body.whyThisHire).toBe(CLEAN_CLAUSES_2026_09_16.whyThisHire);
    expect(body.proposedBoundaries).toEqual({
      willDo: CLEAN_CLAUSES_2026_09_16.willDo,
      willNotDo: CLEAN_CLAUSES_2026_09_16.willNotDo,
      escalationTriggers: CLEAN_CLAUSES_2026_09_16.escalationTriggers,
    });
    expect(body.evidence).toEqual([{ text: CLEAN_CLAUSES_2026_09_16.evidenceText, source: 'from manager 1:1 day-1' }]);
    expect(body.shortTermGoals).toEqual(CLEAN_CLAUSES_2026_09_16.shortTermGoals);
    expect(body.priorityReading).toEqual(CLEAN_CLAUSES_2026_09_16.priorityReading);
    expect(JSON.stringify(body)).not.toContain(PROVENANCE_SUFFIX_2026_09_16.trim());
    expect(body.constraints?.[0]).toEqual({
      kind: 'system-boundary',
      quote: 'Never post to public channels.',
      wording: ['Post to public Slack channels.'],
      origin: 'synthesis',
    });
  });
});
