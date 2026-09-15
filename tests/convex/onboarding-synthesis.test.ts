/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { DAY_ONE_TRANSCRIPT_2026_09_14 } from '../fixtures/day-one-transcript-2026-09-14';

/**
 * The model, scripted per agent: the labeller files the seven questions in
 * order, the charter agent answers with the 14 September clauses. The
 * synthesised constraints are whatever the test sets before the call.
 */
const scripted = vi.hoisted(() => ({
  constraints: [] as Array<{ kind: string; quote: string; wording: string[] }>,
  charterPrompts: [] as string[],
}));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
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
  restoreSurfaceMode();
});

async function deployAgent(harness: ReturnType<typeof convexTest<typeof schema>>): Promise<Id<'agents'>> {
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
  expect(result.outcome).toBe('synthesised');
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
