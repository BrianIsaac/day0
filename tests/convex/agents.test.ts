import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { convexModules } from './modules';

afterEach((): void => {
  vi.useRealTimers();
});

describe('agent documentation selection', (): void => {
  it('refuses a source owned by another caller', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, convexModules);
    const sourceId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('docSources', {
          userId: 'other-owner',
          label: 'Private docs',
          kind: 'folder',
          locator: '.',
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.mutation(api.agents.deploy, {
        bossEmail: 'boss@day0.local',
        name: 'foreign source test',
        docSourceIds: [sourceId],
      }),
    ).rejects.toThrow('owned by another user');
  });

  it('persists an owned source selection', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, convexModules);
    const sourceId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('docSources', {
          userId: 'owner',
          label: 'Team docs',
          kind: 'folder',
          locator: '.',
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    const owner = harness.withIdentity({ subject: 'owner' });
    const agentId = await owner.mutation(api.agents.deploy, {
      bossEmail: 'boss@day0.local',
      name: 'owned source test',
      docSourceIds: [sourceId],
    });
    await expect(owner.query(api.agents.get, { agentId })).resolves.toMatchObject({
      docSourceIds: [sourceId],
    });
  });
});
