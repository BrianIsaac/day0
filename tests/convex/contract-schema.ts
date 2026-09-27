import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import schema from '../../convex/schema';

/** A table that indexes can be added to by name, whatever its field types. */
interface Indexable {
  index(name: string, fields: readonly string[]): Indexable;
}

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
  const widened = defineTable({
    ...schema.tables.surfaces.validator.fields,
    credentialId: v.optional(v.string()),
  });
  // Every index the checked-in table declares, read off it, so the widened
  // table can never lack one a query uses (`by_credentialId` was missed once).
  const surfaces = schema.tables.surfaces[' indexes']().reduce<Indexable>(
    (table, { indexDescriptor, fields }) => table.index(indexDescriptor, fields),
    widened as unknown as Indexable,
  );
  return defineSchema({
    ...schema.tables,
    surfaces: surfaces as unknown as typeof widened,
  }) as unknown as typeof schema;
}
