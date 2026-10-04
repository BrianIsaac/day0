import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import schema from '../../convex/schema';
import { CALLERLESS_FUNCTIONS } from '../../src/lib/anonymous-access';
import {
  ARGUMENT_SHAPES,
  argumentsFor,
  judgeUnadmittedCall,
  tableOfStringId,
  tablesNamedBy,
  type CallOutcome,
  type ObjectValidatorJson,
  type UnadmittedCaller,
  type ValidatorJson,
} from '../../src/lib/anonymous-sweep';
import { allConvexModules } from './all-modules';
import { managerIdentity } from './fakes/manager-identity';
import { insertMinimalRow } from './schema-fixtures';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * The anonymous-caller sweep (wave 12, 12-G; P9-4; the standard's 10.4): every public function
 * the generated `api` names, read from the modules themselves so a function added later is swept
 * without an edit, is called with arguments its own validator accepts, every id naming another
 * owner's row. A caller with no identity, and a token the deployment refuses, get the guard's
 * refusal and nothing else, except the functions `src/lib/anonymous-access.ts` names; a signed-in
 * caller who owns nothing never reads or changes the other owner's rows.
 */

declare global {
  interface ImportMeta {
    /** Vite's glob import of a file's text, read once at load. */
    glob(
      pattern: string,
      options: { query: '?raw'; import: 'default'; eager: true },
    ): Record<string, string>;
  }
}

/** One public function as its module registered it. */
interface PublicFunction {
  readonly path: string;
  readonly kind: 'query' | 'mutation' | 'action';
  readonly args: ObjectValidatorJson;
}

/** What Convex sets on a function its module exports, as the sweep reads it. */
interface RegisteredFunction {
  readonly isPublic?: boolean;
  readonly isQuery?: boolean;
  readonly isMutation?: boolean;
  readonly isAction?: boolean;
  readonly exportArgs?: () => string;
}

const MODULES = allConvexModules();

/**
 * Modules the generated `api` does not name: Convex reads them as configuration. `http` is not
 * one: Convex's codegen names every module but `schema` and a name with a second dot, so the sweep
 * reads it, and its HTTP actions, never public, add no function to it.
 */
const CONFIGURATION_MODULES = new Set(['schema', 'auth.config']);

/** A module's name as the generated `api` spells it, from its path under `convex/`. */
function moduleName(file: string): string | undefined {
  const name = /\/convex\/(.+)\.ts$/.exec(file)?.[1];
  if (name === undefined || name.startsWith('_generated/')) return undefined;
  return CONFIGURATION_MODULES.has(name) ? undefined : name;
}

/** Every public query, mutation and action of every module, in path order. */
async function publicFunctions(): Promise<PublicFunction[]> {
  const found: PublicFunction[] = [];
  for (const [file, load] of Object.entries(MODULES)) {
    const name = moduleName(file);
    if (name === undefined) continue;
    const exports = (await load()) as Record<string, RegisteredFunction | undefined>;
    for (const [exported, registered] of Object.entries(exports)) {
      if (registered?.isPublic !== true || registered.exportArgs === undefined) continue;
      const kind = registered.isQuery ? 'query' : registered.isMutation ? 'mutation' : 'action';
      const args = JSON.parse(registered.exportArgs()) as ValidatorJson;
      if (args.type !== 'object') throw new Error(`${name}:${exported} takes no argument object`);
      found.push({ path: `${name}:${exported}`, kind, args });
    }
  }
  return found.sort((left, right) => left.path.localeCompare(right.path));
}

/** The modules the generated `api` names, read from its declaration file. */
function generatedApiModules(): string[] {
  const [declaration] = Object.values(
    import.meta.glob('../../convex/_generated/api.d.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }),
  );
  if (declaration === undefined) throw new Error('convex/_generated/api.d.ts is missing');
  return [...declaration.matchAll(/^import type \* as \w+ from '\.\.\/(.+)\.js';$/gm)]
    .map((match) => match[1]!)
    .sort();
}

const FUNCTIONS = await publicFunctions();
const TABLES: ReadonlySet<string> = new Set(Object.keys(schema.tables));

/** The deployment shapes the sweep runs in: a mode or bed check must never stand before the guard. */
const SHAPES = [
  { name: 'mock', mode: 'mock', bed: false },
  { name: 'real', mode: 'real', bed: false },
  { name: 'mock evaluation bed', mode: 'mock', bed: true },
  { name: 'real evaluation bed', mode: 'real', bed: true },
] as const;

/** The other owner, whose rows every id names. */
const OWNER = 'seeded-owner';
const OWNER_ADDRESS = 'seeded-owner@day0.local';

/** The customer issuer a refused token comes from, under the generic preset. */
const CUSTOMER_ISSUER = 'https://sso.example.com/realms/ops';

/** What every `fetch` answers: nothing in the sweep reaches a network. */
const NETWORK_REFUSAL = 'the anonymous-caller sweep reaches no network';

type Harness = ReturnType<typeof convexTest>;
type Caller = Harness | ReturnType<Harness['withIdentity']>;
type FixtureCtx = Parameters<typeof insertMinimalRow>[0];
type FixtureTable = Parameters<typeof insertMinimalRow>[1];
type FixtureAgent = Parameters<typeof insertMinimalRow>[2];

/** Every table any public function's arguments name, by id or by an id-named string. */
function tablesTheSweepNames(): string[] {
  const named = new Set<string>(['agents']);
  for (const fn of FUNCTIONS) {
    for (const table of tablesNamedBy(fn.args)) named.add(table);
    for (const field of Object.keys(fn.args.value)) {
      const table = tableOfStringId(field, TABLES);
      if (table !== undefined) named.add(table);
    }
  }
  return [...named].sort();
}

/** Rows of another owner, one per table the sweep names, and an id per table of a row now gone. */
interface Seeded {
  readonly harness: Harness;
  readonly rows: ReadonlyMap<string, string>;
  readonly gone: ReadonlyMap<string, string>;
}

/** A harness holding another owner's employee and one row of every table the sweep names. */
async function seededHarness(): Promise<Seeded> {
  const harness = convexTest(schema, MODULES);
  const tables = tablesTheSweepNames();
  const { rows, gone } = await harness.run(async (ctx) => {
    const fixtureCtx = ctx as unknown as FixtureCtx;
    // The employee's own row has no agent to point at; its minimal row needs none.
    const ownerAgent = (await insertMinimalRow(
      fixtureCtx,
      'agents',
      undefined as unknown as FixtureAgent,
    )) as FixtureAgent;
    await ctx.db.patch(ownerAgent, { userId: OWNER, bossEmail: OWNER_ADDRESS });
    const seededRows: [string, string][] = [['agents', ownerAgent]];
    const goneRows: [string, string][] = [];
    for (const table of tables) {
      if (table !== 'agents') {
        seededRows.push([
          table,
          await insertMinimalRow(fixtureCtx, table as FixtureTable, ownerAgent),
        ]);
      }
      const doomed = await insertMinimalRow(fixtureCtx, table as FixtureTable, ownerAgent);
      await ctx.db.delete(doomed as FixtureAgent);
      goneRows.push([table, doomed]);
    }
    return { rows: seededRows, gone: goneRows };
  });
  return { harness, rows: new Map(rows), gone: new Map(gone) };
}

/** Call one public function and say what it did. */
async function call(caller: Caller, fn: PublicFunction, args: unknown): Promise<CallOutcome> {
  try {
    const value =
      fn.kind === 'query'
        ? await caller.query(makeFunctionReference<'query'>(fn.path), args as never)
        : fn.kind === 'mutation'
          ? await caller.mutation(makeFunctionReference<'mutation'>(fn.path), args as never)
          : await caller.action(makeFunctionReference<'action'>(fn.path), args as never);
    return { kind: 'answered', value };
  } catch (error) {
    if (error instanceof ConvexError) {
      return { kind: 'refused', message: error.message, data: error.data };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'refused', message, data: undefined };
  }
}

/** The guard's refusal, in this deployment's words: the not-authenticated `ConvexError`. */
async function guardRefusalText(): Promise<string> {
  const { notAuthenticatedMessage } = await import('../../convex/devAuth');
  return notAuthenticatedMessage();
}

/**
 * Every row of the other owner's, in every table: the seeded rows and any row since written for
 * its employee or under its owner key, so a call that changed one, or wrote one, is caught. The
 * test deployment holds a few rows per table, so reading them all stays cheap.
 */
async function snapshot(harness: Harness, rows: ReadonlyMap<string, string>): Promise<string> {
  const seededIds = new Set(rows.values());
  const ownerAgent = rows.get('agents');
  const read = await harness.run(async (ctx) =>
    Promise.all(
      [...TABLES].sort().map(async (table) => {
        const all = (await ctx.db.query(table as FixtureTable).collect()) as Record<
          string,
          unknown
        >[];
        return all.filter(
          (row) =>
            seededIds.has(String(row._id)) || row.agentId === ownerAgent || row.userId === OWNER,
        );
      }),
    ),
  );
  return JSON.stringify(read);
}

/** The answer or refusal, for a failure line. */
function shown(outcome: CallOutcome): string {
  return outcome.kind === 'answered'
    ? `answered ${JSON.stringify(outcome.value)}`
    : `refused: ${outcome.message}`;
}

describe('the anonymous-caller sweep', (): void => {
  it('reads every module the generated api names, and no other', (): void => {
    const loaded = Object.keys(MODULES)
      .map(moduleName)
      .filter((name): name is string => name !== undefined)
      .sort();
    expect(loaded).toEqual(generatedApiModules());
  });

  it('finds the public functions, among them every function named as answering with no caller', (): void => {
    expect(FUNCTIONS.length).toBeGreaterThan(150);
    const paths = FUNCTIONS.map((fn) => fn.path);
    for (const entry of CALLERLESS_FUNCTIONS) expect(paths).toContain(entry.path);
  });
});

describe.each(SHAPES)('the anonymous-caller guard on a $name deployment', (shape): void => {
  let seeded: Seeded;
  let guardText: string;
  const reachedNetwork: string[] = [];

  beforeAll(async (): Promise<void> => {
    useSurfaceMode(shape.mode);
    if (shape.bed) vi.stubEnv('DAY0_EVALUATION_BED', 'sweep-bed');
    vi.stubEnv('DAY0_OIDC_ISSUER', CUSTOMER_ISSUER);
    vi.stubEnv('DAY0_OIDC_ALLOWED_DOMAINS', 'example.com');
    vi.stubGlobal('fetch', async (input: unknown): Promise<never> => {
      reachedNetwork.push(String(input));
      throw new Error(NETWORK_REFUSAL);
    });
    // Nothing a call schedules runs: the sweep judges the call, not what it would start.
    vi.useFakeTimers();
    seeded = await seededHarness();
    guardText = await guardRefusalText();
  });

  afterAll((): void => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    restoreSurfaceMode();
  });

  /** A token the deployment refuses: the generic preset, its address not verified (decision 7 (b)). */
  function refusedToken(): Caller {
    return seeded.harness.withIdentity({
      issuer: CUSTOMER_ISSUER,
      subject: 'unverified',
      email: 'unverified@example.com',
      email_verified: false,
    });
  }

  it.each(FUNCTIONS)(
    '$path refuses a caller with no identity and a token it refuses, whatever its arguments name',
    async (fn): Promise<void> => {
      const callers: readonly (readonly [UnadmittedCaller, Caller])[] = [
        ['no-identity', seeded.harness],
        ['refused-token', refusedToken()],
      ];
      const idSets = [
        ['a row that exists', seeded.rows],
        ['a row that is gone', seeded.gone],
      ] as const;
      reachedNetwork.length = 0;
      const before = await snapshot(seeded.harness, seeded.rows);
      for (const [label, caller] of callers) {
        for (const [which, rows] of idSets) {
          for (const shape of ARGUMENT_SHAPES) {
            const args = argumentsFor(fn.args, (table) => rows.get(table), TABLES, shape);
            const outcome = await call(caller, fn, args);
            const verdict = judgeUnadmittedCall(
              fn.path,
              label,
              outcome,
              (refusal) => refusal.data === guardText,
            );
            expect(
              verdict.kept,
              `${label}, ${shape} arguments, ids naming ${which}: expected ${verdict.expected}; ${shown(outcome)}`,
            ).toBe(true);
          }
        }
      }
      expect(reachedNetwork, 'no unadmitted call reaches a network').toEqual([]);
      expect(await snapshot(seeded.harness, seeded.rows), 'no unadmitted call changes a row').toBe(
        before,
      );
    },
  );

  it.each(FUNCTIONS)(
    "$path never reads or changes another owner's rows for a signed-in caller who owns nothing",
    async (fn): Promise<void> => {
      const stranger = seeded.harness.withIdentity(managerIdentity('stranger'));
      const before = await snapshot(seeded.harness, seeded.rows);
      const args = argumentsFor(fn.args, (table) => seeded.rows.get(table), TABLES);
      const outcome = await call(stranger, fn, args);
      // A refusal may repeat the id the caller gave; an answer names nothing of the owner's.
      const said = outcome.kind === 'answered' ? JSON.stringify(outcome.value) : outcome.message;
      const marks =
        outcome.kind === 'answered'
          ? [...seeded.rows.values(), OWNER, OWNER_ADDRESS]
          : [OWNER, OWNER_ADDRESS];
      expect(
        marks.filter((mark) => (said ?? '').includes(mark)),
        `the answer names none of the other owner's rows: ${shown(outcome)}`,
      ).toEqual([]);
      expect(
        await snapshot(seeded.harness, seeded.rows),
        "the other owner's rows are unchanged",
      ).toBe(before);
    },
  );
});
