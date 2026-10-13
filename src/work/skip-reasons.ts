import {
  CLAIMED_BY_COLLEAGUE_SKIP_PREFIX,
  OUT_OF_SCOPE_SKIP_PREFIX,
  QUALITY_FIT_SKIP_PREFIX,
} from './types';

/*
 * The skip reasons the product writes itself, and how a manager reads any skip reason. The
 * labels before a reason ("out-of-scope: ") are machine markers the queue and the re-evaluation
 * read; a manager never sees one (W19-7: the v0.19.0 walk's record read "Lark skipped ...:
 * out-of-scope: no charter or current documented-system overlap.").
 */

/**
 * The reason the lexical rule writes when nothing ties the item to the charter, in plain words
 * from a template and with no model call (RM21 (c), 12 October 2026). The grade's "explained"
 * stays a reading of the model's own words, so this fixed sentence never counts as one.
 */
export const NO_OVERLAP_REASON = `${OUT_OF_SCOPE_SKIP_PREFIX}nothing in it is part of the role or its will-do clauses, and it names no system the role is connected to`;

/** The same rule's reason as v0.19.0 and every release before it stored it, for stored rows and results. */
export const NO_OVERLAP_REASON_BEFORE_0_20 = `${OUT_OF_SCOPE_SKIP_PREFIX}no charter or current documented-system overlap`;

/**
 * A skip reason as a manager reads it, as a clause: the machine label taken off, the quality-fit
 * judgement said as such, and the lexical rule's stored sentence of an earlier release said in
 * today's words.
 *
 * @param reason - The skip verdict's reason, as the row or the event keeps it.
 */
export function skipClause(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === NO_OVERLAP_REASON_BEFORE_0_20.trim()) return skipClause(NO_OVERLAP_REASON);
  if (trimmed.startsWith(OUT_OF_SCOPE_SKIP_PREFIX)) {
    return trimmed.slice(OUT_OF_SCOPE_SKIP_PREFIX.length).trim();
  }
  if (trimmed.startsWith(QUALITY_FIT_SKIP_PREFIX)) {
    return `judged not worth doing as it stands: ${trimmed.slice(QUALITY_FIT_SKIP_PREFIX.length).trim()}`;
  }
  if (trimmed.startsWith(CLAIMED_BY_COLLEAGUE_SKIP_PREFIX)) {
    return trimmed.slice(CLAIMED_BY_COLLEAGUE_SKIP_PREFIX.length).trim();
  }
  return trimmed;
}
