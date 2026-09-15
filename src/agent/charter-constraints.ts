import type { Charter, DayOneTopic } from './charter';
import { CANDIDATE_PROPERTIES } from '../work/candidate-properties';

/**
 * The clauses of a charter that act as constraints on work, kept beside the
 * manager's own words so the manager can confirm or strike each one before
 * the charter is approved and after.
 *
 * A constraint is presentation over the clauses, not a second rule set: its
 * `wording` names the phrases in the function, will-do, will-not-do and
 * escalation clauses that encode it, and striking it removes those phrases
 * from those clauses. Downstream readers (the evaluator, the planner) keep
 * reading the clauses and never this list, so a struck constraint cannot
 * survive as a gate anywhere.
 *
 * No model dependency: this module is imported by Convex mutations.
 */

export const CONSTRAINT_KINDS = ['candidate-property', 'system-boundary', 'reporting-line'] as const;

export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

/** Where a constraint came from: the synthesis call, this module's own check, or the manager. */
export type ConstraintOrigin = 'synthesis' | 'derived' | 'manager';

export interface CharterConstraint {
  kind: ConstraintKind;
  /** The manager's own sentence, copied. */
  quote: string;
  /** Phrases in the clauses that encode it; each verified present. */
  wording: string[];
  origin: ConstraintOrigin;
  /** Set when the manager struck it; kept rather than deleted so the decision is on record. */
  struck?: boolean;
}

/** What the synthesis call returns for one constraint, before verification. */
export interface RawConstraint {
  kind: ConstraintKind;
  quote: string;
  wording: string[];
}

/** The clauses a constraint may be encoded in. */
export const CLAUSE_FIELDS = ['proposedFunction', 'willDo', 'willNotDo', 'escalationTriggers'] as const;

export type ClauseField = (typeof CLAUSE_FIELDS)[number];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every clause string the constraints may name. */
export function clauseTexts(charter: Charter): string[] {
  const boundaries = charter.proposedBoundaries;
  return [
    charter.proposedFunction,
    ...boundaries.willDo,
    ...boundaries.willNotDo,
    ...boundaries.escalationTriggers,
  ];
}

