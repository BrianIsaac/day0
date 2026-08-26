import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import schema from '../../convex/schema';

/**
 * The checked-in schema with the surface fields the Phase 2 interface
 * contract assigns to lane B (`credentialId`, `credentialKind`,
 * `managerDmChannelId`). The executors read them off the row; until lane B's
 * schema block lands, tests seed them through this extension so the apply
 * path can be driven end to end against the agreed shape.
 *
 * Returns:
 *   A schema whose `surfaces` table accepts the contract fields.
 */
export function contractSchema(): typeof schema {
  const surfaces = defineTable({
    ...schema.tables.surfaces.validator.fields,
    credentialId: v.optional(v.string()),
    credentialKind: v.optional(v.string()),
    managerDmChannelId: v.optional(v.string()),
  })
    .index('by_agent', ['agentId'])
    .index('by_agent_slug', ['agentId', 'slug']);
  return defineSchema({ ...schema.tables, surfaces }) as unknown as typeof schema;
}
