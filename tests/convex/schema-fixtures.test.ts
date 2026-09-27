/** @vitest-environment node */

import { convexTest } from 'convex-test';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { describe, expect, it } from 'vitest';
import { allConvexModules } from './all-modules';
import { agentKeyedTables, insertMinimalRow } from './schema-fixtures';

/** A schema with a table keyed on an optional agent id, as a migration's widen step declares one. */
const widened = defineSchema({
  agents: defineTable({ name: v.string() }),
  workingAgreements: defineTable({ agentId: v.optional(v.id('agents')), text: v.string() }),
  notes: defineTable({ text: v.string() }),
});

describe('the schema fixtures', (): void => {
  it('find a table keyed on an optional agent id and give its row the agent', async (): Promise<void> => {
    expect(agentKeyedTables(widened.tables)).toEqual(['workingAgreements']);
    const harness = convexTest(widened, allConvexModules());
    const row = await harness.run(async (ctx) => {
      const agentId = await ctx.db.insert('agents', { name: 'fixture' });
      const id = await insertMinimalRow(
        ctx as never,
        'workingAgreements' as never,
        agentId as never,
        widened.tables,
      );
      return { agentId, row: await ctx.db.get(id as never) };
    });
    expect(row.row).toMatchObject({ agentId: row.agentId, text: 'fixture' });
  });
});
