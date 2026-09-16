/**
 * Which model route an env file describes, shared by `pnpm check:setup` (which
 * reports it) and `pnpm setup:local resume` (which brings that route back up
 * without being told it again).
 */

/** Loopback from the host is nothing at all from inside a container. */
export function isLoopback(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);
}

/** The setup route as `pnpm setup:local --route` names it, plus `none`. */
export type ReportedRoute = 'key' | 'local' | 'featherless' | 'endpoint' | 'none';

export interface RouteReport {
  route: ReportedRoute;
  /** One clause for the terminal: the route, and what it reaches. */
  detail: string;
}

/**
 * Which model route the file describes, so a venue run has one line to read.
 *
 * The routes are the ones `pnpm setup:local --route` writes: Featherless by
 * its base URL, the bundled service by the loopback-plus-`model:` pair, a bare
 * key as OpenAI, and any other base URL as an endpoint of the reader's own.
 *
 * Args:
 *   values: Resolved environment contract.
 *
 * Returns:
 *   The route and a short description; no key value appears in it.
 */
export function setupRoute(values: Readonly<Record<string, string>>): RouteReport {
  const baseUrl = (values.OPENAI_BASE_URL ?? '').trim();
  const backendUrl = (values.CONVEX_OPENAI_BASE_URL ?? '').trim();
  const model = values.OPENAI_MODEL || 'gpt-5.6-terra (default)';
  const hasKey = (values.OPENAI_API_KEY ?? '').trim() !== '';
  if (baseUrl === '' && !hasKey) {
    return { route: 'none', detail: 'no model: neither OPENAI_API_KEY nor OPENAI_BASE_URL is set' };
  }
  if (/^https:\/\/api\.featherless\.ai(\/|$)/i.test(baseUrl)) {
    return {
      route: 'featherless',
      detail: `GLM through Featherless, model ${model}${hasKey ? '' : ', no key'}`,
    };
  }
  if (baseUrl === '') {
    return { route: 'key', detail: `api.openai.com with OPENAI_API_KEY, model ${model}` };
  }
  if (isLoopback(baseUrl) && /^https?:\/\/model(:|\/|$)/i.test(backendUrl)) {
    return { route: 'local', detail: `the bundled model service, model ${model}` };
  }
  return { route: 'endpoint', detail: `${baseUrl}, model ${model}` };
}
