/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { parseTranscript } from '../../convex/onboarding';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/agent/good-habits', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/agent/good-habits')>();
  return {
    ...original,
    researchAndDistil: async (): Promise<import('../../src/agent/good-habits').GoodHabitsResult> => ({
      fragment: '',
      results: [],
      norms: 0,
      skipped: true,
      skipReason: 'research disabled in tests',
    }),
  };
});

vi.mock('../../src/agent/work-generator', () => ({
  generateWorkItemsFromCharter: async (): Promise<
    import('../../src/agent/work-generator').GeneratedWorkItem[]
  > =>
    ['REVOPS-1', 'REVOPS-2', 'REVOPS-3'].map((externalId, index) => ({
      sourceCategory: 'ticket-queue',
      sourceSystem: 'tickets',
      externalId,
      title: `Synthetic work item ${index + 1} for the charter approval test`,
      contentSummary: 'Synthetic summary.',
      contentRefs: [],
      priority: 'P2',
      requesterLabel: 'Manager',
    })),
}));

afterEach((): void => {
  restoreSurfaceMode();
});

/**
 * Seed an owned agent with an approved charter naming two systems.
 *
 * Args:
 *   harness: Convex test harness.
 *
 * Returns:
 *   The agent and charter ids.
 */
async function seedApprovedCharter(
  harness: TestConvex<typeof schema>,
): Promise<{ agentId: Id<'agents'>; charterId: Id<'charters'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'charter approval test',
      userId: 'owner',
      state: 'charter-pending',
      createdAt: 1,
    });
    const charterId = await ctx.db.insert('charters', {
      agentId,
      version: 'v1',
      approved: true,
      approvedAt: 1,
      createdAt: 1,
      body: {
        version: 'v1',
        source: 'day-one 1:1',
        whyThisHire: 'Close the quarter.',
        proposedFunction: 'Revenue operations analyst',
        evidence: [],
        shortTermGoals: { firstWeek: [], firstMonth: [], firstQuarter: [] },
        proposedBoundaries: { alwaysDo: [], neverDo: [], askFirst: [] },
        namedCollaborators: [],
        namedSystems: [
          { name: 'Linear', class: 'kanban', whereMentioned: 'Formal work is in Linear.' },
          { name: 'Slack', class: 'chat', whereMentioned: 'Asks arrive in Slack.' },
        ],
        priorityReading: [],
        adjacentRoles: [],
        approvalChain: { primary: 'boss', escalation: [] },
        openQuestions: [],
        createdAt: '2026-08-26T00:00:00.000Z',
      },
    });
    return { agentId, charterId };
  });
}

/**
 * Read the rows charter approval may have produced.
 *
 * Args:
 *   harness: Convex test harness.
 *   agentId: Agent under test.
 *
 * Returns:
 *   Surface verdicts, work item count and event types.
 */
async function outcome(
  harness: TestConvex<typeof schema>,
  agentId: Id<'agents'>,
): Promise<{ surfaces: string[]; workItems: number; events: string[] }> {
  return await harness.run(async (ctx) => {
    const surfaces = await ctx.db
      .query('surfaces')
      .withIndex('by_agent', (index) => index.eq('agentId', agentId))
      .collect();
    const workItems = (await ctx.db.query('workItems').collect()).filter(
      (item): boolean => item.agentId === agentId,
    );
    const events = await ctx.db.query('events').collect();
    return {
      surfaces: surfaces.map((surface): string => `${surface.slug}:${surface.verdict}`).sort(),
      workItems: workItems.length,
      events: events.map((event): string => event.type),
    };
  });
}

describe('onboarding transcript parsing', (): void => {
  it('preserves labelled manager and agent ownership', (): void => {
    expect(
      parseTranscript(
        'ASSISTANT: Where does work live?\nUSER: Linear and Slack.\ncontinued detail',
      ),
    ).toEqual([
      { role: 'agent', text: 'Where does work live?' },
      { role: 'manager', text: 'Linear and Slack.\ncontinued detail' },
    ]);
  });

  it('drops text that has no preceding speaker', (): void => {
    expect(parseTranscript('unattributed\nUSER: owned answer')).toEqual([
      { role: 'manager', text: 'owned answer' },
    ]);
  });
});

describe('charter approval by surface mode', (): void => {
  it('in mock mode seeds the three-item generator and files no surfaces', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedApprovedCharter(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.action(api.onboarding.postCharterApproval, { agentId, charterId }),
    ).resolves.toEqual({ norms: 0, workItemsGenerated: 3 });
    const result = await outcome(harness, agentId);
    expect(result.surfaces).toEqual([]);
    expect(result.workItems).toBe(3);
    expect(result.events).toContain('work.charter-derived');
    expect(result.events).not.toContain('surface.oriented');
  });

  it('in real mode declares and orients the named systems and generates no mock work', async (): Promise<void> => {
    vi.useFakeTimers();
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedApprovedCharter(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.action(api.onboarding.postCharterApproval, { agentId, charterId }),
    ).resolves.toEqual({ norms: 0, workItemsGenerated: 0 });
    const declared = await outcome(harness, agentId);
    expect(declared.surfaces).toEqual(['linear:declared', 'slack:declared']);
    expect(declared.events).not.toContain('surface.oriented');
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    const result = await outcome(harness, agentId);
    expect(result.surfaces).toEqual(['linear:absent', 'slack:absent']);
    expect(result.workItems).toBe(0);
    expect(result.events).not.toContain('work.charter-derived');
    expect(result.events.filter((type) => type === 'surface.oriented')).toHaveLength(2);
  });
});
