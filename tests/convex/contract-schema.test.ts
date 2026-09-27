/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';

describe('the contract schema', (): void => {
  it('declares every index the checked-in surfaces table declares', (): void => {
    expect(contractSchema().tables.surfaces[' indexes']()).toEqual(
      schema.tables.surfaces[' indexes'](),
    );
  });

  it('answers a read by credential id, as the documentation sync makes one', async (): Promise<void> => {
    const harness = convexTest(contractSchema(), allConvexModules());
    const found = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'contract',
        state: 'active',
        createdAt: 1,
      });
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'connected',
        whereFound: [],
        credentialLanded: true,
        credentialId: 'cred-linear',
        createdAt: 1,
      } as never);
      return await ctx.db
        .query('surfaces')
        .withIndex('by_credentialId', (q) => q.eq('credentialId', 'cred-linear' as never))
        .collect();
    });
    expect(found.map((surface) => surface.slug)).toEqual(['linear']);
  });
});
