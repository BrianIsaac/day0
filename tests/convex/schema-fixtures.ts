import type { GenericId, Validator } from 'convex/values';
import type { GenericMutationCtx } from 'convex/server';
import schema from '../../convex/schema';

type AnyValidator = Validator<unknown, 'required' | 'optional', string>;

type TableName = keyof typeof schema.tables & string;

/** A schema's tables, as the fixtures read them. */
type Tables = Readonly<Record<string, { validator: unknown }>>;

type SchemaCtx = GenericMutationCtx<never>;

/**
 * Names of every table whose `agentId` field is an id into `agents`, required
 * or optional.
 *
 * Read from the schema at runtime so a table added later is covered by the
 * tests that call this without anyone remembering to list it.
 *
 * Args:
 *   tables: The schema's tables; the checked-in schema's by default.
 *
 * Returns:
 *   Sorted table names.
 */
export function agentKeyedTables(tables: Tables = schema.tables): TableName[] {
  return (Object.keys(tables) as TableName[])
    .filter((name): boolean =>
      isAgentKey(fieldsOf(tables[name].validator as AnyValidator)?.agentId),
    )
    .sort();
}

/** Whether a field is an id into `agents`, whether or not it is optional. */
function isAgentKey(field: AnyValidator | undefined): boolean {
  const key = field as { kind: string; tableName?: string } | undefined;
  return key?.kind === 'id' && key.tableName === 'agents';
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
 * agent even where it is optional, so a table keyed on an optional agent id
 * still yields a row the reset must delete; every other required id is
 * satisfied by inserting a minimal row of the referenced table first. Other
 * optional fields are left out.
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
  tables: Tables = schema.tables,
): Promise<string> {
  const row = await minimalValue(ctx, tables[table]!.validator as AnyValidator, agentId, tables);
  return await (ctx.db as unknown as { insert: (t: string, r: unknown) => Promise<string> }).insert(
    table,
    row,
  );
}

async function minimalValue(
  ctx: SchemaCtx,
  validator: AnyValidator,
  agentId: GenericId<'agents'>,
  tables: Tables,
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
      return await minimalValue(ctx, first, agentId, tables);
    }
    case 'object': {
      const row: Record<string, unknown> = {};
      for (const [name, field] of Object.entries(fieldsOf(validator) ?? {})) {
        if (field.isOptional === 'optional' && !(name === 'agentId' && isAgentKey(field))) continue;
        row[name] = await minimalValue(ctx, field, agentId, tables);
      }
      return row;
    }
    case 'id': {
      const target = (validator as unknown as { tableName: TableName }).tableName;
      if (target === 'agents') return agentId;
      return await insertMinimalRow(ctx, target, agentId, tables);
    }
    default:
      throw new Error(`No fixture for validator kind ${(validator as { kind: string }).kind}`);
  }
}
