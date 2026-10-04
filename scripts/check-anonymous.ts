/// <reference types="node" />
import { pathToFileURL } from 'node:url';
import { convexToJson, type Value } from 'convex/values';
import { errorMessage } from '../src/lib/errors';
import {
  ARGUMENT_SHAPES,
  argumentsFor,
  judgeUnadmittedCall,
  type ArgumentShape,
  type CallOutcome,
  type ValidatorJson,
} from '../src/lib/anonymous-sweep';
import { adminTarget, deploymentAdmin, type DeploymentAdmin } from './lib/convex-admin';
import { readEnvValues } from './lib/env-file';

/**
 * `pnpm check:anonymous [env-file] --yes`: asks a running deployment every public function it
 * serves with no identity at all, as a stranger's browser or script would, and says what each
 * answered (the anonymous-caller guard, wave 12, 12-G; the bed walk's step 5).
 *
 * The function list is the deployment's own (`_system/cli/modules:apiSpec`), read with the admin
 * key in the env file, so the check covers what is deployed, not what the tree holds. Each id
 * argument names the newest row of its table, read the same way, so a call passes the validator
 * and reaches the handler, where the guard must stand first; every function is asked in both of
 * the sweep's argument shapes. The calls themselves carry no credential of any kind. Only the
 * functions `src/lib/anonymous-access.ts` names may answer; every other one must refuse with the
 * guard's error.
 *
 * It sends every public mutation and action to the deployment, so a function that breaks the rule
 * runs there as a stranger's call would: it asks only with `--yes`, and is meant for a bed or an
 * install before its people use it.
 *
 * Exits {@link EXIT_KEPT} when every function was asked and kept the rule, {@link EXIT_BROKEN}
 * when any broke it, {@link EXIT_NOT_RUN} when it was not run or the deployment could not be read,
 * and {@link EXIT_INCOMPLETE} when a function could not be asked (no row of a table its
 * arguments name) or gave no answer. `pnpm check:anonymous` reports every one but the first as 1
 * (pnpm's own exit); `pnpm exec tsx scripts/check-anonymous.ts --yes` keeps them apart.
 */

/** Every function was asked, and every one kept the rule. */
export const EXIT_KEPT = 0;
/** At least one function broke the rule. */
export const EXIT_BROKEN = 1;
/** Not run: no `--yes`, or the deployment could not be read. */
export const EXIT_NOT_RUN = 2;
/** None broke the rule, but not every function was asked, or one gave no answer. */
export const EXIT_INCOMPLETE = 3;

/** One function as the deployment's API spec lists it. */
export interface SpecFunction {
  readonly identifier: string;
  readonly functionType: string;
  readonly visibility?: { readonly kind?: string };
  readonly args?: unknown;
}

/** A public function the check asks, by its call path and kind. */
export interface PublicFunction {
  readonly path: string;
  readonly kind: 'query' | 'mutation' | 'action';
  readonly args: ValidatorJson;
}

/** The function types the HTTP function API runs, by the kind its path takes. */
const KIND_OF: Readonly<Record<string, PublicFunction['kind']>> = {
  Query: 'query',
  Mutation: 'mutation',
  Action: 'action',
};

/**
 * The public queries, mutations and actions of a deployment's API spec, in path order. An HTTP
 * action is left out: the deployment's own HTTP routes are not its function API.
 *
 * @param spec - What `_system/cli/modules:apiSpec` answered.
 */