/** A whole-phrase, case-insensitive match of `phrase` in prose. */
function phrasePattern(phrase: string, flags = 'i'): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(phrase)}(?![A-Za-z0-9])`, flags);
}

/** Whether any clause carries the phrase as whole words. */
export function wordingPresent(phrase: string, clauses: readonly string[]): boolean {
  const trimmed = phrase.trim();
  if (!trimmed) return false;
  const pattern = phrasePattern(trimmed);
  return clauses.some((clause: string): boolean => pattern.test(clause));
}

/**
 * Remove a phrase from a clause together with the separator that joined it.
 *
 * "owned, prioritized Linear tickets" minus "owned" is "prioritized Linear
 * tickets", not ", prioritized Linear tickets": the comma or "and" that
 * attached the phrase goes with it. A phrase that ends the list takes the
 * separator before it instead.
 *
 * Args:
 *   text: The clause.
 *   phrase: Whole words to remove, case-insensitive.
 *
 * Returns:
 *   The clause without the phrase; empty when the phrase was the clause.
 */
export function removeWording(text: string, phrase: string): string {
  const trimmed = phrase.trim();
  if (!trimmed) return text;
  const p = escapeRegExp(trimmed);
  const separator = String.raw`(?:\s*,\s*|\s+(?:and|or)\s+)`;
  // Joined on the left and not on the right: the phrase closes or sits inside
  // a list, so the separator before it goes with it.
  const withPreceding = new RegExp(
    String.raw`${separator}${p}(?![A-Za-z0-9])(?!${separator})`,
    'gi',
  );
  const withFollowing = new RegExp(
    String.raw`(?<![A-Za-z0-9])${p}(?![A-Za-z0-9])(?:${separator}|\s*)`,
    'gi',
  );
  const removed = text.replace(withPreceding, ' ').replace(withFollowing, ' ');
  return removed
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/^[\s,;:]+/, '')
    .trim();
}

/**
 * Verify the synthesis call's constraints against the clauses.
 *
 * A constraint without a quote is nothing the manager can confirm and is
 * dropped. Wording the clauses do not carry is dropped from the constraint,
 * because striking it would then change nothing while looking as if it had.
 *
 * Args:
 *   raw: The constraints as the model returned them.
 *   charter: The assembled charter whose clauses they should name.
 *
 * Returns:
 *   The verified constraints, tagged as synthesised.
 */
export function normaliseConstraints(
  raw: readonly RawConstraint[],
  charter: Charter,
): CharterConstraint[] {
  const clauses = clauseTexts(charter);
  const out: CharterConstraint[] = [];
  for (const item of raw) {
    const quote = item.quote.trim();
    if (!quote) continue;
    const wording = [
      ...new Set(
        item.wording
          .map((phrase: string): string => phrase.trim())
          .filter((phrase: string): boolean => wordingPresent(phrase, clauses)),
      ),
    ];
    out.push({ kind: item.kind, quote, wording, origin: 'synthesis' });
  }
  return out;
}

/** Whether a listed constraint's wording already covers a word. */
function covered(word: string, constraints: readonly CharterConstraint[]): boolean {
  const pattern = phrasePattern(word);
  return constraints.some((constraint: CharterConstraint): boolean =>
    constraint.wording.some((phrase: string): boolean => pattern.test(phrase)),
  );
}

/** The manager's sentences, in the order the seven answers were given. */
function managerSentences(answers: Partial<Record<DayOneTopic, string>>): string[] {
  return Object.values(answers)
    .flatMap((answer: string | undefined): string[] => (answer ?? '').split(/(?<=[.!?;])\s+|\n+/))
    .map((sentence: string): string => sentence.trim().replace(/[.;]+$/, '').trim())
    .filter((sentence: string): boolean => sentence.length > 0);
}

/**
 * The candidate-property constraints the clauses carry that nothing lists.
 *
 * The 14 September failure was an adjective ("owned") that entered the
 * clauses from a passing remark and gated every plan. Whatever the model
 * lists, every ownership, priority or age word in the clauses ends up on the
 * manager's list, quoted from the manager's sentence that named the property,
 * or from the clause itself when no sentence did.
 *
 * Args:
 *   charter: The assembled charter.
 *   answers: The manager's seven answers, the only source of a quote.
 *   listed: Constraints already verified, whose wording is not repeated.
 *
 * Returns:
 *   One derived constraint per quoting sentence, in clause order.
 */
export function deriveConstraints(
  charter: Charter,
  answers: Partial<Record<DayOneTopic, string>>,
  listed: readonly CharterConstraint[],
): CharterConstraint[] {
  const clauses = clauseTexts(charter);
  const sentences = managerSentences(answers);
  const byQuote = new Map<string, CharterConstraint>();
  for (const property of CANDIDATE_PROPERTIES) {
    const global = new RegExp(property.words.source, 'gi');
    const carrying = clauses.filter((clause: string): boolean => property.words.test(clause));
    if (carrying.length === 0) continue;
    const quote =
      sentences.find((sentence: string): boolean => property.words.test(sentence)) ?? carrying[0]!;
    for (const clause of carrying) {
      for (const found of clause.match(global) ?? []) {
        const word = found.toLowerCase();
        if (covered(word, listed)) continue;
        const existing = byQuote.get(quote);
        if (existing) {
          if (!existing.wording.includes(word)) existing.wording.push(word);
          continue;
        }
        byQuote.set(quote, { kind: 'candidate-property', quote, wording: [word], origin: 'derived' });
      }
    }
  }
  return [...byQuote.values()];
}

function withoutPhrases(clause: string, phrases: readonly string[]): string {
  return phrases.reduce(
    (text: string, phrase: string): string => removeWording(text, phrase),
    clause,
  );
}

/**
 * The charter as its struck constraints leave it.
 *
 * Every struck constraint's wording is removed from the four clause fields; a
 * list clause emptied by that is dropped, and a proposed function that would
 * be emptied is kept as it was, because a charter with no function is not a
 * charter. The constraints themselves stay, struck flags included.
 *
 * Args:
 *   charter: A charter whose constraints may carry `struck`.
 *
 * Returns:
 *   The same charter when nothing is struck, otherwise a copy with the
 *   struck wording gone.
 */
export function effectiveCharter(charter: Charter): Charter {
  const struck = (charter.constraints ?? []).filter(
    (constraint: CharterConstraint): boolean => constraint.struck === true,
  );
  if (struck.length === 0) return charter;
  return withoutClauseWording(
    charter,
    struck.flatMap((constraint: CharterConstraint): string[] => constraint.wording),
  );
}

/**
 * The charter with the given phrases removed from its four clause fields.
 *
 * The rules are those of `effectiveCharter`: a list clause emptied by the
 * removal is dropped and the proposed function is never emptied.
 *
 * Args:
 *   charter: The charter to edit.
 *   phrases: Whole-word phrases to remove.
 *
 * Returns:
 *   A copy with the phrases gone; the same charter when there are none.
 */
export function withoutClauseWording(charter: Charter, phrases: readonly string[]): Charter {
  if (phrases.length === 0) return charter;
  for (const clause of charter.proposedBoundaries.willNotDo) {
    if (!phrases.some((phrase) => wordingPresent(phrase, [clause]))) continue;
    const remaining = withoutPhrases(clause, phrases);
    if (remaining !== clause && /[A-Za-z0-9]/.test(remaining)) {
      throw new Error('strike or edit the whole will-not-do clause; removing only part could change its boundary');
    }
  }
  const list = (clauses: readonly string[]): string[] =>
    clauses
      .map((clause: string): string => withoutPhrases(clause, phrases))
      .filter((clause: string): boolean => /[A-Za-z0-9]/.test(clause));
  const proposedFunction = withoutPhrases(charter.proposedFunction, phrases);
  return {
    ...charter,
    proposedFunction: /[A-Za-z0-9]/.test(proposedFunction)
      ? proposedFunction
      : charter.proposedFunction,
    proposedBoundaries: {
      willDo: list(charter.proposedBoundaries.willDo),
      willNotDo: list(charter.proposedBoundaries.willNotDo),
      escalationTriggers: list(charter.proposedBoundaries.escalationTriggers),
    },
  };
}
