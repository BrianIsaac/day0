/**
 * The documentation pages an employee's surface cards read, named without reading the corpus.
 *
 * The cards order the systems by the table that documents them and compare
 * an approved intake queue with the line its page states. Both read only the
 * pages the employee's surfaces already point at: the page each approved
 * scope value quotes, and the pages that evidence each system. Sending every
 * page body of every source to the browser instead is the whole-corpus read
 * step 49 bounds (P10-1, C-15).
 */

import type { Doc } from '../../convex/_generated/dataModel';
import { intakeScopeValues, type IntakeScope } from '../surfaces/intake-scope';

/** One page by its source and reference. */
export interface CardPageRef {
  readonly sourceId: string;
  readonly ref: string;
}

/** The surface fields that point at pages. */
export type CardSurface = Pick<Doc<'surfaces'>, 'intakeScope' | 'discoveryEvidence' | 'whereFound'>;

/**
 * The pages a set of surface cards reads, in the order the cards need them.
 *
 * Scope pages come first, because a missing one would read as drift; then
 * each system's evidence pages, which carry the table that orders the cards.
 * Only pages of the sources the employee reads are named.
 *
 * @param surfaces - The employee's surfaces.
 * @param readable - The ids of the sources the employee reads.
 * @param limit - The most pages to name.
 */
export function cardPageRefs(
  surfaces: readonly CardSurface[],
  readable: ReadonlySet<string>,
  limit: number,
): CardPageRef[] {
  const seen = new Set<string>();
  const refs: CardPageRef[] = [];
  const add = (sourceId: unknown, ref: unknown): void => {
    if (typeof sourceId !== 'string' || typeof ref !== 'string') return;
    if (!readable.has(sourceId) || refs.length >= limit) return;
    const key = `${sourceId}\u0000${ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ sourceId, ref });
  };
  for (const surface of surfaces) {
    if (!surface.intakeScope) continue;
    for (const value of intakeScopeValues(surface.intakeScope as IntakeScope)) {
      add(value.sourceId, value.ref);
    }
  }
  for (const surface of surfaces) {
    for (const item of surface.discoveryEvidence ?? []) {
      if (item.kind === 'documentation' && item.current) add(item.sourceId, item.ref);
    }
    for (const item of surface.whereFound as unknown[]) {
      if (typeof item === 'object' && item !== null) {
        const evidence = item as { sourceId?: unknown; ref?: unknown };
        add(evidence.sourceId, evidence.ref);
      }
    }
  }
  return refs;
}
