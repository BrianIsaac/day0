/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { CHARTER_SEEDING_ATTEMPTS, parseTranscript } from '../../convex/onboarding';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';

/** The charter the fake drafter returns, when a test gives one, and the prompts it was sent. */
const drafter = vi.hoisted(() => ({ reply: undefined as unknown, prompts: [] as string[] }));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async ({ agent, user }: { agent: { name: string }; user: string }) => {
    if (agent.name !== 'day0-charter' || drafter.reply === undefined) {
      throw new Error('model unavailable in tests');
    }
    drafter.prompts.push(user);
    return drafter.reply;
  },
  agentText: async (): Promise<string> => '',
}));

/**
 * What the mocked generator adds after its three items, when a test needs a bad one; whether it
 * was called; and a gate it waits on first, when a test holds the model call open.
 */
const generator = vi.hoisted(() => ({
  extra: [] as unknown[],
  calls: 0,
  gate: undefined as Promise<void> | undefined,
}));

vi.mock('../../src/agent/work-generator', () => ({
  generateWorkItemsFromCharter: async (): Promise<
    import('../../src/agent/work-generator').GeneratedWorkItem[]
  > => {
    generator.calls += 1;
    await generator.gate;
    return generatedItems();
  },
}));

/** The three items the mocked generator drafts, and any extra a test gave it. */
function generatedItems(): import('../../src/agent/work-generator').GeneratedWorkItem[] {
  return [
    ...['REVOPS-1', 'REVOPS-2', 'REVOPS-3'].map((externalId, index) => ({
      sourceCategory: 'ticket-queue',
      sourceSystem: 'tickets',
      externalId,
      title: `Synthetic work item ${index + 1} for the charter approval test`,
      contentSummary: 'Synthetic summary.',
      contentRefs: [],
      priority: 'P2',
      requesterLabel: 'Manager',
    })),
    ...(generator.extra as import('../../src/agent/work-generator').GeneratedWorkItem[]),
  ];
}

afterEach((): void => {
  generator.extra = [];
  generator.calls = 0;
  generator.gate = undefined;
  drafter.reply = undefined;
  drafter.prompts.length = 0;
  restoreSurfaceMode();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
      bossEmail: MANAGER_ADDRESS,
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
    await expect(
      harness.action(internal.onboarding.postCharterApproval, { agentId, charterId }),
    ).resolves.toEqual({ workItemsGenerated: 3 });
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
    await expect(
      harness.action(internal.onboarding.postCharterApproval, { agentId, charterId }),
    ).resolves.toEqual({ workItemsGenerated: 0 });
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

  it.each(['mock', 'real'] as const)(
    // The fetch spy guards nothing reachable here (review M6); the events and AGENTS.md prove it.
    'in %s mode completes with no research step and writes no good-habits memory',
    async (mode): Promise<void> => {
      vi.useFakeTimers();
      useSurfaceMode(mode);
      const webCall = vi.fn(async (): Promise<Response> => {
        throw new Error('no network in tests');
      });
      vi.stubGlobal('fetch', webCall);
      const harness = convexTest(schema, allConvexModules());
      const { agentId, charterId } = await seedApprovedCharter(harness);
      const owner = harness.withIdentity(managerIdentity());
      await harness.action(internal.onboarding.postCharterApproval, { agentId, charterId });
      await harness.finishAllScheduledFunctions(vi.runAllTimers);
      const result = await outcome(harness, agentId);
      expect(webCall).not.toHaveBeenCalled();
      expect(result.events.filter((type): boolean => type.startsWith('good-habits'))).toEqual([]);
      const agentsMd = await owner.query(api.workspace.readFile, {
        agentId,
        fileName: 'AGENTS.md',
      });
      expect(agentsMd).not.toMatch(/Good-habits memory/i);
    },
  );
});

