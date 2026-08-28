/**
 * Which documentation sources need a day0 component, and whether it is there.
 *
 * Day0 reads documentation through four source kinds, and only one of them
 * needs anything running beside the backend:
 *
 *   folder  a directory mounted read-only into the backend. No container.
 *   git     a repository the backend clones. No container.
 *   urls    pages the backend fetches. No container.
 *   mcp     an MCP server, and which one is the `serverKind`.
 *
 * Of the MCP server kinds, `notion` is the only one day0 bundles: Notion's
 * hosted server is OAuth-only, so a headless deployment runs Notion's own
 * server itself, and that is the `docs-notion` profile. `confluence`, `drive`
 * and `generic` name a server the enterprise already runs and day0 only dials -
 * there is no day0 component to start for them.
 *
 * A Notion source can also point at somebody else's copy of that server, which
 * is why the check is on the locator's host rather than on the server kind: the
 * component is day0's only when the address is day0's.
 */
/** The compose service, and the profile that starts it. */
export const DOCS_NOTION_SERVICE = 'docs-notion-mcp';
export const DOCS_NOTION_PROFILE = 'docs-notion';

/**
 * Hosts that mean "day0's own Notion component".
 *
 * `notion-mcp` is the name the service had before 27 Aug and is still a network
 * alias, because a documentation source stores its locator and rows linked
 * before the rename hold the old host.
 */
export const DOCS_NOTION_HOSTS = [DOCS_NOTION_SERVICE, 'notion-mcp'] as const;

/**
 * The bundled component's locator, which is what a new Notion link should use.
 *
 * The old host still resolves, so an existing row keeps syncing; a new one
 * should name the service rather than the alias.
 */
export const DOCS_NOTION_LOCATOR = `http://${DOCS_NOTION_SERVICE}:3000/mcp`;

/** What a human should do about it, in the words the running instructions use. */
export const DOCS_NOTION_ABSENT =
  'the Notion documentation component is not running - add `--profile docs-notion`';

/** Stable code used by link, sync and setup diagnostics for this absence. */
export const NOTION_DRIVER_ABSENT = 'NOTION_DRIVER_ABSENT';

/** The recordable refusal shared by every Notion component transport path. */
export const NOTION_DRIVER_ABSENT_REASON = `${NOTION_DRIVER_ABSENT}: ${DOCS_NOTION_ABSENT}`;

/**
 * Decide whether a locator addresses day0's own Notion component.
 *
 * Args:
 *   locator: The source's stored locator.
 *
 * Returns:
 *   True when the address is the bundled component's, under either name.
 */
export function isBundledNotionLocator(locator: string): boolean {
  try {
    return (DOCS_NOTION_HOSTS as readonly string[]).includes(new URL(locator).hostname);
  } catch {
    return false;
  }
}

/**
 * Whether reading this source depends on a day0 component being started.
 *
 * Args:
 *   source: The source's kind, server kind and locator.
 *
 * Returns:
 *   The compose service the source needs, or undefined when it needs none.
 */
export function componentFor(source: {
  kind: string;
  locator: string;
  serverKind?: string;
}): string | undefined {
  if (source.kind !== 'mcp') return undefined;
  if (source.serverKind !== 'notion') return undefined;
  return isBundledNotionLocator(source.locator) ? DOCS_NOTION_SERVICE : undefined;
}

/** How long to wait for a component that is either up or absent, in milliseconds. */
const REACH_TIMEOUT_MS = 3_000;

export type ReachFetch = (input: URL, init: RequestInit) => Promise<Response>;

/**
 * Refuse to use a documentation component that is not running.
 *
 * Any HTTP answer means the component is there - an MCP server refuses a bare
 * GET, and a refusal is still an answer. Only a transport failure means nothing
 * is listening, and that is the one case a human can fix by starting a profile,
 * so it is the one case that gets a sentence naming the profile.
 *
 * Args:
 *   source: The source being linked or synced.
 *   reach: Injectable transport, replaceable by tests.
 *
 * Raises:
 *   Error: With the plain component message when the component is not running.
 */
export async function assertDocsComponentReachable(
  source: { kind: string; locator: string; serverKind?: string },
  reach: ReachFetch = (input, init): Promise<Response> => fetch(input, init),
): Promise<void> {
  if (componentFor(source) !== DOCS_NOTION_SERVICE) return;
  try {
    await reach(new URL(source.locator), { signal: AbortSignal.timeout(REACH_TIMEOUT_MS) });
  } catch {
    throw new Error(NOTION_DRIVER_ABSENT_REASON);
  }
}

/**
 * Say, in the link form, which server an MCP source kind actually reaches.
 *
 * The distinction the form has to make is not between vendors: it is between a
 * server day0 runs for you and a server you already run. Only the first is a
 * profile you can start.
 *
 * Args:
 *   serverKind: The MCP server kind selected in the form.
 *
 * Returns:
 *   One sentence naming what to point the locator at.
 */
export function serverKindHelp(serverKind: string): string {
  if (serverKind === 'notion') {
    return (
      "Notion's hosted server is sign-in only, so day0 bundles Notion's own server as a " +
      `component: start it with \`--profile ${DOCS_NOTION_PROFILE}\` and use ` +
      `\`${DOCS_NOTION_LOCATOR}\` as the location.`
    );
  }
  return (
    'This points at an MCP server you already run. day0 has no component for it - give the ' +
    'address your server is reachable at from the backend.'
  );
}
