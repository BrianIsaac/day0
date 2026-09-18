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

/** The host of the only MCP server the kanban intake reader speaks to. */
const LINEAR_MCP_HOST = 'mcp.linear.app';

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
 * The provider is recognised by how the surface reaches it, never by its
 * slug, so two employees whose cards name one system differently still
 * reach one key. A Linear issue id is a UUID, unique across workspaces. A
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
  if (surface?.path === 'mcp' && origin?.host === LINEAR_MCP_HOST) {
    return `linear:${item.externalId}`;
  }
  if (surface?.class === 'chat' && surface.path === 'documented-api' && surface.providerWorkspaceId) {
    return `slack:${surface.providerWorkspaceId}:${item.externalId}`;
  }
  if (origin) return `${origin.origin}|${item.externalId}`;
  return `slug:${item.sourceSystem}|${item.externalId}`;
}
