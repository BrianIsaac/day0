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

/**
 * A provenance suffix a model may append to a clause: a bracketed note naming
 * the 1:1 or day 1, or a dashed "from manager 1:1" tail, at the end of the
 * clause before any closing punctuation. The card shows provenance beside
 * each clause and evidence rows carry it in `source`, so a suffix in the
 * clause text is noise the reader sees twice. GLM 5.3 Flash wrote
 * "(from manager 1:1 day-1)" on every clause of one 16 September draft.
 */
const PROVENANCE_SUFFIX =
  /\s*(?:[(\[][^()[\]]*\b(?:1:1|day[- ]?(?:1|one))\b[^()[\]]*[)\]]|[-\u2013\u2014]\s*(?:from|per|source:?)\s+(?:the\s+)?manager(?:'s)?\s+1:1[^.;]*?)\s*(?=[.;,]?\s*$)/i;

/**
 * Remove every trailing provenance suffix from a clause.
 *
 * Args:
 *   text: A clause as the model wrote it.
 *
 * Returns:
 *   The clause with its suffixes gone and its closing punctuation kept.
 */
export function stripProvenanceSuffix(text: string): string {
  let current = text;
  for (;;) {
    const next = current.replace(PROVENANCE_SUFFIX, '');
    if (next === current) return current.trim();
    current = next;
  }
}

/**
 * The charter with every prose clause stripped of provenance suffixes: the
 * function, the three boundary lists, the hire reason, the goals, the
 * reading list and the evidence texts. Everything else is returned as is.
 *
 * Args:
 *   charter: The assembled charter.
 *
 * Returns:
 *   The same charter with clean clauses; a clean charter comes back equal.
 */
export function withoutProvenanceSuffixes(charter: Charter): Charter {
  const list = (items: readonly string[]): string[] => items.map(stripProvenanceSuffix);
  return {
    ...charter,
    whyThisHire: stripProvenanceSuffix(charter.whyThisHire),
    proposedFunction: stripProvenanceSuffix(charter.proposedFunction),
    evidence: charter.evidence.map((item) => ({ ...item, text: stripProvenanceSuffix(item.text) })),
    shortTermGoals: {
      day30: stripProvenanceSuffix(charter.shortTermGoals.day30),
      day60: stripProvenanceSuffix(charter.shortTermGoals.day60),
      day90: stripProvenanceSuffix(charter.shortTermGoals.day90),
    },
    proposedBoundaries: {
      willDo: list(charter.proposedBoundaries.willDo),
      willNotDo: list(charter.proposedBoundaries.willNotDo),
      escalationTriggers: list(charter.proposedBoundaries.escalationTriggers),
    },
    priorityReading: list(charter.priorityReading),
  };
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
 * Wording is stripped of any provenance suffix first, as the clauses were.
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
          .map((phrase: string): string => stripProvenanceSuffix(phrase))
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
 * The charter fields a strike reads and rewrites. A full charter fits, and so
 * does the body the dashboard card holds, which types the same fields.
 */
export type ClauseCharter = Pick<Charter, 'proposedFunction' | 'proposedBoundaries'> & {
  constraints?: CharterConstraint[];
  namedSystems?: ReadonlyArray<{ name: string }>;
};

/** The list clauses a preview reports on; the function is a sentence and never one of them. */
const LIST_FIELDS = ['willDo', 'willNotDo', 'escalationTriggers'] as const;

/** The clauses that bound the agent: a will-not-do or an escalation trigger, never a will-do. */
const BOUNDING_FIELDS = ['willNotDo', 'escalationTriggers'] as const;

/**
 * Whether a strike removes each bounding clause that carries the constraint, whole.
 *
 * A derived candidate-property constraint is one word this module found in
 * a clause, so the bound the manager is striking is the clause itself:
 * "ownership" struck from "Take ownership of Northstar CRM-dependent work"
 * would leave a prohibition saying something else. A will-do is scope, not
 * a bound: a property strike widens what qualifies and never narrows where
 * the agent acts, so a will-do keeps its sentence minus the word, as the
 * function does. A listed constraint names phrases the synthesis call or the
 * manager chose, which come out as phrases.
 */
function strikesWholeClause(constraint: CharterConstraint): boolean {
  return constraint.kind === 'candidate-property' && constraint.origin === 'derived';
}

function boundingClauses(charter: ClauseCharter): string[] {
  return BOUNDING_FIELDS.flatMap((field): string[] => charter.proposedBoundaries[field]);
}

/**
 * Refuse a candidate-property strike that would drop the last clause bounding a system.
 *
 * A candidate-property strike is about which work qualifies, never about
 * where the agent may act, so it may not be the change that lets the agent
 * into a system. A clause bounds a system when it names one of the charter's
 * named systems or carries the wording of a system-boundary constraint the
 * manager has not struck; if no remaining will-not-do or escalation clause
 * bounds that system, the strike is refused. Striking the system-boundary
 * constraint itself is the manager lifting the boundary and is not checked.
 *
 * Args:
 *   charter: The charter before the strikes.
 *   lifted: The charter with only the non-property strikes applied.
 *   result: The charter with every strike applied.
 *   struck: The constraints being struck.
 *
 * Raises:
 *   Error: Naming the clause and the system it alone bounded.
 */
function assertBoundariesKept(
  charter: ClauseCharter,
  lifted: ClauseCharter,
  result: ClauseCharter,
  struck: readonly CharterConstraint[],
): void {
  const remaining = boundingClauses(result);
  const dropped = boundingClauses(lifted).filter(
    (clause: string): boolean => !remaining.includes(clause),
  );
  if (dropped.length === 0) return;
  const keptBoundaries = (charter.constraints ?? []).filter(
    (constraint: CharterConstraint): boolean =>
      constraint.kind === 'system-boundary' &&
      constraint.struck !== true &&
      !struck.includes(constraint),
  );
  for (const clause of dropped) {
    for (const system of charter.namedSystems ?? []) {
      if (!wordingPresent(system.name, [clause])) continue;
      if (remaining.some((other: string): boolean => wordingPresent(system.name, [other]))) continue;
      throw new Error(
        `strike refused: \u201c${clause}\u201d is the only clause that bounds ${system.name}`,
      );
    }
    for (const boundary of keptBoundaries) {
      if (!boundary.wording.some((phrase: string): boolean => wordingPresent(phrase, [clause]))) {
        continue;
      }
      const elsewhere = boundary.wording.some((phrase: string): boolean =>
        wordingPresent(phrase, remaining),
      );
      if (elsewhere) continue;
      throw new Error(
        `strike refused: \u201c${clause}\u201d is the only clause that enforces \u201c${boundary.quote}\u201d`,
      );
    }
  }
}

/**
 * The charter with the given constraints struck.
 *
 * A derived candidate-property constraint drops, whole, every will-not-do
 * and escalation clause that carries its wording, and loses its wording
 * from the proposed function and the will-do clauses, which keep their
 * sentences. Every other constraint has its wording removed from the four
 * clause fields as `withoutClauseWording` does. A candidate-property strike
 * may not drop the last clause bounding a system.
 *
 * Args:
 *   charter: The charter to edit.
 *   struck: The constraints whose strike to apply.
 *
 * Returns:
 *   A copy with the strikes applied; the same charter when there are none.
 *
 * Raises:
 *   Error: When a strike would rewrite part of a will-not-do clause, or drop
 *     the only clause bounding a system.
 */
export function withoutConstraints<T extends ClauseCharter>(
  charter: T,
  struck: readonly CharterConstraint[],
): T {
  if (struck.length === 0) return charter;
  const isProperty = (constraint: CharterConstraint): boolean =>
    constraint.kind === 'candidate-property';
  const apply = (target: T, constraints: readonly CharterConstraint[]): T => {
    const whole = constraints.filter(strikesWholeClause);
    const phrased = constraints.filter(
      (constraint: CharterConstraint): boolean => !strikesWholeClause(constraint),
    );
    return withoutClauseWording(
      withoutClauses(target, whole),
      phrased.flatMap((constraint: CharterConstraint): string[] => constraint.wording),
    );
  };
  const lifted = apply(
    charter,
    struck.filter((constraint: CharterConstraint): boolean => !isProperty(constraint)),
  );
  const result = apply(lifted, struck.filter(isProperty));
  assertBoundariesKept(charter, lifted, result, struck);
  return result;
}

/**
 * Drop every bounding clause carrying a whole-clause constraint's wording;
 * the function and the will-do clauses keep their sentences minus the words,
 * a will-do emptied by that going with them.
 */
function withoutClauses<T extends ClauseCharter>(charter: T, struck: readonly CharterConstraint[]): T {
  if (struck.length === 0) return charter;
  const phrases = struck.flatMap((constraint: CharterConstraint): string[] => constraint.wording);
  const carries = (clause: string): boolean =>
    phrases.some((phrase: string): boolean => wordingPresent(phrase, [clause]));
  const proposedFunction = withoutPhrases(charter.proposedFunction, phrases);
  const boundaries = { ...charter.proposedBoundaries };
  boundaries.willDo = charter.proposedBoundaries.willDo
    .map((clause: string): string => withoutPhrases(clause, phrases))
    .filter((clause: string): boolean => /[A-Za-z0-9]/.test(clause));
  for (const field of BOUNDING_FIELDS) {
    boundaries[field] = charter.proposedBoundaries[field].filter(
      (clause: string): boolean => !carries(clause),
    );
  }
  return {
    ...charter,
    proposedFunction: /[A-Za-z0-9]/.test(proposedFunction)
      ? proposedFunction
      : charter.proposedFunction,
    proposedBoundaries: boundaries,
  };
}

/**
 * The charter as its struck constraints leave it.
 *
 * The rules are those of `withoutConstraints`, applied to every constraint
 * flagged `struck`. The constraints themselves stay, struck flags included.
 * This is the one function that turns strikes into clauses: approval,
 * amendment and the card's strike toggle all read it, so a strike the card
 * allows is one approval can honour.
 *
 * Args:
 *   charter: A charter whose constraints may carry `struck`.
 *
 * Returns:
 *   The same charter when nothing is struck, otherwise a copy with the
 *   strikes applied.
 *
 * Raises:
 *   Error: As `withoutConstraints`.
 */
export function effectiveCharter<T extends ClauseCharter>(charter: T): T {
  return withoutConstraints(
    charter,
    (charter.constraints ?? []).filter(
      (constraint: CharterConstraint): boolean => constraint.struck === true,
    ),
  );
}

/** What `effectiveCharter` makes of a charter: the result, or the refusal as a reason. */
export type StrikeOutcome<T extends ClauseCharter> =
  | { ok: true; charter: T }
  | { ok: false; reason: string };

/**
 * `effectiveCharter` as a result rather than a throw, for the strike toggle.
 *
 * Args:
 *   charter: A charter whose constraints may carry `struck`.
 *
 * Returns:
 *   The effective charter, or the reason the strikes cannot be applied.
 */
export function strikeOutcome<T extends ClauseCharter>(charter: T): StrikeOutcome<T> {
  try {
    return { ok: true, charter: effectiveCharter(charter) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** What striking one more constraint would do, for the card to say before the manager does it. */
export interface StrikePreview {
  /** List clauses the strike removes whole, beyond what is already struck. */
  removedClauses: string[];
  /** Will-do clauses the strike keeps with the wording gone, as they read before and after. */
  rewrittenClauses: Array<{ from: string; to: string }>;
  /** Why the strike cannot be applied; when set, nothing is removed. */
  refusal?: string;
}

function listClauses(charter: ClauseCharter): string[] {
  return LIST_FIELDS.flatMap((field): string[] => charter.proposedBoundaries[field]);
}

/**
 * Preview striking the constraint at `index` on top of the strikes already made.
 *
 * Computed with `strikeOutcome`, the function the toggle and approval use, so
 * a refusal here is the refusal the toggle would give and a strike previewed
 * as allowed is one approval will apply.
 *
 * Args:
 *   charter: The charter as drafted, other strikes flagged.
 *   index: The constraint to strike.
 *
 * Returns:
 *   The clauses the strike would remove, or the reason it is refused.
 */
export function strikePreview(charter: ClauseCharter, index: number): StrikePreview {
  const constraints = [...(charter.constraints ?? [])];
  const target = constraints[index];
  if (!target) return { removedClauses: [], rewrittenClauses: [] };
  constraints[index] = { ...target, struck: true };
  const before = strikeOutcome(charter);
  const after = strikeOutcome({ ...charter, constraints });
  if (!after.ok) return { removedClauses: [], rewrittenClauses: [], refusal: after.reason };
  const base = before.ok ? before.charter : charter;
  const remaining = listClauses(after.charter);
  const kept = new Set(remaining);
  const gone = listClauses(base).filter((clause: string): boolean => !kept.has(clause));
  // Only a will-do is rewritten rather than dropped, and rewriting keeps
  // order, so each will-do that changed lines up with the clause in its
  // place afterwards.
  const willDoBefore = base.proposedBoundaries.willDo;
  const willDoAfter = after.charter.proposedBoundaries.willDo;
  const rewrittenClauses: Array<{ from: string; to: string }> = [];
  let position = 0;
  for (const clause of willDoBefore) {
    if (willDoAfter[position] === clause) {
      position += 1;
      continue;
    }
    const to = willDoAfter[position];
    if (to !== undefined && !willDoBefore.includes(to)) {
      rewrittenClauses.push({ from: clause, to });
      position += 1;
    }
  }
  const rewritten = new Set(rewrittenClauses.map((pair): string => pair.from));
  return {
    removedClauses: gone.filter((clause: string): boolean => !rewritten.has(clause)),
    rewrittenClauses,
  };
}

/**
 * The charter with the given phrases removed from its four clause fields.
 *
 * A list clause emptied by the removal is dropped and the proposed function
 * is never emptied. A phrase that is only part of a will-not-do clause is
 * refused, because a prohibition minus a qualifier is a wider prohibition.
 *
 * Args:
 *   charter: The charter to edit.
 *   phrases: Whole-word phrases to remove.
 *
 * Returns:
 *   A copy with the phrases gone; the same charter when there are none.
 *
 * Raises:
 *   Error: When a phrase is only part of a will-not-do clause.
 */
export function withoutClauseWording<T extends ClauseCharter>(
  charter: T,
  phrases: readonly string[],
): T {
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
