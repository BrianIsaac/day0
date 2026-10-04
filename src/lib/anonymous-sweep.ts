import { CALLERLESS_FUNCTIONS, type CallerlessFunction } from './anonymous-access';

/**
 * The anonymous-caller sweep's two halves that the test and the check against a running
 * deployment share: the arguments a public function is asked with, built from its own argument
 * validator, and the judgement of what it answered (`src/lib/anonymous-access.ts` holds the rule).
 */

/** An argument validator as Convex exports it (`exportArgs`, the deployment's `apiSpec`). */
export type ValidatorJson =
  | IdValidatorJson
  | ScalarValidatorJson
  | LiteralValidatorJson
  | ArrayValidatorJson
  | RecordValidatorJson
  | ObjectValidatorJson
  | UnionValidatorJson;

/** `v.id(table)`. */
export interface IdValidatorJson {
  readonly type: 'id';
  readonly tableName: string;
}

/** A validator with no parameters. */
export interface ScalarValidatorJson {
  readonly type: 'string' | 'number' | 'bigint' | 'boolean' | 'bytes' | 'null' | 'any';
}

/** `v.literal(value)`, the value in Convex's JSON form. */
export interface LiteralValidatorJson {
  readonly type: 'literal';
  readonly value: unknown;
}

/** `v.array(element)`. */
export interface ArrayValidatorJson {
  readonly type: 'array';
  readonly value: ValidatorJson;
}

/** `v.record(keys, values)`. */
export interface RecordValidatorJson {
  readonly type: 'record';
  readonly keys: ValidatorJson;
  readonly values: FieldJson;
}

/** One field of an object validator. */
export interface FieldJson {
  readonly fieldType: ValidatorJson;
  readonly optional: boolean;
}

/** `v.object(fields)`, and a function's arguments. */
export interface ObjectValidatorJson {
  readonly type: 'object';
  readonly value: Readonly<Record<string, FieldJson>>;
}

/** `v.union(...members)`. */
export interface UnionValidatorJson {
  readonly type: 'union';
  readonly value: readonly ValidatorJson[];
}

/**
 * Names an existing row of a table, or undefined when there is none to name.
 *
 * @param table - The table an argument's id, or an id-named string argument, points into.
 */
export type RowOf = (table: string) => string | undefined;

/** What a string argument named `<noun>Id` points into, where the table is not the noun plus `s`. */
const STRING_ID_TABLES: Readonly<Record<string, string>> = {
  transferId: 'managerTransfers',
};

/**
 * The table a string argument names a row of, by its name: `agentId` names `agents`. Several
 * public functions take an id as a plain string so they can answer a stale or pasted link
 * themselves; the sweep fills those with a real row too.
 *
 * @param field - The argument's name.
 * @param tables - The deployment's table names.
 */
export function tableOfStringId(field: string, tables: ReadonlySet<string>): string | undefined {
  const named = STRING_ID_TABLES[field];
  if (named !== undefined) return tables.has(named) ? named : undefined;
  if (!field.endsWith('Id')) return undefined;
  const plural = `${field.slice(0, -'Id'.length)}s`;
  return tables.has(plural) ? plural : undefined;
}

/** The text a string argument carries when no row stands behind it. */
const PLACEHOLDER_TEXT = 'anonymous-sweep';

/**
 * The two shapes the sweep asks every function in, so neither an argument's emptiness nor which
 * member of a union it takes can reach a refusal before the guard:
 *
 * - `fullest`: one element in every array, a union's first member, every optional id filled and
 *   every other optional field left out, a string of placeholder text, one for a number;
 * - `emptiest`: every array and record empty, a union's last member, every optional field filled,
 *   an empty string, zero for a number and `true` for a boolean.
 *
 * In both, every id names a row `rowOf` gives, and so does every string argument named after a
 * table's id.
 */
export const ARGUMENT_SHAPES = ['fullest', 'emptiest'] as const;

/** One of {@link ARGUMENT_SHAPES}. */
export type ArgumentShape = (typeof ARGUMENT_SHAPES)[number];

/** What building one call's arguments reads. */
interface BuildContext {
  readonly rowOf: RowOf;
  readonly tables: ReadonlySet<string>;
  readonly shape: ArgumentShape;
}

/**
 * Arguments a function's validator accepts, in one of the {@link ARGUMENT_SHAPES}, so the call
 * passes the validator and reaches the handler, where the guard must stand first.
 *
 * @param validator - The function's argument validator.
 * @param rowOf - The row an id of a table names.
 * @param tables - The deployment's table names, for id-named string arguments.
 * @param shape - Which of the two shapes; `fullest` unless named.
 * @throws Error when an id's table has no row to name: the validator would refuse the call before
 *   its handler ran, which proves nothing about the guard.
 */
export function argumentsFor(
  validator: ValidatorJson,
  rowOf: RowOf,
  tables: ReadonlySet<string>,
  shape: ArgumentShape = 'fullest',
): unknown {
  return valueFor(validator, undefined, { rowOf, tables, shape });
}

