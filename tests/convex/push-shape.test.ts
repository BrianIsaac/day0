import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';

/**
 * The backend's rule for a field name inside an object validator, read from the pinned
 * `convex-backend` image (`docker-compose.yml`): "Identifiers must start with an alphabetic
 * character or underscore", "Identifiers can only contain alphanumeric characters or
 * underscores", and at most 64 characters. convex-test applies none of it, so a hyphenated key
 * passed every suite and was refused at the push (the wave 9 review's B1).
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A validator as `exportArgs`, `exportReturns` and the schema's export serialise it. */
interface ValidatorJson {
  readonly type: string;
  readonly value?: unknown;
  readonly keys?: unknown;
  readonly values?: { readonly fieldType: unknown };
}

/** A registered function as Convex's registration attaches its exports. */
interface RegisteredFunction {
  readonly exportArgs: () => string;
  readonly exportReturns: () => string;
}

function isValidatorJson(value: unknown): value is ValidatorJson {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function isRegisteredFunction(value: unknown): value is RegisteredFunction {
  return (
    typeof value === 'function' &&
    typeof (value as { exportArgs?: unknown }).exportArgs === 'function' &&
    typeof (value as { exportReturns?: unknown }).exportReturns === 'function'
  );
}

/**
 * Every object-validator field name under a validator that the backend would refuse, each as
 * the path to it.
 *
 * @param validator - The serialised validator, or null for a function with no `returns`.
 * @param path - Where the validator sits, for the failure line.
 */
function refusedFieldNames(validator: unknown, path: string): string[] {
  if (!isValidatorJson(validator)) return [];
  switch (validator.type) {
    case 'object': {
      const fields = Object.entries(
        (validator.value ?? {}) as Record<string, { readonly fieldType: unknown }>,
      );
      return fields.flatMap(([name, field]) => [
        ...(IDENTIFIER.test(name) ? [] : [`${path}.${name}`]),
        ...refusedFieldNames(field.fieldType, `${path}.${name}`),
      ]);
    }
    case 'union':
      return ((validator.value ?? []) as unknown[]).flatMap((member, index) =>
        refusedFieldNames(member, `${path}|${index}`),
      );
    case 'array':
      return refusedFieldNames(validator.value, `${path}[]`);
    case 'record':
      return [
        ...refusedFieldNames(validator.keys, `${path}{key}`),
        ...refusedFieldNames(validator.values?.fieldType, `${path}{value}`),
      ];
    default:
      return [];
  }
}

/**
 * Every function every Convex module registers, by the path the push names it with. The
 * generated files and `auth.config.ts` (the deployment's providers, read from its environment at
 * the push) register no function.
 */
async function registeredFunctions(): Promise<[string, RegisteredFunction][]> {
  const modules = Object.entries(allConvexModules()).filter(
    ([file]) => !file.includes('/_generated/') && !file.endsWith('/auth.config.ts'),
  );
  const loaded = await Promise.all(
    modules.map(async ([file, load]) => [file, (await load()) as Record<string, unknown>] as const),
  );
  return loaded.flatMap(([file, exports]) =>
    Object.entries(exports).flatMap(([name, value]): [string, RegisteredFunction][] =>
      isRegisteredFunction(value)
        ? [[`${file.replace(/^.*\/convex\//, '').replace(/\.ts$/, '')}:${name}`, value]]
        : [],
    ),
  );
}

describe('the validators a Convex backend reads at the push', (): void => {
  it('finds the functions it walks', async (): Promise<void> => {
    const functions = await registeredFunctions();

    expect(functions.map(([path]) => path)).toEqual(
      expect.arrayContaining([
        'agents:deploy',
        'transferAcceptance:transferPreview',
        'managerTransfers:ask',
      ]),
    );
  });

  it('names every field of every argument and returns validator as a backend identifier', async (): Promise<void> => {
    const refused = (await registeredFunctions()).flatMap(([path, fn]) => [
      ...refusedFieldNames(JSON.parse(fn.exportArgs()) as unknown, `${path} args`),
      ...refusedFieldNames(JSON.parse(fn.exportReturns()) as unknown, `${path} returns`),
    ]);

    expect(refused).toEqual([]);
  });

  it('names every field of every table in the schema as a backend identifier', (): void => {
    // `export` is the framework's (marked internal, so absent from the public type): the push
    // sends exactly this JSON.
    const { export: exportSchema } = schema as unknown as { readonly export: () => string };
    const exported = JSON.parse(exportSchema.call(schema)) as {
      readonly tables: readonly { readonly tableName: string; readonly documentType: unknown }[];
    };

    expect(
      exported.tables.flatMap((table) => refusedFieldNames(table.documentType, table.tableName)),
    ).toEqual([]);
  });

  it('refuses the names the backend refuses and passes the ones it takes', (): void => {
    const shape = (name: string): ValidatorJson => ({
      type: 'object',
      value: { [name]: { fieldType: { type: 'number' }, optional: false } },
    });

    expect(
      ['one-to-one', '1st', '', 'a'.repeat(65), 'with space'].flatMap((name) =>
        refusedFieldNames(shape(name), 'x'),
      ),
    ).toHaveLength(5);
    expect(
      ['oneToOne', '_id', '_creationTime', 'a'.repeat(64), 'snake_case2'].flatMap((name) =>
        refusedFieldNames(shape(name), 'x'),
      ),
    ).toEqual([]);
  });
});

describe('the generated api a push writes', (): void => {
  it("lists every module the backend serves, as code generation would (the round review's m18)", (): void => {
    const convex = join(__dirname, '../../convex');
    const generated = readFileSync(join(convex, '_generated/api.d.ts'), 'utf8');
    // Code generation skips the schema and the config files, whose names carry a second dot.
    const modules = readdirSync(convex)
      .filter((name) => name.endsWith('.ts') && name !== 'schema.ts' && !/\..*\./.test(name))
      .map((name) => name.slice(0, -'.ts'.length));
    expect(
      modules.filter(
        (module) =>
          !generated.includes(`import type * as ${module} from '../${module}.js';`) ||
          !generated.includes(`  ${module}: typeof ${module};`),
      ),
    ).toEqual([]);
  });
});
