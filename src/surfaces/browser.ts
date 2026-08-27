/**
 * The browser floor: what it may drive, and where it may drive it.
 *
 * A `browser-driven` surface is one whose documentation records a web UI and
 * nothing else - no MCP server, no API. It is the floor of the ladder, and it
 * is the one path where the transport and the target are different addresses:
 * the surface's endpoint is the system's own page, taken from the docs, while
 * the driver is Day0's own browser service, configured like the bundled
 * documentation reader rather than discovered. Keeping the documented address
 * on the row matters - it is the evidence the orientation run cited, and the
 * driver must never be able to rewrite it.
 *
 * Two boundaries apply, and they are different from each other. The tool
 * allowlist decides what the browser may *do*; the origin bound decides where
 * it may *go*. Either alone is insufficient: navigation is a legitimate tool,
 * so without the origin bound an approved surface would authorise browsing
 * anywhere the container can reach.
 */

/** The default address of the bundled browser driver on the compose network. */
export const DEFAULT_BROWSER_MCP_URL = 'http://playwright-mcp:8931/mcp';

/**
 * Tools the floor may use, whatever else the driver exposes.
 *
 * Enough to read a page and to complete a form a person would complete: the
 * work item this exists for is "refresh the tile", which is a write. What is
 * deliberately absent is everything that turns a browser into a general
 * runtime or a file mover - `browser_evaluate`, `browser_run_code_unsafe`,
 * `browser_file_upload`, `browser_tabs`, `browser_network_requests`,
 * `browser_take_screenshot`. Playwright MCP has no read-only flag of its own
 * (upstream issue #885), so this list is the enforcement.
 */
export const BROWSER_TOOLS = [
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_fill_form',
] as const;

/** Tools whose arguments name a destination the origin bound applies to. */
const NAVIGATING_TOOLS = new Set(['browser_navigate']);

export class BrowserBoundError extends Error {}

/**
 * The browser driver this deployment uses.
 *
 * Args:
 *   configured: The value of `DAY0_BROWSER_MCP_URL`, if set.
 *
 * Returns:
 *   The driver endpoint.
 *
 * Raises:
 *   BrowserBoundError: If a configured value is not an http(s) URL. The scheme
 *     is checked because `new URL` accepts `playwright-mcp:8931` as a URL with
 *     a scheme of its own, which would reach nothing and say nothing useful.
 */
export function browserDriverUrl(configured: string | undefined): URL {
  const raw = (configured ?? '').trim() || DEFAULT_BROWSER_MCP_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BrowserBoundError('DAY0_BROWSER_MCP_URL is not a URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserBoundError('DAY0_BROWSER_MCP_URL must be an http or https URL.');
  }
  return parsed;
}

/**
 * Decide whether a destination is inside the surface the human approved.
 *
 * Same origin, and the documented path is a prefix: a surface approved for
 * `http://host:8080/dashboards/7` does not authorise `http://host:8080/admin`.
 * A documented address ending in `/` is treated as the whole site under it,
 * which is what a bare dashboard root means.
 *
 * Args:
 *   destination: The URL the action asks the browser to open.
 *   documented: The surface's endpoint as the orientation run recorded it.
 *
 * Returns:
 *   Whether the browser may go there.
 */
export function withinDocumentedSurface(destination: string, documented: string): boolean {
  let target: URL;
  let allowed: URL;
  try {
    target = new URL(destination);
    allowed = new URL(documented);
  } catch {
    return false;
  }
  if (target.origin !== allowed.origin) return false;
  const base = allowed.pathname.endsWith('/') ? allowed.pathname : `${allowed.pathname}/`;
  return target.pathname === allowed.pathname || `${target.pathname}/`.startsWith(base);
}

/**
 * Refuse a browser action that would leave the approved surface.
 *
 * Args:
 *   tool: The browser tool being called.
 *   toolArgs: Its arguments, as the skill supplied them.
 *   documented: The surface's documented endpoint.
 *
 * Returns:
 *   A refusal reason, or undefined when the action stays inside the surface.
 */
export function navigationRefusal(
  tool: string,
  toolArgs: Record<string, unknown>,
  documented: string | undefined,
): string | undefined {
  if (!NAVIGATING_TOOLS.has(tool)) return undefined;
  if (!documented) return 'the surface has no documented address to browse';
  const destination = toolArgs.url;
  if (typeof destination !== 'string' || destination.trim() === '') {
    return 'browser_navigate was given no url';
  }
  if (!withinDocumentedSurface(destination, documented)) {
    return `navigation outside the approved surface (${documented})`;
  }
  return undefined;
}