function valueFor(
  validator: ValidatorJson,
  field: string | undefined,
  build: BuildContext,
): unknown {
  const fullest = build.shape === 'fullest';
  switch (validator.type) {
    case 'id': {
      const row = build.rowOf(validator.tableName);
      if (row === undefined) throw new Error(`no row of ${validator.tableName} to name`);
      return row;
    }
    case 'string': {
      const table = field === undefined ? undefined : tableOfStringId(field, build.tables);
      const row = table === undefined ? undefined : build.rowOf(table);
      return row ?? (fullest ? PLACEHOLDER_TEXT : '');
    }
    case 'number':
      return fullest ? 1 : 0;
    case 'bigint':
      return fullest ? 1n : 0n;
    case 'boolean':
      return !fullest;
    case 'bytes':
      return new ArrayBuffer(0);
    case 'null':
      return null;
    case 'any':
      return {};
    case 'literal':
      return validator.value;
    case 'array':
      return fullest ? [valueFor(validator.value, undefined, build)] : [];
    case 'record':
      return {};
    case 'union': {
      const member = fullest ? validator.value[0] : validator.value.at(-1);
      if (member === undefined) throw new Error('a union with no member admits no value');
      return valueFor(member, field, build);
    }
    case 'object':
      return Object.fromEntries(
        Object.entries(validator.value)
          .filter(([, member]) => !fullest || !member.optional || mentionsAnId(member.fieldType))
          .map(([name, member]) => [name, valueFor(member.fieldType, name, build)]),
      );
    default: {
      const unknown: never = validator;
      throw new Error(`no value for validator ${JSON.stringify(unknown)}`);
    }
  }
}

/** Whether an optional field takes an id, so the sweep fills it and the guard meets a real row. */
function mentionsAnId(validator: ValidatorJson): boolean {
  if (validator.type === 'id') return true;
  if (validator.type === 'union') return validator.value.some(mentionsAnId);
  return false;
}

/** Every table an argument validator's ids point into. */
export function tablesNamedBy(validator: ValidatorJson): string[] {
  switch (validator.type) {
    case 'id':
      return [validator.tableName];
    case 'array':
      return tablesNamedBy(validator.value);
    case 'record':
      return tablesNamedBy(validator.values.fieldType);
    case 'union':
      return validator.value.flatMap(tablesNamedBy);
    case 'object':
      return Object.values(validator.value).flatMap((member) => tablesNamedBy(member.fieldType));
    case 'string':
    case 'number':
    case 'bigint':
    case 'boolean':
    case 'bytes':
    case 'null':
    case 'any':
    case 'literal':
      return [];
    default: {
      const unknown: never = validator;
      throw new Error(`no tables for validator ${JSON.stringify(unknown)}`);
    }
  }
}

/** Who asked: nobody, or a token the deployment refuses as a caller (`getCaller` answers null). */
export type UnadmittedCaller = 'no-identity' | 'refused-token';

/** What a public function did with a call. */
export type CallOutcome =
  | { readonly kind: 'answered'; readonly value: unknown }
  | { readonly kind: 'refused'; readonly message: string; readonly data: unknown };

/** Whether a refusal is the guard's own: `getCallerOrThrow`'s not-authenticated error. */
export type IsGuardRefusal = (outcome: Extract<CallOutcome, { kind: 'refused' }>) => boolean;

/** The sweep's judgement of one call: whether it kept the rule, and what the rule expected. */
export interface SweepVerdict {
  readonly kept: boolean;
  readonly expected: string;
}

/**
 * Whether a public function kept the rule for a caller it does not admit: the guard's refusal,
 * unless {@link CALLERLESS_FUNCTIONS} names it, in which case the answer its entry allows.
 *
 * @param path - The function, as `module:export`.
 * @param caller - Who asked.
 * @param outcome - What it did.
 * @param isGuardRefusal - Recognises the guard's refusal on the deployment the call reached.
 */
export function judgeUnadmittedCall(
  path: string,
  caller: UnadmittedCaller,
  outcome: CallOutcome,
  isGuardRefusal: IsGuardRefusal,
): SweepVerdict {
  const named = callerlessFunction(path);
  const guarded = outcome.kind === 'refused' && isGuardRefusal(outcome);
  if (named === undefined) return { kept: guarded, expected: "the guard's refusal" };
  switch (named.answer) {
    case 'public-fact':
      return {
        kept: outcome.kind === 'answered' && isReleaseStamp(outcome.value),
        expected: 'the release stamp or null, and nothing else',
      };
    case 'own-token-refusal':
      if (caller === 'no-identity') return { kept: guarded, expected: "the guard's refusal" };
      return {
        kept: outcome.kind === 'answered' && isOwnTokenRefusal(outcome.value),
        expected: 'which rule refused the token, and nothing else',
      };
    case 'secret-or-refusal':
      return {
        kept: outcome.kind === 'refused' || isRefusalInWords(outcome.value),
        expected: 'a refusal, thrown or in words, and nothing else',
      };
    default: {
      const unknown: never = named.answer;
      throw new Error(`unhandled answer ${String(unknown)}`);
    }
  }
}

/** The entry naming a function that answers with no caller, if any does. */
export function callerlessFunction(path: string): CallerlessFunction | undefined {
  return CALLERLESS_FUNCTIONS.find((entry) => entry.path === path);
}

/** Whether a value has exactly these keys. */
function hasExactly(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const own = Object.keys(value).sort();
  return own.length === keys.length && [...keys].sort().every((key, at) => own[at] === key);
}

/** `config.release`'s answer: null on a deployment never stamped, or the release and since when. */
function isReleaseStamp(value: unknown): boolean {
  if (value === null) return true;
  return (
    hasExactly(value, ['release', 'since']) &&
    typeof value.release === 'string' &&
    typeof value.since === 'number'
  );
}

/** `config.whoAmI`'s answer to a refused token: which rule refused it. */
function isOwnTokenRefusal(value: unknown): boolean {
  return hasExactly(value, ['refused']) && typeof value.refused === 'string';
}

/** A redirect completion's refusal: `{ ok: false, reason }` and no more. */
function isRefusalInWords(value: unknown): boolean {
  return (
    hasExactly(value, ['ok', 'reason']) && value.ok === false && typeof value.reason === 'string'
  );
}
