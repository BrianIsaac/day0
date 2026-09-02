import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import schema from '../../convex/schema';

/**
 * The checked-in schema with `surfaces.credentialId` widened to any string,
 * so an apply-path test can seed a surface whose credential id is a label the
 * fake decrypt recognises (`cred-linear`) rather than a real `credentials`
 * row. Every other field is the checked-in validator.
 *
 * Returns:
 *   A schema whose `surfaces` table accepts a string credential id.
 */
export function contractSchema(): typeof schema {
  const surfaces = defineTable({
    ...schema.tables.surfaces.validator.fields,
    credentialId: v.optional(v.string()),
  })
    .index('by_agent', ['agentId'])
    .index('by_agent_slug', ['agentId', 'slug'])
    .index('by_class', ['class']);
  return defineSchema({ ...schema.tables, surfaces }) as unknown as typeof schema;
}
