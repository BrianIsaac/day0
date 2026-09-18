import type { SurfaceMode } from '../lib/surface-mode';

/** What a provider item's identity is read from on the surface that found it. */
export interface ClaimKeySurface {
  slug: string;
  class: string;
  path?: string;
  endpoint?: string;
  providerWorkspaceId?: string;
}

/** The work item's own reference to the provider item. */
export interface ClaimKeyItem {
  sourceSystem: string;
  externalId: string;
}

/** Linear's own domain; its MCP server and its GraphQL API both sit under it. */
const LINEAR_DOMAIN = 'linear.app';

/**
 * Whether an endpoint host is Linear's.
 *
 * Args:
 *   host: The endpoint's host.
 *
 * Returns:
 *   True for `linear.app` and its subdomains, never a look-alike.
 */
function isLinearHost(host: string): boolean {
  return host === LINEAR_DOMAIN || host.endsWith(`.${LINEAR_DOMAIN}`);
}

/**
 * The origin of an http(s) endpoint.
 *
 * Args:
 *   endpoint: The surface's documented endpoint.
 *
 * Returns:
 *   The origin, or undefined when there is no parseable http(s) endpoint.
 */
function httpOrigin(endpoint: string | undefined): URL | undefined {
  if (!endpoint) return undefined;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The key one external item is claimed under across the owner's employees.
 *
 * The provider is recognised by where the surface reaches it, never by its
 * slug or its path, so two employees whose cards name or reach one system
 * differently still meet on one key. A Linear issue id is a UUID, unique
 * across workspaces and the same over Linear's MCP server and its API. A
 * Slack message's channel and timestamp are unique only inside a workspace,
 * so the workspace is part of the key. Any other surface is keyed by its
 * endpoint's origin, and one with no usable endpoint by its slug, which
 * still separates it from every other kind: the prefixes `linear:`,
 * `slack:` and `slug:` cannot begin an http(s) origin. Mock mode claims
 * nothing, since every mock employee has a world of its own.
 *
 * Args:
 *   surface: The surface the item was read from, when it is still listed.
 *   item: The work item's source system and external id.
 *   mode: The deployment's surface mode.
 *
 * Returns:
 *   The key, or undefined when the item is not claimed across employees.
 */
export function providerItemKey(
  surface: ClaimKeySurface | undefined,
  item: ClaimKeyItem,
  mode: SurfaceMode,
): string | undefined {
  if (mode !== 'real') return undefined;
  const origin = httpOrigin(surface?.endpoint);
  if (origin && isLinearHost(origin.hostname)) return `linear:${item.externalId}`;
  if (surface?.class === 'chat' && surface.path === 'documented-api' && surface.providerWorkspaceId) {
    return `slack:${surface.providerWorkspaceId}:${item.externalId}`;
  }
  if (origin) return `${origin.origin}|${item.externalId}`;
  return `slug:${item.sourceSystem}|${item.externalId}`;
}
