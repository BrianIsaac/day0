import type { Charter, DayOneTopic } from './charter';
import { CANDIDATE_PROPERTIES } from '../work/candidate-properties';
import { escapeRegExp } from '../lib/regex';

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

export const CONSTRAINT_KINDS = [
  'candidate-property',
  'system-boundary',
  'reporting-line',
] as const;

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
  /**
   * The clauses the rule produced, by list and place: what a strike removes. Empty when no clause
   * carries the rule. Absent on a rule drafted before rules were bound, which strikes by its
   * wording alone.
   */
  binds?: ClauseRef[];
}

/** What the synthesis call returns for one constraint, before verification. */
export interface RawConstraint {
  kind: ConstraintKind;
  quote: string;
  wording: string[];
  /** The clauses the model says the rule produced; absent from a reply drafted before binds. */
  binds?: readonly ClauseRef[];
}

/** The clauses a constraint may be encoded in. */
export const CLAUSE_FIELDS = [
  'proposedFunction',
  'willDo',
  'willNotDo',
  'escalationTriggers',
] as const;

export type ClauseField = (typeof CLAUSE_FIELDS)[number];

/** One clause by the list it is in and its place there, counted from 0; the function is place 0. */
export interface ClauseRef {
  readonly field: ClauseField;
  readonly index: number;
}

/**
 * A provenance suffix a model may append to a clause: a bracketed note that
 * names the 1:1 or day 1 and says where it came from (from, per, source,
 * manager, boss), or a dashed "from manager 1:1" tail, at the end of the
 * clause before any closing punctuation. The card shows provenance beside
 * each clause and evidence rows carry it in `source`, so a suffix in the
 * clause text is noise the reader sees twice. GLM 5.3 Flash wrote
 * "(from manager 1:1 day-1)" on every clause of one 16 September draft. A
 * bracket that merely mentions the 1:1 ("(the Monday 1:1 with Sam)") is
 * clause text and stays.
 */
