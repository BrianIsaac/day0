/**
 * `next/navigation` for the signed-in markup (`signed-in-markup.ts`): the route the markup script
 * names, and a router that goes nowhere, as the dashboard's jsdom suites stand in for it.
 */

/** The route being drawn: the employee page's tab segment, the path and the search. */
export const route = { segment: null as string | null, pathname: '/', search: '' };

/** The open tab's segment; null on the employee page's first tab. */
export function useSelectedLayoutSegment(): string | null {
  return route.segment;
}

/** A router whose moves go nowhere. */
export function useRouter(): Record<string, () => void> {
  const stay = (): void => undefined;
  return { push: stay, replace: stay, refresh: stay, back: stay, forward: stay, prefetch: stay };
}

/** The drawn path. */
export function usePathname(): string {
  return route.pathname;
}

/** The drawn search. */
export function useSearchParams(): URLSearchParams {
  return new URLSearchParams(route.search);
}

/** The employee page's parameters. */
export function useParams(): Record<string, string> {
  return { agentId: 'agent-1' };
}

/** A server redirect, which no client tree drawn here reaches. */
export function redirect(href: string): never {
  throw new Error(`redirect to ${href} while drawing the signed-in markup`);
}

/** Rethrows Next's own control-flow errors; nothing drawn here throws one. */
export function unstable_rethrow(): void {}
