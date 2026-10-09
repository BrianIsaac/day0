import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { managerIdentity } from './fakes/manager-identity';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

afterEach((): void => {
  restoreSurfaceMode();
});

/** An employee of `owner` with an approved charter, a draft after it, and one of each row. */
async function seedEmployee(harness: TestConvex<typeof schema>): Promise<Id<'agents'>> {
  return await harness.run(async (ctx): Promise<Id<'agents'>> => {
    await ctx.db.insert('docSources', {
      userId: 'owner',
      label: 'RevOps runbooks',
      kind: 'folder',
      locator: '/docs',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    const unticked = await ctx.db.insert('docSources', {
      userId: 'owner',
      label: 'Finance drive',
      kind: 'folder',
      locator: '/finance',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'sam@revops.example',
      name: 'Mira',
      userId: 'owner',
      state: 'active',
      zone: 'UTC',
      excludedDocSourceIds: [unticked],
      createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId,
      version: '0.1',
      approved: true,
      approvedAt: Date.UTC(2026, 8, 26),
      body: { proposedFunction: 'Own triage for tier-2 asks.' },
      createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId,
      version: '0.2',
      approved: false,
      body: { proposedFunction: 'A draft nobody approved.' },
      createdAt: 2,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      title: 'Reply',
      contentSummary: 'Reply.',
      sourceSystem: 'slack',
      sourceCategory: 'chat',
      externalId: 'T1',
      observedAt: 1,
      contentRefs: [],
      state: 'completed',
      createdAt: 1,
    });
    for (const [text, retiredAt] of [
      ['Name the ticket in every reply.', undefined],
      ['A correction the manager retired.', 5],
    ] as const) {
      await ctx.db.insert('corrections', {
        agentId,
        workItemId,
        kind: 'retry-note',
        text,
        itemTitle: 'Reply',
        sourceCategory: 'chat',
        sourceSystem: 'slack',
        surfaces: [],
        createdAt: 1,
        appliedTo: [],
        ...(retiredAt !== undefined ? { retiredAt } : {}),
      });
    }
    for (const [statement, status, binding] of [
      ['Thread every reply under the ask.', 'active', agentId],
      ['Name the ticket in the first line, for every employee.', 'active', undefined],
      ['A proposal the manager has not kept.', 'proposed', agentId],
    ] as const) {
      await ctx.db.insert('workingAgreements', {
        userId: 'owner',
        ...(binding !== undefined ? { agentId: binding } : {}),
        kind: 'preference',
        statement,
        scope: 'global',
        sourceType: 'plan-approval',
        status,
        createdAt: 1,
        appliedTo: [],
      });
    }
    for (const [name, state] of [
      ['see-internal-docs', 'registered'],
      ['chat-thread-reply', 'proposed'],
    ] as const) {
      await ctx.db.insert('skills', {
        agentId,
        name,
        description: name,
        body: '',
        sourceType: 'builtin',
        state,
        createdAt: 1,
      });
    }
    return agentId;
  });
}

describe('memoryProjection.forAgent', (): void => {
  it('projects the approved charter, the kept agreements and corrections, the registered skills and the inherited documentation', async (): Promise<void> => {
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const { text, cut } = await harness
      .withIdentity(managerIdentity('owner', { email: 'sam@revops.example' }))
      .query(api.memoryProjection.forAgent, { agentId });
    expect(cut).toBe(false);
    expect(text).toContain('Charter 0.1, approved 26 Sep 2026: Own triage for tier-2 asks.');
    expect(text).not.toContain('A draft nobody approved.');
    expect(text.split('\n')).toContain(
      'Working agreements: Thread every reply under the ask.; Name the ticket in the first line, for every employee.',
    );
    expect(text).not.toContain('A proposal the manager has not kept.');
    expect(text).toContain('Lessons from your corrections: Name the ticket in every reply.');
    expect(text).not.toContain('retired');
    expect(text).toContain('Skills: see-internal-docs (built in)');
    expect(text).not.toContain('chat-thread-reply');
    expect(text).toContain('Documentation: RevOps runbooks');
    expect(text).not.toContain('Finance drive');
  });

  it.each([
    [
      'mock',
      "Connections: the hosted office's Slack, Spreadsheet, Docs, Tickets and Social. Acts as: Mira, its own app in this office",
    ],
    ['real', 'Connections: none yet'],
  ] as const)(
    'says in %s mode what the Surfaces tab says of the connections (round 0141 R-D item 3)',
    async (mode, line): Promise<void> => {
      useSurfaceMode(mode);
      const { api } = await import('../../convex/_generated/api');
      const harness = convexTest(schema, allConvexModules());
      const agentId = await seedEmployee(harness);
      const { text } = await harness
        .withIdentity(managerIdentity('owner', { email: 'sam@revops.example' }))
        .query(api.memoryProjection.forAgent, { agentId });
      expect(text.split('\n')).toContain(line);
    },
  );

  it('refuses a caller who does not own the employee', async (): Promise<void> => {
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    await expect(
      harness
        .withIdentity(managerIdentity('intruder'))
        .query(api.memoryProjection.forAgent, { agentId }),
    ).rejects.toThrow();
  });
});
