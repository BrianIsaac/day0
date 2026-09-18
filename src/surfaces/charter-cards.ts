/**
 * Which documented systems become cards: the ones the employee's charter names.
 *
 * One company documentation set documents every role's systems, and every
 * employee reading it gets a declared surface for each. A card is proposed
 * only for a system this employee's charter names; the rest stay declared and
 * wait for the manager to propose one by hand. Orientation and the dashboard
 * both read the rule from here, so the card list and the server agree.
 */

export interface CharterSystemLike {
  class: string;
}

export interface DiscoveryEvidenceLike {
  kind: 'charter' | 'documentation';
  current: boolean;
}

export interface CardSurfaceLike {
  verdict: string;
  discoveryEvidence?: readonly DiscoveryEvidenceLike[];
}

/**
 * Whether a charter names any system a card could come from.
 *
 * A documentation location (class `docs`) never becomes a surface, so a
 * charter naming only where the handbook lives names no card. Such a
 * charter, like one drafted before systems were recorded, leaves every
 * documented system to orientation, as before.
 *
 * Args:
 *   namedSystems: The charter's named systems, absent on old charters.
 *
 * Returns:
 *   True when at least one named system is a work system.
 */
export function charterNamesWorkSystems(
  namedSystems: readonly CharterSystemLike[] | undefined,
): boolean {
  return (namedSystems ?? []).some((system): boolean => system.class !== 'docs');
}

/**
 * Whether the employee's current charter names the system a surface stands for.
 *
 * Charter approval, an amendment adding a system and the provenance backfill
 * all attach a `charter` entry; removing the system retires it.
 *
 * Args:
 *   surface: The surface row.
 *
 * Returns:
 *   True when the surface carries a current charter entry.
 */
export function namedByCharter(surface: Pick<CardSurfaceLike, 'discoveryEvidence'>): boolean {
  return (surface.discoveryEvidence ?? []).some(
    (item): boolean => item.kind === 'charter' && item.current,
  );
}

/**
 * Whether a declared surface waits for the manager to propose it.
 *
 * Args:
 *   surface: The surface row.
 *   charterNamesSystems: Whether the employee's charter names any work system.
 *
 * Returns:
 *   True for a declared surface the charter does not name, when the charter
 *   names systems at all.
 */
export function awaitsManagerProposal(
  surface: CardSurfaceLike,
  charterNamesSystems: boolean,
): boolean {
  return surface.verdict === 'declared' && charterNamesSystems && !namedByCharter(surface);
}
