import {
  documentedSystemIdentity,
  sameSystemForHostlessMention,
  type DocumentedSystemIdentity,
} from '../docs/system-discovery';

/** The fields of a persisted surface that identify the system behind it. */
export interface IdentifiedSurface {
  displayName: string;
  class: string;
  endpoint?: string;
  discoveryEvidence?: ReadonlyArray<{ quote: string }>;
}

/**
 * Build the documented-system identity of a persisted surface.
 *
 * Args:
 *   surface: Surface row or an equivalent record.
 *
 * Returns:
 *   The identity the discovery matcher compares.
 */
export function surfaceIdentity(surface: IdentifiedSurface): DocumentedSystemIdentity {
  return documentedSystemIdentity({
    name: surface.displayName,
    quotes: (surface.discoveryEvidence ?? []).map((item) => item.quote),
    endpoints: surface.endpoint ? [surface.endpoint] : [],
  });
}

/**
 * Whether two persisted surfaces describe the same system.
 *
 * Args:
 *   left: One surface.
 *   right: The other surface.
 *
 * Returns:
 *   True when either reads as a hostless mention of the other.
 */
export function sameSurfaceSystem(left: IdentifiedSurface, right: IdentifiedSurface): boolean {
  const leftIdentity = surfaceIdentity(left);
  const rightIdentity = surfaceIdentity(right);
  return (
    sameSystemForHostlessMention(left.class, leftIdentity, right.class, rightIdentity) ||
    sameSystemForHostlessMention(right.class, rightIdentity, left.class, leftIdentity)
  );
}

/**
 * Whether a deferred item's missing surface slug is satisfied by a surface.
 *
 * The slug may name the surface itself, a persisted alias of the same system,
 * or a system nothing persisted yet whose name reads as the surface.
 *
 * Args:
 *   missingSlug: The slug the deferral recorded as missing.
 *   surface: The surface now available.
 *   siblings: Every persisted surface of the same agent.
 *
 * Returns:
 *   True when the surface resolves the missing slug.
 */
export function missingSurfaceResolvedBy(
  missingSlug: string,
  surface: IdentifiedSurface & { slug: string },
  siblings: ReadonlyArray<IdentifiedSurface & { slug: string }>,
): boolean {
  if (missingSlug === surface.slug) return true;
  const persisted = siblings.find((candidate) => candidate.slug === missingSlug);
  if (persisted) return sameSurfaceSystem(persisted, surface);
  const mention = documentedSystemIdentity({ name: missingSlug.replace(/-/g, ' ') });
  return sameSystemForHostlessMention(
    surface.class,
    mention,
    surface.class,
    surfaceIdentity(surface),
  );
}
