import { organisationSystemOf } from '../access-request';
import { LINEAR_RECIPE } from './linear';
import { MCP_RECIPE } from './mcp';
import { AccessKitError } from './origin';
import { SLACK_RECIPE } from './slack';
import type { AccessKitSystem, AccessRecipe } from './types';

export { AccessKitError, httpsOrigin } from './origin';
export type {
  AccessKitSystem,
  AccessRecipe,
  RecipeAsk,
  RecipeField,
  RecipeMode,
  SecretLifetime,
} from './types';

/** Every recipe the kit holds, by system. */
export const ACCESS_KIT: Readonly<Record<AccessKitSystem, AccessRecipe>> = {
  slack: SLACK_RECIPE,
  linear: LINEAR_RECIPE,
  mcp: MCP_RECIPE,
};

/**
 * The systems the cards' rule knows by host that the kit does not connect yet: each keeps the
 * pasted key until its issuer is written (AI1; the access plan 4.2), since an active connection
 * would make its cards refuse a paste with nothing to issue instead.
 */
export const KNOWN_WITHOUT_ISSUER: readonly string[] = [
  'github',
  'atlassian',
  'notion',
  'microsoft',
  'google',
];

/** The prefix of an MCP server's system key. */
const MCP_PREFIX = 'mcp:';

/**
 * The recipe for a connection's system key, or undefined when the kit connects no such system.
 *
 * @param system - The system key: `slack`, `linear`, or `mcp:<host>`.
 */
export function recipeForSystem(system: string): AccessRecipe | undefined {
  if (system.startsWith(MCP_PREFIX)) return MCP_RECIPE;
  return system === 'slack' || system === 'linear' ? ACCESS_KIT[system] : undefined;
}

/**
 * An MCP server's system key from its address, as the cards' rule keys it
 * (`organisationSystemOf`): `mcp:` and the host, lower case, without a port.
 *
 * @param serverUrl - The MCP server's https address.
 * @throws AccessKitError when the address is not https, or names a system the kit knows otherwise.
 */
export function mcpConnectionSystem(serverUrl: string): string {
  let url: URL;
  try {
    url = new URL(serverUrl.trim());
  } catch {
    throw new AccessKitError(`"${serverUrl}" is not an address.`);
  }
  if (url.protocol !== 'https:') {
    throw new AccessKitError('An MCP server is connected over https.');
  }
  const system = organisationSystemOf({ endpoint: url.href, path: 'mcp' });
  if (system === undefined || !system.startsWith(MCP_PREFIX)) {
    throw new AccessKitError(
      `${url.hostname} is ${system ?? 'not a host the cards can name'}: connect it through its own recipe.`,
    );
  }
  return system;
}

/** One page of the documentation as the scan reads it. */
export interface DocumentationPage {
  /** The page's path within the documentation folder, as the verb prints it. */
  readonly path: string;
  readonly markdown: string;
}

/** A system the documentation names, with the pages that name it, in the order first named. */
export interface DocumentedSystem {
  readonly system: string;
  /** The first address that named it: an MCP server's is where the verb offers to connect. */
  readonly address: string;
  readonly pages: readonly string[];
}

/** An address in running text, up to the first character a Markdown page closes one with. */
const ADDRESS = /https?:\/\/[^\s<>()`'"[\]]+/g;

/** Whether an address's path names an MCP endpoint: its last segment is `mcp` or `sse`. */
function mcpPath(url: URL): boolean {
  const last = url.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
  return last === 'mcp' || last === 'sse';
}

/**
 * The systems the documentation names, read off the addresses its pages carry with the cards'
 * own rule (`organisationSystemOf`), so the verb lists what a card would need (AI2): Slack's Web
 * API base, a host the rule knows, and an MCP endpoint by its host.
 *
 * @param pages - The documentation's pages.
 * @returns Each system once, with every page that names it, in the order first named.
 */
export function documentedSystems(pages: readonly DocumentationPage[]): DocumentedSystem[] {
  const found = new Map<string, { address: string; pages: string[] }>();
  for (const page of pages) {
    for (const match of page.markdown.matchAll(ADDRESS)) {
      const raw = match[0].replace(/[.,;:!?]+$/, '');
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        // Not an address after all: the next one is read.
        continue;
      }
      const system = organisationSystemOf({
        endpoint: url.href,
        ...(mcpPath(url) ? { path: 'mcp' } : {}),
      });
      if (system === undefined) continue;
      const named = found.get(system) ?? { address: url.href, pages: [] };
      if (!named.pages.includes(page.path)) named.pages.push(page.path);
      found.set(system, named);
    }
  }
  return [...found].map(([system, named]) => ({
    system,
    address: named.address,
    pages: named.pages,
  }));
}
