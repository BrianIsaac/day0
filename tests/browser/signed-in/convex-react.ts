import { getFunctionName, type FunctionReference } from 'convex/server';

/**
 * `convex/react` for the signed-in markup (`signed-in-markup.ts`): every query answers from the
 * fixture the markup script installs, by function name, as the dashboard's jsdom suites answer
 * theirs, and every mutation and action resolves with nothing. A query the fixture leaves out
 * stays loading, as one the deployment is still running does.
 */

/** A query's answer: a value, or one read off the query's arguments (a source's pages). */
export type Answer = unknown;

/**
 * What each query answers, by function name (`agents:get`), installed before the tree renders. A
 * function answers from the query's arguments.
 */
export const answers = new Map<string, Answer>();

function answer(reference: unknown, args?: unknown): unknown {
  if (args === 'skip') return undefined;
  const found = answers.get(getFunctionName(reference as FunctionReference<'query'>));
  return typeof found === 'function' ? (found as (args: unknown) => unknown)(args) : found;
}

/** A query's fixture answer. */
export function useQuery(reference: unknown, args?: unknown): unknown {
  return answer(reference, args);
}

/** Several queries' fixture answers, keyed as asked. */
export function useQueries(
  queries: Readonly<Record<string, { readonly query: unknown; readonly args?: unknown }>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(queries).map(([key, { query, args }]) => [key, answer(query, args)]),
  );
}

/** A paginated query's fixture answer as one exhausted page, or its first page loading. */
export function usePaginatedQuery(reference: unknown, args?: unknown): Record<string, unknown> {
  const results = answer(reference, args);
  return Array.isArray(results)
    ? { results, status: 'Exhausted', isLoading: false, loadMore: (): void => undefined }
    : { results: [], status: 'LoadingFirstPage', isLoading: true, loadMore: (): void => undefined };
}

/** A mutation that resolves with nothing: the markup is drawn, never pressed. */
export function useMutation(): () => Promise<undefined> {
  return async (): Promise<undefined> => undefined;
}

/** An action that resolves with nothing. */
export function useAction(): () => Promise<undefined> {
  return async (): Promise<undefined> => undefined;
}

/** A manager whose token Convex holds. */
export function useConvexAuth(): { isLoading: boolean; isAuthenticated: boolean } {
  return { isLoading: false, isAuthenticated: true };
}
