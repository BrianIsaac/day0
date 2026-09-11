import type { GenericId, Validator } from 'convex/values';
import type { GenericMutationCtx } from 'convex/server';
import schema from '../../convex/schema';

type AnyValidator = Validator<unknown, 'required' | 'optional', string>;

type TableName = keyof typeof schema.tables & string;

type SchemaCtx = GenericMutationCtx<never>;

/**
 * Names of every table whose `agentId` field is an id into `agents`.
 *
 * Read from the schema at runtime so a table added later is covered by the
 * tests that call this without anyone remembering to list it.
 *
 * Returns:
 *   Sorted table names.
 */
export function agentKeyedTables(): TableName[] {
  return (Object.keys(schema.tables) as TableName[])
    .filter((name): boolean => {
      const fields = fieldsOf(schema.tables[name].validator as AnyValidator);
      const agentId = fields?.agentId as { kind: string; tableName?: string } | undefined;
      return agentId?.kind === 'id' && agentId.tableName === 'agents';
    })
    .sort();
}

function fieldsOf(validator: AnyValidator): Record<string, AnyValidator> | undefined {
  return validator.kind === 'object'
    ? (validator as unknown as { fields: Record<string, AnyValidator> }).fields
    : undefined;
}

/**
 * Insert the smallest row the schema validator accepts into one table.
 *
 * Required fields take a placeholder of their kind; `agentId` takes the given
 * agent, and every other required id is satisfied by inserting a minimal row
 * of the referenced table first. Optional fields are left out.
 *
 * Args:
 *   ctx: Mutation context from `harness.run`.
 *   table: Table to insert into.
 *   agentId: Agent every agent-keyed row is attributed to.
 *
 * Returns:
 *   The inserted row id.
 */
export async function insertMinimalRow(
  ctx: SchemaCtx,
  table: TableName,
  agentId: GenericId<'agents'>,
): Promise<string> {
  const row = await minimalValue(ctx, schema.tables[table].validator as AnyValidator, agentId);
  return await (ctx.db as unknown as { insert: (t: string, r: unknown) => Promise<string> }).insert(
    table,
    row,
  );
}

async function minimalValue(
  ctx: SchemaCtx,
  validator: AnyValidator,
  agentId: GenericId<'agents'>,
): Promise<unknown> {
  switch (validator.kind) {
    case 'string':
      return 'fixture';
    case 'float64':
      return 1;
    case 'int64':
      return 1n;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'any':
      return null;
    case 'bytes':
      return new ArrayBuffer(0);
    case 'literal':
      return (validator as unknown as { value: unknown }).value;
    case 'array':
      return [];
    case 'record':
      return {};
    case 'union': {
      const [first] = (validator as unknown as { members: AnyValidator[] }).members;
      return await minimalValue(ctx, first, agentId);
    }
    case 'object': {
      const row: Record<string, unknown> = {};
      for (const [name, field] of Object.entries(fieldsOf(validator) ?? {})) {
        if (field.isOptional === 'optional') continue;
        row[name] = await minimalValue(ctx, field, agentId);
      }
      return row;
    }
    case 'id': {
      const target = (validator as unknown as { tableName: TableName }).tableName;
      if (target === 'agents') return agentId;
      return await insertMinimalRow(ctx, target, agentId);
    }
    default:
      throw new Error(`No fixture for validator kind ${validator.kind}`);
  }
}
