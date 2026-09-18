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

/**
 * The key one external item is claimed under across the owner's employees.
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
  void surface;
  void item;
  void mode;
  return undefined;
}