const PROVENANCE_SUFFIX =
  /\s*(?:[(\[](?=[^()[\]]*\b(?:from|per|source|manager|boss)\b)[^()[\]]*\b(?:1:1|day[- ]?(?:1|one))\b[^()[\]]*[)\]]|[-\u2013\u2014]\s*(?:from|per|source:?)\s+(?:the\s+)?manager(?:'s)?\s+1:1[^.;]*?)\s*(?=[.;,]?\s*$)/i;

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
      ...charter.shortTermGoals,
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

/** One clause with its place, in the order `clauseTexts` lists them. */
interface PlacedText {
  readonly ref: ClauseRef;
  readonly text: string;
}

/** Every clause a rule may bind, with its place: the function, then each list in turn. */
function placedClauses(charter: ClauseCharter): PlacedText[] {
  return [
    { ref: { field: 'proposedFunction', index: 0 }, text: charter.proposedFunction },
    ...LIST_FIELDS.flatMap((field): PlacedText[] =>
      charter.proposedBoundaries[field].map(
        (text: string, index: number): PlacedText => ({ ref: { field, index }, text }),
      ),
    ),
  ];
}

/** The clause at a place, or undefined when the charter has none there. */
function clauseAt(charter: ClauseCharter, ref: ClauseRef): string | undefined {
  if (!Number.isInteger(ref.index) || ref.index < 0) return undefined;
  if (ref.field === 'proposedFunction')
    return ref.index === 0 ? charter.proposedFunction : undefined;
  return charter.proposedBoundaries[ref.field][ref.index];
}

function sameRef(left: ClauseRef, right: ClauseRef): boolean {
  return left.field === right.field && left.index === right.index;
}

/** The places, each once, in the order first given. */
function distinctRefs(refs: readonly ClauseRef[]): ClauseRef[] {
  return refs.filter(
    (ref: ClauseRef, at: number): boolean =>
      refs.findIndex((other: ClauseRef): boolean => sameRef(other, ref)) === at,
  );
}

/**
 * A prohibition's opening: "Never", "Do not", "I will not" and their kin. A manager's "Never
 * change a deal amount in the tracker." is drafted as the will-not-do "Change a deal amount in the
 * tracker.", and the model's wording often keeps the "Never" (every hosted walk from v0.11.0 to
 * v0.16.0, finding 1).
 */
const PROHIBITION_OPENING =
  /^(?:i\s+)?(?:never|(?:do|does|will|must|should|shall)\s+not|don['\u2019]t|doesn['\u2019]t|won['\u2019]t|mustn['\u2019]t|shouldn['\u2019]t)\s+/i;

/**
 * The phrase as the clauses carry it: itself without a provenance suffix, else without a
 * prohibition's opening when a clause that bounds the employee states the act it forbids, else
 * nothing. The act alone is never verified in a will-do or the function, which grant it.
 *
 * @param clauses - Every clause a rule may name.
 * @param bounding - The will-not-do and escalation clauses among them.
 */
function verifiedPhrase(
  phrase: string,
  clauses: readonly string[],
  bounding: readonly string[],
): string | undefined {
  const stripped = stripProvenanceSuffix(phrase);
  if (wordingPresent(stripped, clauses)) return stripped;
  const act = stripped.replace(PROHIBITION_OPENING, '');
  return act !== stripped && wordingPresent(act, bounding) ? act : undefined;
}

/**
 * The places a rule binds: those the model named that the charter has, each once; when it named
 * none that exists, the clauses that carry the rule's verified wording, so a reply that placed the
 * rule by words alone still binds it.
 */
function verifiedBinds(
  raw: readonly ClauseRef[],
  wording: readonly string[],
  charter: ClauseCharter,
): ClauseRef[] {
  const named = distinctRefs(
    raw.filter((ref: ClauseRef): boolean => clauseAt(charter, ref) !== undefined),
  );
  if (named.length > 0) return named;
  return placedClauses(charter)
    .filter((clause: PlacedText): boolean =>
      wording.some((phrase: string): boolean => wordingPresent(phrase, [clause.text])),
    )
    .map((clause: PlacedText): ClauseRef => clause.ref);
}

/** Whether a rule has a handle on the clauses: words they carry, or places it binds. */
function placedInClauses(constraint: CharterConstraint): boolean {
  return constraint.wording.length > 0 || (constraint.binds?.length ?? 0) > 0;
}

/** Two rules' places as one list, absent only when neither rule was bound. */
function mergedBinds(
  left: readonly ClauseRef[] | undefined,
  right: readonly ClauseRef[] | undefined,
): ClauseRef[] | undefined {
  if (left === undefined && right === undefined) return undefined;
  return distinctRefs([...(left ?? []), ...(right ?? [])]);
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
 *   The clause without the phrase; empty when the phrase was the clause; the
 *   clause as written, spacing included, when the phrase is not in it.
 */
export function removeWording(text: string, phrase: string): string {
  const trimmed = phrase.trim();
  if (!trimmed) return text;
  const p = escapeRegExp(trimmed);
  // A comma or semicolon takes the "and" or "or" after it with it (W13-R38: ", and" left a
  // dangling comma, "; flag deals;" a doubled semicolon).
  const separator = String.raw`(?:\s*[,;]\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+)`;
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
  // Tidying an unmatched clause would make a strike that removes nothing read
  // as a change (and be recorded as one), so the clause stays as written.
  if (removed === text) return text;
  const tidied = removed
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/[,;:]+(?=[.!?]|$)/g, '')
    .replace(/^[\s,;:]+/, '')
    .replace(/^(?:and|or)\s+/i, '')
    .trim();
  // A sentence that opened on a capital still does once its first words are taken (W13-R38).
  return /^[A-Z]/.test(text.trim())
    ? tidied.replace(/^[a-z]/, (first) => first.toUpperCase())
    : tidied;
}

/**
 * Verify the synthesis call's constraints against the clauses.
 *
 * A constraint without a quote is nothing the manager can confirm and is
 * dropped. Wording the clauses do not carry is dropped from the constraint,
 * because striking it would then change nothing while looking as if it had;
 * a phrase that opens on a prohibition the clause states as the act ("Never
 * change ..." against "Change ...") is kept as the act. Wording is stripped of
 * any provenance suffix first, as the clauses were. A reply that binds its
 * rules keeps each bind whose clause exists (`verifiedBinds`), and a rule it
 * bound to none is kept with no binds, as a rule in no clause; a reply drafted
 * before binds leaves its rules unbound. A sentence listed twice is one rule
 * for each kind it makes with words or places of its own, and a copy with
 * neither is dropped.
 *
 * @param raw - The constraints as the model returned them.
 * @param charter - The assembled charter whose clauses they should name.
 * @returns The verified constraints, tagged as synthesised.
 */
export function normaliseConstraints(
  raw: readonly RawConstraint[],
  charter: Charter,
): CharterConstraint[] {
  const clauses = clauseTexts(charter);
  const bounding = boundingClauses(charter);
  const out: CharterConstraint[] = [];
  for (const item of raw) {
    const quote = item.quote.trim();
    if (!quote) continue;
    const wording = [
      ...new Set(
        item.wording.flatMap((phrase: string): string[] => {
          const verified = verifiedPhrase(phrase, clauses, bounding);
          return verified === undefined ? [] : [verified];
        }),
      ),
    ];
    const binds =
      item.binds === undefined ? undefined : verifiedBinds(item.binds, wording, charter);
    // A sentence the model lists twice (the production walk's 6c) is one rule for each kind it
    // makes with words or places of its own; a copy with neither once verified is no rule.
    const rule: CharterConstraint = {
      kind: item.kind,
      quote,
      wording,
      origin: 'synthesis',
      ...(binds === undefined ? {} : { binds }),
    };
    const said = (listed: CharterConstraint): boolean => sameQuote(listed.quote, quote);
    const bare = out.findIndex((listed) => said(listed) && !placedInClauses(listed));
    const sameKind = out.findIndex((listed) => said(listed) && listed.kind === item.kind);
    if (!out.some(said)) {
      out.push(rule);
    } else if (!placedInClauses(rule)) {
      continue;
    } else if (bare !== -1) {
      out[bare] = rule;
    } else if (sameKind !== -1) {
      const earlier = out[sameKind]!;
      const merged = mergedBinds(earlier.binds, rule.binds);
      out[sameKind] = {
        ...earlier,
        wording: [...new Set([...earlier.wording, ...wording])],
        ...(merged === undefined ? {} : { binds: merged }),
      };
    } else {
      out.push(rule);
    }
  }
  return out;
}

/** A sentence as a rule is told apart by: its words, case and closing punctuation aside. */
function quoteKey(quote: string): string {
  return quote
    .toLocaleLowerCase('en-GB')
    .replace(/[\u201c\u201d"]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s.;!]+$/, '')
    .trim();
}

/** Whether two rules quote the same sentence. */
function sameQuote(left: string, right: string): boolean {
  return quoteKey(left) === quoteKey(right);
}

/** One rule the card lists: the constraint and its index, which strikes and restores address. */
export interface ListedRule {
  readonly constraint: CharterConstraint;
  readonly index: number;
}

/**
 * The rules to list, one line per rule: a constraint whose sentence another constraint quotes
 * with the clauses' words or places is the same rule with neither of its own, and is left out,
 * struck or not, since its strike changed nothing. A draft synthesised before `normaliseConstraints` merged
 * such pairs still holds both (the production walk's 6c).
 *
 * @param constraints - The charter's constraints, in their stored order.
 * @returns The rules to draw, each with its stored index.
 */
export function listedRules(constraints: readonly CharterConstraint[]): ListedRule[] {
  return constraints.flatMap((constraint, index): ListedRule[] => {
    if (placedInClauses(constraint)) return [{ constraint, index }];
    const other = constraints.findIndex(
      (candidate, at) =>
        at !== index &&
        sameQuote(candidate.quote, constraint.quote) &&
        (placedInClauses(candidate) || at < index),
    );
    return other === -1 ? [{ constraint, index }] : [];
  });
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
    .map((sentence: string): string =>
      sentence
        .trim()
        .replace(/[.;]+$/, '')
        .trim(),
    )
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
 *   One derived constraint per quoting sentence, in clause order, bound to
 *   the clauses its words were found in.
 */
export function deriveConstraints(
  charter: Charter,
  answers: Partial<Record<DayOneTopic, string>>,
  listed: readonly CharterConstraint[],
): CharterConstraint[] {
  const clauses = placedClauses(charter);
  const sentences = managerSentences(answers);
  const byQuote = new Map<string, CharterConstraint>();
  for (const property of CANDIDATE_PROPERTIES) {
    const global = new RegExp(property.words.source, 'gi');
    const carrying = clauses.filter((clause: PlacedText): boolean =>
      property.words.test(clause.text),
    );
    if (carrying.length === 0) continue;
    const quote =
      sentences.find((sentence: string): boolean => property.words.test(sentence)) ??
      carrying[0]!.text;
    for (const clause of carrying) {
      for (const found of clause.text.match(global) ?? []) {
        const word = found.toLowerCase();
        if (covered(word, listed)) continue;
        const existing = byQuote.get(quote);
        if (existing) {
          if (!existing.wording.includes(word)) existing.wording.push(word);
          existing.binds = distinctRefs([...(existing.binds ?? []), clause.ref]);
          continue;
        }
        byQuote.set(quote, {
          kind: 'candidate-property',
          quote,
          wording: [word],
          origin: 'derived',
          binds: [clause.ref],
        });
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
 * Whether a clause still says something: a letter or a digit in any script.
 *
 * A strike that leaves only punctuation has emptied the clause; one that
 * leaves Chinese, or any other non-Latin wording, has not (N8).
 */
function hasWording(clause: string): boolean {
  return /[\p{L}\p{N}]/u.test(clause);
}

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

/** Whether a place is a bounding clause: a will-not-do or an escalation trigger. */
function boundingRef(ref: ClauseRef): boolean {
  return ref.field === 'willNotDo' || ref.field === 'escalationTriggers';
}

/**
 * Refuse a direct edit of the clauses that drops the last clause enforcing a
 * standing system-boundary rule (P8-9's second bypass): the rule would stay
 * on the card with nothing enforcing it. Striking the rule is how the manager
 * lifts it. Unlike a strike, an edit may remove the last clause that merely
 * names a system: the manager is writing the boundary itself, not striking a
 * rule about which work qualifies. A bound rule is enforced by the bounding
 * clauses it binds, so `after` carries its binds re-indexed for the edit
 * (`withClauseRemoved`); an edit that rewrites a bound clause in place keeps it.
 *
 * Args:
 *   before: The charter before the edit.
 *   after: The charter with the edit applied.
 *
 * Raises:
 *   Error: Naming the clause and the rule it alone enforced.
 */
export function assertEditKeepsBoundaries(before: ClauseCharter, after: ClauseCharter): void {
  assertBoundariesKept({ ...before, namedSystems: [] }, before, after, [], 'edit');
}

/**
 * Refuse a candidate-property strike that would drop the last clause bounding a system.
 *
 * A candidate-property strike is about which work qualifies, never about
 * where the agent may act, so it may not be the change that lets the agent
 * into a system. A clause bounds a system when it names one of the charter's
 * named systems or enforces a system-boundary constraint the manager has not
 * struck: carries its wording, or, for a bound rule, is one of the bounding
 * clauses it binds. If no remaining will-not-do or escalation clause bounds
 * that system, the strike is refused. Striking the system-boundary constraint
 * itself is the manager lifting the boundary and is not checked.
 *
 * Args:
 *   charter: The charter before the strikes.
 *   lifted: The charter with only the non-property strikes applied, binds re-indexed.
 *   result: The charter with every strike applied, binds re-indexed.
 *   struck: The constraints being struck.
 *   change: What the refusal names: a strike, or a direct edit of a clause.
 *
 * Raises:
 *   Error: Naming the clause and the system it alone bounded.
 */
function assertBoundariesKept(
  charter: ClauseCharter,
  lifted: ClauseCharter,
  result: ClauseCharter,
  struck: readonly CharterConstraint[],
  change: 'strike' | 'edit' = 'strike',
): void {
  const remaining = boundingClauses(result);
  const dropped = boundingClauses(lifted).filter(
    (clause: string): boolean => !remaining.includes(clause),
  );
  if (dropped.length === 0) return;
  const kept = (charter.constraints ?? []).flatMap(
    (constraint: CharterConstraint, index: number): number[] =>
      constraint.kind === 'system-boundary' &&
      constraint.struck !== true &&
      !struck.includes(constraint)
        ? [index]
        : [],
  );
  const ruleAt = (index: number): CharterConstraint => (charter.constraints ?? [])[index]!;
  for (const clause of dropped) {
    for (const system of charter.namedSystems ?? []) {
      if (!wordingPresent(system.name, [clause])) continue;
      if (remaining.some((other: string): boolean => wordingPresent(system.name, [other])))
        continue;
      throw new Error(
        `${change} refused: \u201c${clause}\u201d is the only clause that bounds ${system.name}`,
      );
    }
    for (const index of kept) {
      const boundary = ruleAt(index);
      if (boundary.binds !== undefined) continue;
      if (!boundary.wording.some((phrase: string): boolean => wordingPresent(phrase, [clause]))) {
        continue;
      }
      const elsewhere = boundary.wording.some((phrase: string): boolean =>
        wordingPresent(phrase, remaining),
      );
      if (elsewhere) continue;
      throw new Error(
        `${change} refused: \u201c${clause}\u201d is the only clause that enforces \u201c${boundary.quote}\u201d`,
      );
    }
  }
  for (const index of kept) {
    const boundary = ruleAt(index);
    if (boundary.binds === undefined) continue;
    // Enforced is bound to a bounding clause that carries the rule: a clause rewritten in place
    // into something else keeps its bind and enforces nothing.
    const carrying = (charterAt: ClauseCharter, refs: readonly ClauseRef[]): string[] =>
      refs.flatMap((ref: ClauseRef): string[] => {
        const clause = clauseAt(charterAt, ref);
        return clause !== undefined &&
          boundingRef(ref) &&
          clauseCarriesRule(boundary, clause, ref.field)
          ? [clause]
          : [];
      });
    const before = carrying(lifted, lifted.constraints?.[index]?.binds ?? []);
    const after = carrying(result, result.constraints?.[index]?.binds ?? []);
    if (before.length === 0 || after.length > 0) continue;
    throw new Error(
      `${change} refused: \u201c${before[0]!}\u201d is the only clause that enforces \u201c${boundary.quote}\u201d`,
    );
  }
}

/** One list clause as a strike carries it: its words, and its place in the charter struck from. */
interface PlacedClause {
  readonly text: string;
  readonly at: number;
}

/** A list the strikes rewrite. */
type ListField = (typeof LIST_FIELDS)[number];

/**
 * The clauses a strike rewrites, each list clause keeping its place in the charter the strikes
 * started from, so the binds of the rules left can be counted again once clauses are gone.
 */
interface PlacedCharter {
  readonly proposedFunction: string;
  readonly lists: Readonly<Record<ListField, readonly PlacedClause[]>>;
}

function placedCharter(charter: ClauseCharter): PlacedCharter {
  const list = (field: ListField): PlacedClause[] =>
    charter.proposedBoundaries[field].map(
      (text: string, at: number): PlacedClause => ({ text, at }),
    );
  return {
    proposedFunction: charter.proposedFunction,
    lists: {
      willDo: list('willDo'),
      willNotDo: list('willNotDo'),
      escalationTriggers: list('escalationTriggers'),
    },
  };
}

function textsOf(clauses: readonly PlacedClause[]): string[] {
  return clauses.map((clause: PlacedClause): string => clause.text);
}

/** A bind's place after the strikes, or nothing when its clause is gone. */
function placeAfter(ref: ClauseRef, after: PlacedCharter): ClauseRef[] {
  if (ref.field === 'proposedFunction') return [ref];
  const index = after.lists[ref.field].findIndex(
    (clause: PlacedClause): boolean => clause.at === ref.index,
  );
  return index === -1 ? [] : [{ field: ref.field, index }];
}

/**
 * The charter as the strikes left its clauses, every bound rule's binds counted again: a bind
 * whose clause went is dropped, and one after it in its list moves up.
 */
function charterAfter<T extends ClauseCharter>(charter: T, after: PlacedCharter): T {
  const constraints = charter.constraints?.map(
    (constraint: CharterConstraint): CharterConstraint =>
      constraint.binds === undefined
        ? constraint
        : {
            ...constraint,
            binds: constraint.binds.flatMap((ref: ClauseRef): ClauseRef[] =>
              placeAfter(ref, after),
            ),
          },
  );
  return {
    ...charter,
    proposedFunction: after.proposedFunction,
    proposedBoundaries: {
      willDo: textsOf(after.lists.willDo),
      willNotDo: textsOf(after.lists.willNotDo),
      escalationTriggers: textsOf(after.lists.escalationTriggers),
    },
    ...(constraints === undefined ? {} : { constraints }),
  };
}

/** The function minus the phrases, kept whole when they would empty it. */
function functionWithout(proposedFunction: string, phrases: readonly string[]): string {
  const rewritten = withoutPhrases(proposedFunction, phrases);
  return hasWording(rewritten) ? rewritten : proposedFunction;
}

/**
 * What a strike does with one clause its rule binds (W13-R6, W13-R7): takes it (a will-not-do or
 * escalation whole, a will-do minus the rule's words), or keeps it because it does not carry the
 * rule, because another rule left standing binds and carries it too, or because it is a will-do the rule's
 * words are not in, which a strike would otherwise take whole with the duty it names.
 */
type BoundClauseFate =
  | { readonly kind: 'take' }
  | { readonly kind: 'trim' }
  | { readonly kind: 'keep'; readonly because: KeptClause['because']; readonly rule?: string };

function boundClauseFate(
  rule: CharterConstraint,
  ref: ClauseRef,
  clause: string,
  standing: readonly CharterConstraint[],
): BoundClauseFate {
  // Kept only for a rule that binds the clause and carries it: a wrong bind of another rule never
  // keeps a clause the struck rule is lifting (found on the pre-tag bed, Wren's refund clause).
  const other = standing.find(
    (candidate: CharterConstraint): boolean =>
      candidate.binds?.some((bind: ClauseRef): boolean => sameRef(bind, ref)) === true &&
      clauseCarriesRule(candidate, clause, ref.field),
  );
  if (other !== undefined) return { kind: 'keep', because: 'another-rule', rule: other.quote };
  if (!clauseCarriesRule(rule, clause, ref.field)) {
    return { kind: 'keep', because: 'not-this-rule' };
  }
  if (ref.field !== 'willDo') return { kind: 'take' };
  return rule.wording.some((phrase: string): boolean => wordingPresent(phrase, [clause]))
    ? { kind: 'trim' }
    : { kind: 'keep', because: 'no-words' };
}

/**
 * Strike rules that bind their clauses, by reference, taking only the clauses each carries
 * (W13-R6): a bound will-not-do and escalation clause goes whole; a bound will-do loses the rule's
 * words, an emptied one with it, and is kept whole when the words are not in it (W13-R7); a clause
 * another rule left standing binds is kept (W13-R7); the function loses the rule's words and never
 * its sentence.
 */
function withoutBoundClauses(
  target: PlacedCharter,
  struck: readonly CharterConstraint[],
  standing: readonly CharterConstraint[],
): PlacedCharter {
  if (struck.length === 0) return target;
  const whole = new Set<string>();
  const trimmed = new Map<number, string[]>();
  const functionPhrases: string[] = [];
  for (const rule of struck) {
    for (const ref of rule.binds ?? []) {
      if (ref.field === 'proposedFunction') {
        functionPhrases.push(...ruleWordsInFunction(rule, target.proposedFunction));
        continue;
      }
      const clause = target.lists[ref.field].find(
        (candidate: PlacedClause): boolean => candidate.at === ref.index,
      );
      if (clause === undefined) continue;
      const fate = boundClauseFate(rule, ref, clause.text, standing);
      if (fate.kind === 'trim') {
        trimmed.set(clause.at, [...(trimmed.get(clause.at) ?? []), ...rule.wording]);
      } else if (fate.kind === 'take') {
        whole.add(`${ref.field}:${clause.at}`);
      }
    }
  }
  const kept = (field: ListField): PlacedClause[] =>
    target.lists[field]
      .filter((clause: PlacedClause): boolean => !whole.has(`${field}:${clause.at}`))
      .map(
        (clause: PlacedClause): PlacedClause =>
          field === 'willDo' && trimmed.has(clause.at)
            ? { ...clause, text: withoutPhrases(clause.text, trimmed.get(clause.at)!) }
            : clause,
      )
      .filter((clause: PlacedClause): boolean => hasWording(clause.text));
  return {
    proposedFunction: functionWithout(target.proposedFunction, functionPhrases),
    lists: {
      willDo: kept('willDo'),
      willNotDo: kept('willNotDo'),
      escalationTriggers: kept('escalationTriggers'),
    },
  };
}

/**
 * The charter with the given constraints struck.
 *
 * A rule that binds its clauses strikes them by reference (`withoutBoundClauses`). A rule drafted
 * before binds strikes by its wording: a derived candidate-property constraint drops, whole, every
 * will-not-do and escalation clause that carries its wording, and loses its wording from the
 * proposed function and the will-do clauses, which keep their sentences; every other such
 * constraint has its wording removed from the four clause fields as `withoutClauseWording` does.
 * The binds of every rule are counted again over the clauses left. A candidate-property strike may
 * not drop the last clause bounding a system.
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
  const standing = (charter.constraints ?? []).filter(
    (constraint: CharterConstraint): boolean =>
      constraint.struck !== true && !struck.includes(constraint),
  );
  const apply = (
    target: PlacedCharter,
    constraints: readonly CharterConstraint[],
  ): PlacedCharter => {
    const bound = constraints.filter((constraint) => constraint.binds !== undefined);
    const unbound = constraints.filter((constraint) => constraint.binds === undefined);
    return withoutClauseWording(
      withoutClauses(
        withoutBoundClauses(target, bound, standing),
        unbound.filter(strikesWholeClause),
      ),
      unbound
        .filter((constraint: CharterConstraint): boolean => !strikesWholeClause(constraint))
        .flatMap((constraint: CharterConstraint): string[] => constraint.wording),
    );
  };
  const lifted = apply(
    placedCharter(charter),
    struck.filter((constraint: CharterConstraint): boolean => !isProperty(constraint)),
  );
  const result = charterAfter(charter, apply(lifted, struck.filter(isProperty)));
  assertBoundariesKept(charter, charterAfter(charter, lifted), result, struck);
  return result;
}

/**
 * Drop every bounding clause carrying a whole-clause constraint's wording;
 * the function and the will-do clauses keep their sentences minus the words,
 * a will-do emptied by that going with them.
 */
function withoutClauses(
  target: PlacedCharter,
  struck: readonly CharterConstraint[],
): PlacedCharter {
  if (struck.length === 0) return target;
  const phrases = struck.flatMap((constraint: CharterConstraint): string[] => constraint.wording);
  const carries = (clause: PlacedClause): boolean =>
    phrases.some((phrase: string): boolean => wordingPresent(phrase, [clause.text]));
  const bounding = (field: ListField): PlacedClause[] =>
    target.lists[field].filter((clause: PlacedClause): boolean => !carries(clause));
  return {
    proposedFunction: functionWithout(target.proposedFunction, phrases),
    lists: {
      willDo: target.lists.willDo
        .map(
          (clause: PlacedClause): PlacedClause => ({
            ...clause,
            text: withoutPhrases(clause.text, phrases),
          }),
        )
        .filter((clause: PlacedClause): boolean => hasWording(clause.text)),
      willNotDo: bounding('willNotDo'),
      escalationTriggers: bounding('escalationTriggers'),
    },
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
  /** The proposed function with the rule's words gone, as it reads before and after (W13-R38). */
  rewrittenFunction?: { from: string; to: string };
  /** Clauses the rule binds that the strike keeps, each with why (W13-R6, W13-R7); absent when none. */
  keptClauses?: KeptClause[];
  /**
   * Whether the strike changes the charter at all: a rule whose words no clause carries, or whose
   * clauses another strike already takes, changes nothing, and is offered no Strike.
   */
  changes: boolean;
  /** Why the strike cannot be applied; when set, nothing is removed. */
  refusal?: string;
}

/** A clause a rule binds that its strike keeps, and why. */
export interface KeptClause {
  readonly clause: string;
  /**
   * `not-this-rule`: the clause does not carry the rule; `another-rule`: a rule left standing binds
   * it too (`rule`, its quote); `no-words`: a will-do the rule's words are not in.
   */
  readonly because: 'not-this-rule' | 'another-rule' | 'no-words';
  readonly rule?: string;
}

/** Why a strike that would change nothing is refused, on the card and at the server alike. */
export const STRIKE_CHANGES_NOTHING =
  'no clause carries its words any more, so striking it changes nothing';

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
 * @param charter - The charter as drafted, other strikes flagged.
 * @param index - The constraint to strike.
 * @returns The clauses the strike would remove and whether it changes the charter at all, or the
 *   reason it is refused.
 */
export function strikePreview(charter: ClauseCharter, index: number): StrikePreview {
  const constraints = [...(charter.constraints ?? [])];
  const target = constraints[index];
  if (!target) return { removedClauses: [], rewrittenClauses: [], changes: false };
  constraints[index] = { ...target, struck: true };
  const before = strikeOutcome(charter);
  const after = strikeOutcome({ ...charter, constraints });
  if (!after.ok) {
    return { removedClauses: [], rewrittenClauses: [], changes: false, refusal: after.reason };
  }
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
    // As `clauseChanges` pairs them: a will-do taken whole never pairs with the next one's rewrite.
    if (to !== undefined && !willDoBefore.includes(to) && isRewriteOf(clause, to)) {
      rewrittenClauses.push({ from: clause, to });
      position += 1;
    }
  }
  const rewritten = new Set(rewrittenClauses.map((pair): string => pair.from));
  const standing = constraints.filter(
    (constraint: CharterConstraint): boolean => constraint.struck !== true,
  );
  const keptClauses = (target.binds ?? []).flatMap((ref: ClauseRef): KeptClause[] => {
    const clause = ref.field === 'proposedFunction' ? undefined : clauseAt(charter, ref);
    // A clause another strike already takes is not this strike's to keep.
    if (clause === undefined || !kept.has(clause)) return [];
    const fate = boundClauseFate(target, ref, clause, standing);
    return fate.kind === 'keep'
      ? [{ clause, because: fate.because, ...(fate.rule === undefined ? {} : { rule: fate.rule }) }]
      : [];
  });
  const functionAfter = after.charter.proposedFunction;
  return {
    removedClauses: gone.filter((clause: string): boolean => !rewritten.has(clause)),
    rewrittenClauses,
    ...(functionAfter !== base.proposedFunction
      ? { rewrittenFunction: { from: base.proposedFunction, to: functionAfter } }
      : {}),
    ...(keptClauses.length > 0 ? { keptClauses } : {}),
    // The function is not one of the lists above, so what changes is asked of the whole charter.
    changes: clauseChanges(base, after.charter).length > 0,
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
 *   target: The clauses to edit, each list clause with its place.
 *   phrases: Whole-word phrases to remove.
 *
 * Returns:
 *   The clauses with the phrases gone; the same clauses when there are none.
 *
 * Raises:
 *   Error: When a phrase is only part of a will-not-do clause.
 */
function withoutClauseWording(target: PlacedCharter, phrases: readonly string[]): PlacedCharter {
  if (phrases.length === 0) return target;
  for (const clause of target.lists.willNotDo) {
    if (!phrases.some((phrase) => wordingPresent(phrase, [clause.text]))) continue;
    const remaining = withoutPhrases(clause.text, phrases);
    if (remaining !== clause.text && hasWording(remaining)) {
      throw new Error(
        'strike or edit the whole will-not-do clause; removing only part could change its boundary',
      );
    }
  }
  const list = (field: ListField): PlacedClause[] =>
    target.lists[field]
      .map(
        (clause: PlacedClause): PlacedClause => ({
          ...clause,
          text: withoutPhrases(clause.text, phrases),
        }),
      )
      .filter((clause: PlacedClause): boolean => hasWording(clause.text));
  return {
    proposedFunction: functionWithout(target.proposedFunction, phrases),
    lists: {
      willDo: list('willDo'),
      willNotDo: list('willNotDo'),
      escalationTriggers: list('escalationTriggers'),
    },
  };
}

/** Where a rule is in the charter, for the card to say beside it. */
export type RulePlacement =
  /** A rule drafted before rules were bound: placed by its words alone. */
  | { readonly kind: 'by-wording' }
  /** A rule no clause carries: the draft left it out, and approving does not keep it. */
  | { readonly kind: 'in-no-clause' }
  /**
   * A rule bound to the clauses it produced, and whether any of them carries the rule: its
   * verified wording or the manager's own words (`clauseCarriesRule`), the verification the card shows.
   */
  | {
      readonly kind: 'bound';
      readonly clauses: readonly string[];
      readonly carriesWords: boolean;
      /** The bound clauses that do not carry the rule, judged one by one (W13-R6). */
      readonly notCarrying: readonly string[];
    };

/** Words too common to tell one rule from another, and the pronouns a manager says for themself. */
const COMMON_WORDS: ReadonlySet<string> = new Set([
  'about',
  'all',
  'also',
  'and',
  'any',
  'are',
  'but',
  'can',
  'don',
  'each',
  'every',
  'for',
  'from',
  'has',
  'have',
  'into',
  'its',
  'just',
  'may',
  'myself',
  'never',
  'not',
  'now',
  'only',
  'our',
  'out',
  'should',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'was',
  'were',
  'what',
  'when',
  'which',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yourself',
]);

/**
 * A word's stem, enough to meet the same word inflected: "booked" and "book", "figures" and
 * "figure", "replies" and "reply", "going" and "go".
 */
function stem(word: string): string {
  const base =
    word.endsWith('ies') && word.length > 4
      ? `${word.slice(0, -3)}y`
      : word.endsWith('ing') && word.length >= 5
        ? word.slice(0, -3)
        : word.endsWith('ed') && word.length > 4
          ? word.slice(0, -2)
          : word.endsWith('es') && word.length > 4
            ? word.slice(0, -2)
            : word.endsWith('s') && !word.endsWith('ss') && word.length > 3
              ? word.slice(0, -1)
              : word;
  return base.endsWith('e') && base.length > 3 ? base.slice(0, -1) : base;
}

/** The stems of a text's words of three letters or more, the common ones left out. */
function contentStems(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((word: string): boolean => word.length >= 3 && !COMMON_WORDS.has(word))
      .map(stem),
  );
}

/** The words a rule forbids an act by, wherever in the rule they stand (the second pass on W13-R6). */
const FORBIDS =
  /\b(?:never|must not|mustn't|cannot|can't|do not|don't|should not|shouldn't|under no circumstances|not allowed to|no one may)\b/i;

/**
 * Whether a rule forbids an act (`PROHIBITION_OPENING`, or a forbidding word in any of its
 * sentences: "Sales owns the tracker. Never edit a booked figure.", "You must not ..."), so a
 * will-do or the function, which grant the act, never carries it.
 */
function forbidsAnAct(quote: string): boolean {
  return PROHIBITION_OPENING.test(quote.trim()) || FORBIDS.test(quote);
}

/** The manager's first person, which the drafter writes as "the manager"; never the "i" of "i.e.". */
const FIRST_PERSON = /\b(?:I|[Mm]e|[Mm]y|[Mm]yself)\b(?![.'\u2019]\w)/g;

/** A sentence that routes work through the manager: "Go through me for both.", "Ask me first." */
const THROUGH_ME = /\b(?:through|via)\s+me\b|\bask\s+me\s+(?:first|before)\b/i;

/**
 * What such a sentence becomes in a will-not-do or an escalation clause: the contact going through
 * the manager, or a contact made "directly" (a bare "directly", as in "Edit the ledger directly.",
 * names no contact).
 */
const THROUGH_THE_MANAGER =
  /\b(?:through|via)\s+the\s+manager\b|\bwithout\s+asking\s+the\s+manager\b|\bthe\s+manager\s+first\b|\b(?:contact|message|email|ask|reach|call|talk to|write to|go to)\b[^.;]*\bdirectly\b/i;

/**
 * Whether one clause carries a rule, judged on its own (W13-R6). A will-do or the function, which
 * grant an act, carries a rule forbidding one only when one of the rule's verified phrases is in it
 * and it states the prohibition itself (`statesTheProhibition`): "Edit any booked figure." never
 * carries "Never edit a booked figure.", nor does a will-do the drafter bound by a phrase of its own
 * (the v0.17.0 redeploy's finding 1). Any other clause carries the rule when one of its verified
 * phrases is in it; or when it holds more than half of the manager's own words in one sentence of
 * the rule, the manager's first person read as "the manager"; or when the sentence routes work
 * through the manager and the clause, a bounding one, keeps a contact going through the manager
 * ("Contact the support lead or billing directly."). On the recorded GLM drafts every right bind
 * carries the rule this way and no wrong one does (`GLM_BINDS_DRAFTS_2026_10_05`).
 *
 * @param constraint - The rule.
 * @param clause - The clause's words.
 * @param field - Where the clause is.
 */
function clauseCarriesRule(
  constraint: CharterConstraint,
  clause: string,
  field: ClauseRef['field'],
): boolean {
  const grants = field === 'willDo' || field === 'proposedFunction';
  // A phrase the drafter verified in a grant is a phrase of the grant, not the rule: the v0.17.0
  // redeploy drew Nell's "Never share a password in a ticket comment." as carried by "Draft replies
  // for the routine access tickets using the wiki steps." that way.
  const verified = constraint.wording.some((phrase: string): boolean =>
    wordingPresent(phrase, [clause]),
  );
  if (grants && forbidsAnAct(constraint.quote)) {
    return verified && statesTheProhibition(constraint, clause);
  }
  if (verified) return true;
  return quoteSentences(constraint.quote).some((sentence: string): boolean => {
    if (holdsMostOf(sentence, clause)) return true;
    return !grants && THROUGH_ME.test(sentence) && THROUGH_THE_MANAGER.test(clause);
  });
}

/**
 * The rule's sentences. A sentence ends before a capital, so "e.g. in a ticket comment" stays
 * inside its sentence.
 */
function quoteSentences(quote: string): string[] {
  return quote.split(/(?<=[.!?;])\s+(?=[A-Z"\u201c])/);
}

/**
 * Whether a text holds more than half of the manager's own words in one sentence of a rule, the
 * manager's first person read as "manager"; a fragment of one word is too little to read as the
 * rule.
 */
function holdsMostOf(sentence: string, text: string): boolean {
  const inText = contentStems(text);
  const said = contentStems(sentence.replace(FIRST_PERSON, 'manager'));
  const shared = [...said].filter((word: string): boolean => inText.has(word)).length;
  return said.size >= 2 && shared * 2 > said.size;
}

/** A word that limits a granted act: "Draft replies, never sharing a password.", "Send only after". */
const LIMITS_THE_ACT = new RegExp(`${FORBIDS.source}|\\bwithout\\b|\\bonly\\b`, 'i');

/**
 * Whether a will-do or the function, which grant an act, carries a rule that forbids one (the
 * redeploy's finding 1): it holds more than half of the manager's words in one sentence of the rule,
 * and, where that sentence forbids, a word that limits the act. "Answer access tickets, never
 * sharing a password in a ticket comment." carries "Never share a password in a ticket comment.";
 * "Route all client contact through the account manager." carries the rule's "Go through the
 * account manager." (the second pass); "Edit any booked figure." does not carry "Never edit a
 * booked figure.", and a will-do with none of the rule's words carries nothing, whatever phrase of
 * it the drafter verified.
 */
function statesTheProhibition(constraint: CharterConstraint, text: string): boolean {
  return quoteSentences(constraint.quote).some(
    (sentence: string): boolean =>
      holdsMostOf(sentence, text) && (!forbidsAnAct(sentence) || LIMITS_THE_ACT.test(text)),
  );
}

/**
 * The rule's verified phrases the function carries: each one in it, and, for a rule that forbids
 * an act, only one that states the prohibition, since the function grants what it names.
 */
function ruleWordsInFunction(constraint: CharterConstraint, proposedFunction: string): string[] {
  const forbids = forbidsAnAct(constraint.quote);
  return constraint.wording.filter(
    (phrase: string): boolean =>
      wordingPresent(phrase, [proposedFunction]) &&
      (!forbids || statesTheProhibition(constraint, phrase)),
  );
}

/**
 * Where a rule is in the charter: by its words alone (a rule drafted before binds), in no clause,
 * or in the clauses it binds, with whether each carries the rule (`clauseCarriesRule`). A bound
 * function is shown as the rule's words in it; one that carries none of them places the rule
 * nowhere, since a strike leaves the function's sentence whole.
 *
 * @param charter - The charter the rule's binds index, as drafted or as approved.
 * @param constraint - One of its rules.
 */
export function rulePlacement(
  charter: ClauseCharter,
  constraint: CharterConstraint,
): RulePlacement {
  if (constraint.binds === undefined) return { kind: 'by-wording' };
  // The function is the role's one sentence and a strike only ever takes the rule's words from it,
  // so a function bind is shown, and verified, as those words, and as nothing when it has none.
  const inFunction = ruleWordsInFunction(constraint, charter.proposedFunction);
  const listed = constraint.binds.flatMap((ref: ClauseRef): Array<[string, boolean]> => {
    if (ref.field === 'proposedFunction') return [];
    const clause = clauseAt(charter, ref);
    return clause === undefined ? [] : [[clause, clauseCarriesRule(constraint, clause, ref.field)]];
  });
  const boundToFunction = constraint.binds.some(
    (ref: ClauseRef): boolean => ref.field === 'proposedFunction',
  );
  const clauses = [...(boundToFunction ? inFunction : []), ...listed.map(([clause]) => clause)];
  if (clauses.length === 0) return { kind: 'in-no-clause' };
  return {
    kind: 'bound',
    clauses,
    carriesWords:
      (boundToFunction && inFunction.length > 0) || listed.some(([, carries]) => carries),
    notCarrying: listed.flatMap(([clause, carries]) => (carries ? [] : [clause])),
  };
}

/**
 * The rules with their binds counted again after one list clause is taken out: a bind to it is
 * dropped and one after it in the same list moves up. A rule drafted before binds is returned as
 * it is.
 *
 * @param constraints - The charter's rules, binds indexing the lists before the removal.
 * @param field - The list the clause was taken from.
 * @param index - Its place there before the removal.
 */
export function withClauseRemoved(
  constraints: readonly CharterConstraint[],
  field: ListField,
  index: number,
): CharterConstraint[] {
  return constraints.map(
    (constraint: CharterConstraint): CharterConstraint =>
      constraint.binds === undefined
        ? constraint
        : {
            ...constraint,
            binds: constraint.binds.flatMap((ref: ClauseRef): ClauseRef[] => {
              if (ref.field !== field || ref.index < index) return [ref];
              return ref.index === index ? [] : [{ field, index: ref.index - 1 }];
            }),
          },
  );
}

/** A clause a strike can change: the function, or an item of one of the lists. */
export type StruckClauseField = 'proposedFunction' | (typeof LIST_FIELDS)[number];

/**
 * A clause the manager's strikes changed at approval, kept so the record can show it struck: taken
 * out whole, or rewritten with the struck wording gone (`rewrittenAs`, what it reads now).
 */
export interface StruckClause {
  readonly field: StruckClauseField;
  readonly text: string;
  readonly rewrittenAs?: string;
}

/** A clause's words, lower-cased, without punctuation. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}'-]+/gu) ?? [];
}

/**
 * Whether `to` is `from` with words taken out: a strike removes wording and never adds any, so a
 * rewritten clause's words are the original's, in order. A will-do the strike emptied is dropped
 * and never pairs with the next clause's rewrite.
 */
function isRewriteOf(from: string, to: string): boolean {
  const remaining = wordsOf(to);
  if (remaining.length === 0) return false;
  let next = 0;
  for (const word of wordsOf(from)) {
    if (word === remaining[next]) next += 1;
    if (next === remaining.length) return true;
  }
  return false;
}

/**
 * What the strikes did to the clauses between a draft and its effective charter: each list clause
 * taken out whole, each will-do rewritten in place (paired in order, as `strikePreview` pairs
 * them), and the function when its wording changed.
 *
 * @param before - The charter as drafted.
 * @param after - The same charter with its strikes applied (`strikeOutcome`).
 */
export function clauseChanges(before: ClauseCharter, after: ClauseCharter): StruckClause[] {
  const changes: StruckClause[] = [];
  if (before.proposedFunction !== after.proposedFunction) {
    changes.push({
      field: 'proposedFunction',
      text: before.proposedFunction,
      rewrittenAs: after.proposedFunction,
    });
  }
  const willDoBefore = before.proposedBoundaries.willDo;
  const willDoAfter = after.proposedBoundaries.willDo;
  let position = 0;
  for (const clause of willDoBefore) {
    if (willDoAfter[position] === clause) {
      position += 1;
      continue;
    }
    const to = willDoAfter[position];
    if (to !== undefined && !willDoBefore.includes(to) && isRewriteOf(clause, to)) {
      changes.push({ field: 'willDo', text: clause, rewrittenAs: to });
      position += 1;
    } else {
      changes.push({ field: 'willDo', text: clause });
    }
  }
  for (const field of BOUNDING_FIELDS) {
    for (const clause of before.proposedBoundaries[field]) {
      if (!after.proposedBoundaries[field].includes(clause)) changes.push({ field, text: clause });
    }
  }
  return changes;
}
