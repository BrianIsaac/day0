/**
 * What may stand behind a read an approved plan declares, beside the reads
 * phase one landed. The closing gate (`validatePlanStepOutcomes`) owes each
 * declared read a landed read of its surface; on 19 September it looked in
 * phase one's ledger alone, and refused LOG-1 three times for a Linear read
 * the product had made itself before the plan was drafted, and FIN-1 for a
 * Slack read the manager's retry note had taken out of the work.
 */

import { actionIntent, parseSurfaceAction } from '../surfaces/policy';
import type { SurfaceRecord } from '../surfaces/types';
import { readsTheItem, type GroundingRead } from './evidence-claims';
import type { DeclaredRead } from './obligations';
import type { MockAction } from './types';

/**
 * The surfaces the item's plan-grounding reads landed on.
 *
 * A grounding read is the product's own read of the work item, made under
 * standing authority before the plan was drafted. It counts by the rule the
 * evidence check holds it to: it landed, it was not held, and one of its
 * arguments is this item's id, whole, so a read of another ticket is never
 * this item's read.
 *
 * Args:
 *   externalId: The work item's id on its source surface.
 *   reads: The item's grounding reads as their events stored them.
 *
 * Returns:
 *   Lower-cased surface slugs.
 */
export function groundingReadSurfaces(externalId: string | undefined, reads: readonly GroundingRead[] = []): Set<string> {
  const surfaces = new Set<string>();
  if (!externalId) return surfaces;
  for (const { action, applied } of reads) {
    if (applied?.ok !== true || applied.held || applied.awaitingApproval) continue;
    if (!readsTheItem(action, externalId)) continue;
    const parsed = parseSurfaceAction(action);
    if (parsed.ok) surfaces.add(parsed.action.surface.toLowerCase());
  }
  return surfaces;
}

/** Verbs and prepositions that take a thing out of the work, written before the thing. */
const REMOVING = String.raw`(?:skip|omit|drop|remove|without|leave\s+out|leave\s+off|take\s+out)`;
/** What a manager says after the thing to take it out. */
const UNNEEDED = String.raw`(?:is|are)?\s*(?:not\s+needed|not\s+required|not\s+necessary|unnecessary|unneeded)`;
/** A removal that is itself negated: "do not skip the Slack read". */
const KEPT = /\b(?:not|never|don't|dont|cannot|can't)\s+(?:skip|omit|drop|remove|leave|take)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether the manager's retry note takes a declared read out of the work.
 *
 * The note counts when one of its sentences names the read, by the
 * surface's name or slug or by its step number, and removes it in so many
 * words: a removing verb shortly before the name in the same clause
 * ("leave out the Slack step", "skip step 4"; not "skip the greeting and
 * answer in Slack"), "no" directly before it ("needs no Slack call"),
 * or the name followed by "not needed". A sentence that negates the removal
 * ("do not skip the Slack read") releases nothing, and neither does a note
 * that only mentions the surface. The caller pairs this with the step's
 * own outcome resting on the manager's feedback; the note alone releases
 * nothing.
 *
 * Args:
 *   note: The live retry note.
 *   read: The declared read.
 *
 * Returns:
 *   True when the note removes the read.
 */
export function noteReleasesRead(note: string, read: DeclaredRead): boolean {
  const names = [...new Set([read.surface.displayName, read.surface.slug].map((name) => name.trim()).filter(Boolean))]
    .map(escapeRegExp);
  const named = `(?:(?:${names.join('|')})(?![A-Za-z0-9])|step\\s+${read.step}(?![0-9]))`;
  const before = new RegExp(`\\b${REMOVING}\\b(?:(?!\\b(?:and|but|then|or)\\b)[^,:;.!?\\n]){0,40}?(?<![A-Za-z0-9])${named}`, 'i');
  const adjacent = new RegExp(`\\bno\\s+(?:more\\s+)?${named}`, 'i');
  const after = new RegExp(`(?<![A-Za-z0-9])${named}(?:\\s+(?:call|read|step|check|lookup))?\\s+${UNNEEDED}`, 'i');
  return note
    .split(/(?<=[.!?;])\s+|\n+/)
    .some((sentence) => !KEPT.test(sentence) && (before.test(sentence) || adjacent.test(sentence) || after.test(sentence)));
}

/**
 * The reads a closing set carries for the declared reads it is refused for.
 *
 * A closing set authored with the missing read in it cannot satisfy the
 * gate, which reads the ledger, and cannot be repaired by the model either.
 * When every unmet read has a read of its surface in the set, and none of
 * those surfaces is browser-driven (a snapshot with no page behind it reads
 * nothing), those reads can be applied first and the set authored again
 * from what they return.
 *
 * Args:
 *   unmet: The declared reads with nothing behind them.
 *   actions: The closing set as authored.
 *   surfaces: The agent's surfaces, to tell a browser-driven one.
 *
 * Returns:
 *   The carried reads in the set's order, or an empty list when the set
 *   does not cover every unmet read.
 */
export function carriedDeclaredReads(
  unmet: readonly DeclaredRead[],
  actions: readonly MockAction[],
  surfaces: ReadonlyArray<Pick<SurfaceRecord, 'slug' | 'path'>>,
): MockAction[] {
  const wanted = new Set(unmet.map((read) => read.surface.slug.toLowerCase()));
  if (wanted.size === 0) return [];
  const covered = new Set<string>();
  const carried = actions.filter((action): boolean => {
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok || actionIntent(parsed.action) !== 'read') return false;
    const slug = parsed.action.surface.toLowerCase();
    if (!wanted.has(slug)) return false;
    if (surfaces.find((row) => row.slug.toLowerCase() === slug)?.path === 'browser-driven') return false;
    covered.add(slug);
    return true;
  });
  return covered.size === wanted.size ? carried : [];
}