export function publicFunctionsOf(spec: readonly SpecFunction[]): PublicFunction[] {
  return spec
    .filter((fn) => fn.visibility?.kind === 'public' && KIND_OF[fn.functionType] !== undefined)
    .map((fn) => {
      const [module, name] = fn.identifier.split(':');
      const args = typeof fn.args === 'string' ? (JSON.parse(fn.args) as unknown) : fn.args;
      return {
        path: `${(module ?? '').replace(/\.js$/, '')}:${name ?? ''}`,
        kind: KIND_OF[fn.functionType]!,
        args: (args ?? { type: 'object', value: {} }) as ValidatorJson,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

/** What a deployment answered one call with no credential, as the HTTP function API says it. */
interface FunctionAnswer {
  readonly status?: unknown;
  readonly value?: unknown;
  readonly errorMessage?: unknown;
  readonly errorData?: unknown;
}

/**
 * Asks one function with no credential at all and says what it did.
 *
 * @param base - The deployment's address.
 * @param fn - The function.
 * @param args - Its arguments.
 * @param send - The network seam.
 */
export async function askWithNoIdentity(
  base: string,
  fn: PublicFunction,
  args: unknown,
  send: typeof fetch,
): Promise<CallOutcome> {
  const response = await send(`${base.replace(/\/+$/, '')}/api/${fn.kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: fn.path, args: convexToJson(args as Value), format: 'json' }),
    signal: AbortSignal.timeout(30_000),
  });
  const answer = (await response.json()) as FunctionAnswer;
  if (answer.status === 'success') return { kind: 'answered', value: answer.value };
  const message = typeof answer.errorMessage === 'string' ? answer.errorMessage : 'no message';
  return { kind: 'refused', message, data: answer.errorData };
}

/** The guard's refusal as the deployment sends it: the not-authenticated error's data. */
export function isGuardRefusalData(data: unknown): boolean {
  return (
    typeof data === 'string' &&
    (data === 'not authenticated' || data.startsWith('not authenticated:'))
  );
}

/** One line of the check: the function and what became of its call. */
export interface AnonymousCheck {
  readonly path: string;
  readonly status:
    | 'refused'
    | 'refused as named'
    | 'answered as named'
    | 'BROKE THE RULE'
    | 'not asked'
    | 'no answer';
  readonly detail: string;
}

/** What the check needs of a deployment: its table names, a row of a table, and the calls. */
export interface SweepTarget {
  readonly tables: ReadonlySet<string>;
  readonly rowOf: (table: string) => string | undefined;
  readonly ask: (fn: PublicFunction, args: unknown) => Promise<CallOutcome>;
}

/**
 * Asks every public function with no identity, in each of the sweep's argument shapes, and judges
 * each answer: one line per function, the first shape that broke the rule if any did.
 *
 * @param functions - The deployment's public functions.
 * @param target - The deployment.
 */
export async function sweepWithNoIdentity(
  functions: readonly PublicFunction[],
  target: SweepTarget,
): Promise<AnonymousCheck[]> {
  const checks: AnonymousCheck[] = [];
  for (const fn of functions) checks.push(await checkFunction(fn, target));
  return checks;
}

/** One function asked in every shape: its first broken, unasked or unanswered shape, else its first. */
async function checkFunction(fn: PublicFunction, target: SweepTarget): Promise<AnonymousCheck> {
  const kept: AnonymousCheck[] = [];
  for (const shape of ARGUMENT_SHAPES) {
    let args: unknown;
    try {
      args = argumentsFor(fn.args, target.rowOf, target.tables, shape);
    } catch (error) {
      return { path: fn.path, status: 'not asked', detail: errorMessage(error) };
    }
    let outcome: CallOutcome;
    try {
      outcome = await target.ask(fn, args);
    } catch (error) {
      const detail = `${shape} arguments: ${errorMessage(error)}`;
      return { path: fn.path, status: 'no answer', detail: oneLine(detail) };
    }
    const check = checkOf(fn.path, shape, outcome);
    if (check.status === 'BROKE THE RULE') return check;
    kept.push(check);
  }
  return kept[0]!;
}

/** What one answer says about the rule. */
function checkOf(path: string, shape: ArgumentShape, outcome: CallOutcome): AnonymousCheck {
  const verdict = judgeUnadmittedCall(path, 'no-identity', outcome, (refusal) =>
    isGuardRefusalData(refusal.data),
  );
  const said = oneLine(
    outcome.kind === 'answered' ? `answered ${JSON.stringify(outcome.value)}` : outcome.message,
  );
  if (!verdict.kept) {
    return {
      path,
      status: 'BROKE THE RULE',
      detail: `${shape} arguments: expected ${verdict.expected}; ${said}`,
    };
  }
  if (outcome.kind === 'refused' && isGuardRefusalData(outcome.data)) {
    return { path, status: 'refused', detail: 'the guard' };
  }
  const status = outcome.kind === 'refused' ? 'refused as named' : 'answered as named';
  return { path, status, detail: said.slice(0, 160) };
}

/** A deployment's refusal can carry its stack across several lines; the check prints one each. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The exit code: broken over incomplete over kept. */
export function anonymousExitCode(checks: readonly AnonymousCheck[]): number {
  if (checks.some((check) => check.status === 'BROKE THE RULE')) return EXIT_BROKEN;
  const incomplete = checks.some(
    (check) => check.status === 'not asked' || check.status === 'no answer',
  );
  return incomplete ? EXIT_INCOMPLETE : EXIT_KEPT;
}

/** How many rows the table listing reads per page. */
const TABLE_PAGE = 200;

/** The deployment's table names, read with its admin key. */
async function tableNames(admin: DeploymentAdmin): Promise<Set<string>> {
  const names = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page: { page: { name: string }[]; isDone: boolean; continueCursor: string } =
      await admin.run('query', '_system/cli/tables', {
        paginationOpts: { cursor, numItems: TABLE_PAGE },
      });
    for (const table of page.page) names.add(table.name);
    if (page.isDone) return names;
    cursor = page.continueCursor;
  }
}

/** The newest row of each named table, read with the admin key, or none for an empty table. */
async function newestRows(
  admin: DeploymentAdmin,
  tables: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const rows = new Map<string, string>();
  for (const table of tables) {
    const page: { page: { _id: string }[] } = await admin.run('query', '_system/cli/tableData', {
      table,
      order: 'desc',
      paginationOpts: { cursor: null, numItems: 1 },
    });
    const newest = page.page[0];
    if (newest !== undefined) rows.set(table, newest._id);
  }
  return rows;
}

/** Runs the check against the deployment the env file names. */
export async function main(argv: readonly string[]): Promise<number> {
  if (!argv.includes('--yes')) {
    console.error(
      'This sends every public query, mutation and action to the deployment the env file names, ' +
        'with no credential, so a function that breaks the rule runs there as a stranger would ' +
        'run it. Run it on a bed or an install before its people use it, with --yes.',
    );
    return EXIT_NOT_RUN;
  }
  const envFile = argv.find((argument) => !argument.startsWith('--')) ?? '.env.local';
  const target = adminTarget(readEnvValues(envFile));
  if ('gap' in target) {
    console.error(target.gap);
    return EXIT_NOT_RUN;
  }
  const admin = deploymentAdmin(target);
  let functions: PublicFunction[];
  let tables: Set<string>;
  let rows: Map<string, string>;
  try {
    functions = publicFunctionsOf(await admin.run('query', '_system/cli/modules:apiSpec', {}));
    tables = await tableNames(admin);
    rows = await newestRows(admin, tables);
  } catch (error) {
    console.error(`The deployment could not be read: ${errorMessage(error)}`);
    return EXIT_NOT_RUN;
  }
  const checks = await sweepWithNoIdentity(functions, {
    tables,
    rowOf: (table) => rows.get(table),
    ask: async (fn, args) => await askWithNoIdentity(target.url, fn, args, fetch),
  });
  console.log(`Every public function at ${target.url}, asked with no identity:`);
  for (const check of checks) {
    console.log(`${check.status.padEnd(18)}${check.path.padEnd(56)}${check.detail}`);
  }
  const count = (status: AnonymousCheck['status']): number =>
    checks.filter((check) => check.status === status).length;
  console.log(
    `${functions.length} public functions: ${count('refused')} refused by the guard, ` +
      `${count('answered as named') + count('refused as named')} kept to what ` +
      'src/lib/anonymous-access.ts names for them (' +
      `${count('answered as named')} answered, ${count('refused as named')} refused), ` +
      `${count('not asked')} not asked (no row to name), ${count('no answer')} gave no answer, ` +
      `${count('BROKE THE RULE')} broke the rule.`,
  );
  return anonymousExitCode(checks);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Handed back rather than passed to process.exit so a piped stdout drains.
  process.exitCode = await main(process.argv.slice(2));
}
