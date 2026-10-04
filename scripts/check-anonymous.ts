/// <reference types="node" />
import { pathToFileURL } from 'node:url';
import { convexToJson, type Value } from 'convex/values';
import { errorMessage } from '../src/lib/errors';
import {
  argumentsFor,
  judgeUnadmittedCall,
  type CallOutcome,
  type ValidatorJson,
} from '../src/lib/anonymous-sweep';
import { adminTarget, deploymentAdmin, type DeploymentAdmin } from './lib/convex-admin';
import { readEnvValues } from './lib/env-file';

/**
 * `pnpm check:anonymous [env-file]`: asks a running deployment every public function it serves
 * with no identity at all, as a stranger's browser or script would, and says what each answered
 * (the anonymous-caller guard, wave 12, 12-G; the bed walk's step 5).
 *
 * The function list is the deployment's own (`_system/cli/modules:apiSpec`), read with the admin
 * key in the env file, so the check covers what is deployed, not what the tree holds. Each id
 * argument names the newest row of its table, read the same way, so a call passes the validator
 * and reaches the handler, where the guard must stand first. The calls themselves carry no
 * credential of any kind. Only the functions `src/lib/anonymous-access.ts` names may answer;
 * every other one must refuse with the guard's error. Exits 1 when any does not, and 2 when the
 * deployment could not be read.
 */

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
    | 'not asked';
  readonly detail: string;
}

/** What the check needs of a deployment: its table names, a row of a table, and the calls. */
export interface SweepTarget {
  readonly tables: ReadonlySet<string>;
  readonly rowOf: (table: string) => string | undefined;
  readonly ask: (fn: PublicFunction, args: unknown) => Promise<CallOutcome>;
}

/**
 * Asks every public function with no identity and judges each answer.
 *
 * @param functions - The deployment's public functions.
 * @param target - The deployment.
 */
export async function sweepWithNoIdentity(
  functions: readonly PublicFunction[],
  target: SweepTarget,
): Promise<AnonymousCheck[]> {
  const checks: AnonymousCheck[] = [];
  for (const fn of functions) {
    let args: unknown;
    try {
      args = argumentsFor(fn.args, target.rowOf, target.tables);
    } catch (error) {
      checks.push({ path: fn.path, status: 'not asked', detail: errorMessage(error) });
      continue;
    }
    const outcome = await target.ask(fn, args);
    const verdict = judgeUnadmittedCall(fn.path, 'no-identity', outcome, (refusal) =>
      isGuardRefusalData(refusal.data),
    );
    // A deployment's refusal can carry its stack across several lines; the check prints one each.
    const said = (
      outcome.kind === 'answered' ? `answered ${JSON.stringify(outcome.value)}` : outcome.message
    )
      .replace(/\s+/g, ' ')
      .trim();
    if (!verdict.kept) {
      checks.push({
        path: fn.path,
        status: 'BROKE THE RULE',
        detail: `expected ${verdict.expected}; ${said}`,
      });
    } else if (outcome.kind === 'refused' && isGuardRefusalData(outcome.data)) {
      checks.push({ path: fn.path, status: 'refused', detail: 'the guard' });
    } else {
      const status = outcome.kind === 'refused' ? 'refused as named' : 'answered as named';
      checks.push({ path: fn.path, status, detail: said.slice(0, 160) });
    }
  }
  return checks;
}

/** The exit code: 1 when any function broke the rule. */
export function anonymousExitCode(checks: readonly AnonymousCheck[]): number {
  return checks.some((check) => check.status === 'BROKE THE RULE') ? 1 : 0;
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
  const envFile = argv.find((argument) => !argument.startsWith('--')) ?? '.env.local';
  const target = adminTarget(readEnvValues(envFile));
  if ('gap' in target) {
    console.error(target.gap);
    return 2;
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
    return 2;
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
      `${count('not asked')} not asked (no row to name), ${count('BROKE THE RULE')} broke the rule.`,
  );
  return anonymousExitCode(checks);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Handed back rather than passed to process.exit so a piped stdout drains.
  process.exitCode = await main(process.argv.slice(2));
}