describe('seeding an approved charter on the server (P5-6)', (): void => {
  /** Make the named systems unreadable to the seeding mutation, so every attempt throws. */
  async function breakNamedSystems(
    harness: TestConvex<typeof schema>,
    charterId: Id<'charters'>,
  ): Promise<void> {
    await harness.run(async (ctx) => {
      const row = await ctx.db.get(charterId);
      if (!row) throw new Error('charter missing');
      await ctx.db.patch(charterId, {
        body: { ...(row.body as object), namedSystems: [{ name: 7 }] },
      });
    });
  }

  /** The seeding-failed events' payloads, oldest first. */
  async function seedingFailures(harness: TestConvex<typeof schema>): Promise<unknown[]> {
    return (await harness.run(async (ctx) => await ctx.db.query('events').collect()))
      .filter((event) => event.type === 'charter.seeding-failed')
      .map((event) => event.payload);
  }

  it('records why a seeding failed and tries again, then stops saying so', async (): Promise<void> => {
    vi.useFakeTimers();
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedApprovedCharter(harness);
    await breakNamedSystems(harness, charterId);

    const first = await harness.action(internal.onboarding.postCharterApproval, {
      agentId,
      charterId,
    });
    expect(first).toMatchObject({ failed: expect.any(String) });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    const failures = await seedingFailures(harness);
    expect(failures).toHaveLength(CHARTER_SEEDING_ATTEMPTS);
    expect(failures.map((payload) => (payload as { attempt: number }).attempt)).toEqual([1, 2, 3]);
    expect(failures.map((payload) => (payload as { retrying: boolean }).retrying)).toEqual([
      true,
      true,
      false,
    ]);
    expect(failures[0]).toMatchObject({
      charterId,
      reason: expect.stringContaining('Validator error'),
    });
  });

  it("seeds all of the generator's items or none, so a retry never adds a second batch beside a partial first (U9 D4)", async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedApprovedCharter(harness);
    // A fourth item the seed refuses, after three it would take.
    generator.extra = [{ sourceCategory: 'ticket-queue', sourceSystem: 'tickets', title: 7 }];
    await expect(
      harness.action(internal.onboarding.postCharterApproval, { agentId, charterId }),
    ).resolves.toMatchObject({ failed: expect.any(String) });
    const result = await outcome(harness, agentId);
    expect(result.workItems).toBe(0);
    expect(result.events).not.toContain('work.charter-derived');
  });

  /**
   * Approve a charter (the caller sets mock mode) and hold its seeding at the model call, which never answers: a
   * seeding Convex ends at its 600 s limit runs no catch, which leaves the deployment as it is
   * here, mid-call (the 12-FX bed: two of five). Eleven minutes pass on the clock.
   */
  async function seedingHeldAtItsModelCall(): Promise<{
    harness: TestConvex<typeof schema>;
    agentId: Id<'agents'>;
  }> {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedApprovedCharter(harness);
    generator.gate = new Promise<void>(() => undefined);
    void harness.action(internal.onboarding.postCharterApproval, { agentId, charterId }); // never settles; the platform ends it
    await vi.waitFor(() => expect(generator.calls).toBe(1), { timeout: 20_000 });
    vi.advanceTimersByTime(11 * 60 * 1000);
    return { harness, agentId };
  }

  it("reaches the approved charter's model call with nothing seeded yet, the state a seeding killed at the limit leaves", async (): Promise<void> => {
    useSurfaceMode('mock');
    const { harness, agentId } = await seedingHeldAtItsModelCall();
    const result = await outcome(harness, agentId);
    expect(result.workItems).toBe(0);
    expect(result.events).not.toContain('work.charter-derived');
  });

  it.fails(
    // until wave 13 designs the cure (12-J item 6): a seeding Convex ends at its 600 s limit runs no catch, so nothing records it or tries again
    'records a seeding that died at the action limit and tries again, so the Work tab is not left empty and silent',
    async (): Promise<void> => {
      useSurfaceMode('mock');
      const { harness, agentId } = await seedingHeldAtItsModelCall();
      const result = await outcome(harness, agentId);
      const scheduled = await harness.run(
        async (ctx) => await ctx.db.system.query('_scheduled_functions').collect(),
      );
      const retried = scheduled.some((job) => job.name === 'onboarding:postCharterApproval');
      expect(retried || result.events.includes('charter.seeding-failed')).toBe(true);
    },
  );

  it('seeds nothing for a charter that is no longer the approved latest', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, charterId } = await seedApprovedCharter(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('charters', {
        agentId,
        version: 'v2',
        approved: false,
        createdAt: 2,
        body: {},
      });
    });
    await expect(
      harness.action(internal.onboarding.postCharterApproval, { agentId, charterId }),
    ).resolves.toEqual({ workItemsGenerated: 0 });
    expect(await seedingFailures(harness)).toEqual([]);
  });
});

describe('the mock office in the drafted charter (round 0141 R-D item 5)', (): void => {
  /** A drafted charter that lists the ticket queue the manager named, as the model returns it. */
  const DRAFT = {
    whyThisHire: 'Pipeline data needs an owner.',
    proposedFunction: 'Pipeline hygiene.',
    evidence: [],
    shortTermGoals: { day30: 'Close tickets.', day60: 'Keep the tracker.', day90: 'Own it.' },
    proposedBoundaries: {
      willDo: ['Close routine tickets.'],
      willNotDo: [],
      escalationTriggers: [],
    },
    namedCollaborators: [],
    namedSystems: [
      {
        name: 'the ticket queue',
        class: 'kanban',
        whereMentioned: 'Work is tracked in the ticket queue.',
      },
      { name: 'Slack', class: 'chat', whereMentioned: 'Asks arrive in Slack.' },
    ],
    priorityReading: [],
    adjacentRoles: [],
    approvalChain: { boss: 'manager', confidence: 'high' },
    openQuestions: [],
    constraints: [],
  };

  const ANSWERS = Object.fromEntries(
    [
      'why-this-hire',
      'role-and-goals',
      'collaborators',
      'reading',
      'tools',
      'immediate',
      'open-questions',
    ].map((topic): [string, string] => [topic, 'Work is tracked in the ticket queue.']),
  );

  /** Draft a charter for a fresh employee under the mode the test set, and read its systems back. */
  async function draftedSystems(): Promise<string[]> {
    drafter.reply = DRAFT;
    const { api: modeApi } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name: 'Wren',
          userId: 'owner',
          state: 'deployed',
          createdAt: 1,
        }),
    );
    const { charterId } = await harness
      .withIdentity(managerIdentity())
      .action(modeApi.onboarding.synthesiseFromAnswers, {
        agentId,
        bossLabel: 'Sam',
        answers: ANSWERS,
      });
    const charter = await harness.run(async (ctx) => await ctx.db.get(charterId as Id<'charters'>));
    return ((charter?.body as { namedSystems?: Array<{ name: string }> }).namedSystems ?? []).map(
      (system) => system.name,
    );
  }

  it("lists the office's ticket queue among the systems named, told the office's systems", async (): Promise<void> => {
    useSurfaceMode('mock');
    expect(await draftedSystems()).toEqual(['Ticket queue', 'Slack']);
    expect(drafter.prompts.at(-1)).toContain('Ticket queue (kanban)');
  });

  it("leaves a real deployment's drafter as it was: a queue is a location, and no office is described", async (): Promise<void> => {
    useSurfaceMode('real');
    expect(await draftedSystems()).toEqual(['Slack']);
    expect(drafter.prompts.at(-1)).not.toContain('[office]');
  });
});
