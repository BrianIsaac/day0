import {
  clauseChanges,
  strikeOutcome,
  type StruckClause,
  type StruckClauseField,
} from '@/agent/charter-constraints';
import type { CharterCardBody } from './CharterCard';

/**
 * What the strikes do to the document: on a draft, the clauses its strikes will change on
 * approval (`pending`); on an approved charter, what they changed, as approval kept it.
 */
export interface DocumentStrikes {
  readonly pending: boolean;
  readonly changes: readonly StruckClause[];
}

/**
 * The strikes the document shows. A draft's are computed as approval computes them, so the
 * document never shows a change approval would not make; a strike approval would refuse is
 * refused before it is flagged, so an unappliable set shows nothing.
 *
 * @param approved - Whether the charter is approved.
 */
export function documentStrikes(body: CharterCardBody, approved: boolean): DocumentStrikes {
  if (approved) return { pending: false, changes: body.struckClauses ?? [] };
  if (!(body.constraints ?? []).some((constraint) => constraint.struck)) {
    return { pending: true, changes: [] };
  }
  const outcome = strikeOutcome(body);
  return { pending: true, changes: outcome.ok ? clauseChanges(body, outcome.charter) : [] };
}

/** The changes the strikes make to one clause field, in document order. */
export function changesTo(
  strikes: DocumentStrikes,
  field: StruckClauseField,
): readonly StruckClause[] {
  return strikes.changes.filter((change) => change.field === field);
}

/** Words a goal uses when the manager gave it nothing: the goal is a gap, not a goal. */
const NO_MILESTONE =
  /^\s*$|^\s*(?:none|n\/a|not stated|tbd)\.?\s*$|\bno\b[^.]*\b(?:milestone|goal|target|checkpoint)\b[^.]*\b(?:stated|given|named|set|mentioned)\b/i;

/**
 * Whether a 30, 60 or 90-day goal records that the manager named none, which the document draws
 * as a gap rather than a goal (round two section 3.5).
 */
export function goalIsGap(text: string): boolean {
  return NO_MILESTONE.test(text);
}

/** One of the three goals, by its key on the charter. */
export type GoalHorizon = 'day30' | 'day60' | 'day90';

/**
 * Whether the manager gave no goal for a checkpoint: as the drafter said it (C D11), or as the
 * goal's words read (`goalIsGap`), which a drafter's "stated" never overrules (W13-R37: "No 60-day
 * goal was given." with `stated: true` is still no goal).
 *
 * @param goals - The charter's goals, with what the drafter said of each when it did.
 * @param horizon - The checkpoint.
 */
export function goalNotGiven(
  goals: CharterCardBody['shortTermGoals'],
  horizon: GoalHorizon,
): boolean {
  return goals.stated?.[horizon] === false || goalIsGap(goals[horizon]);
}

/** The systems the one-to-one named, as one line: each once, with its kind. */
export function systemsLine(
  systems: ReadonlyArray<{ readonly name: string; readonly class: string }>,
): string {
  return systems.map((system) => `${system.name} (${system.class})`).join(', ');
}
