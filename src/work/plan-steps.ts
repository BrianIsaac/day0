/**
 * What an approved plan step commits the run to, read the same way by the
 * executor (which decides whether a run has a closing phase) and the gate
 * (which checks the closing phase against the plan).
 */

import type { ExecutionPlan } from './types';

/** A verb that reads, checks or captures something the closing phase reasons from. */
const RESULT_VERB =
  /\b(read|check|identify|inspect|verify|validate|find|look up|snapshot)\b/gi;
/** A noun for such a result; a promise only outside a clause that writes, unless a capture verb governs it. */
const RESULT_NOUN = /\b(evidence|result)\b/gi;
/** A verb that gathers a result ("gather evidence", "capture the result"): the noun after it is a promise wherever it sits. */
const CAPTURE_VERB = /\b(?:gather|capture|collect|obtain|retrieve|extract|pull)\s+(?:the\s+|any\s+|its\s+|all\s+)?$/i;
const CLOSE_STEP = /\b(close|closed|complete|completed|done|resolve|resolved)\b/gi;
/** An instruction that changes a surface: the clause it heads is a write. */
const WRITE_STEP =
  /\b(add|append|attach|comment|dm|message|move|notify|post|publish|record|reply|save|send|set|submit|transition|update|write)\b/gi;
const CLAUSE_BOUNDARY = /\b(?:after|before|but|once|then|until)\b|[.;\n]/gi;
const NEGATED_INSTRUCTION = /\b(?:defer|do not|don't|hold|never|not|wait for|without|withhold)\b/i;
/** A term that names a period is a noun phrase ("close week", "close of quarter"), not a verb. */
const PERIOD_NOUN = /^\s*(?:of\s+(?:the\s+)?)?(?:day|week|month|quarter|year|period|cycle|date)s?\b/i;
/** A term after a determiner or "end" is a noun ("the close", "month-end close"), not a verb. */
const NOUN_MARKER = /\b(?:the|a|an|our|its|their|this|that|each|every|end|of)\s+$/i;
/** A period label before the term names a close ("Q3 close", "FY26 close", "2026 close"). */
const PERIOD_LABEL = /\b(?:q[1-4]|h[12]|fy\s?\d{2,4}|(?:19|20)\d\d|(?:month|quarter|year|week)[- ]end)\s+$/i;
/** A noun after a close term makes it an adjunct ("close project", "close checklist"). */
const CLOSE_NOUN_HEAD =
  /^\s+(?:projects?|checklists?|checks|process|calendar|timeline|package|summary|summaries|tasks?|items?|work|notes?|reports?|board|window|meetings?|status)\b/i;
/**
 * A clause prefix that leaves the term in imperative position: nothing, or
 * only a connective, a courtesy or a negation ("Close items ...", "Do not
 * close tasks ..."). There the noun after the term is its object, not its
 * head.
 */
const IMPERATIVE_PREFIX = /^\s*(?:(?:and|or|then|also|finally|now|please|do not|don't|never|always)\s+)*$/i;
/** A plan's own words for leaving the ticket state where it is. */
const NO_TRANSITION =
  /\bno (?:status|state) (?:change|transition)\b|\b(?:status|state) (?:is )?(?:unchanged|stays|remains)\b|\bleave (?:\S+\s+){0,3}(?:open|unchanged|as is|in progress|to the manager)\b/i;
const QUOTED_SPAN = /"[^"\n]*"|“[^”\n]*”/g;
/**
 * The alternative branch of a stated condition, to the sentence end
 * ("set ... to Done only if ...; otherwise leave it in progress"). What it
 * says about the state holds only when the condition fails, so it is not
 * the plan's word on the transition.
 */
const ALTERNATIVE_BRANCH = /\b(?:otherwise|or else|else|failing that|if not)\b[^.;\n]*/gi;

/**
 * The text with every alternative branch to a promised close read out. An
 * alternative that follows no promised close, back to the previous full
 * stop or line break ("Post the comment if the figure matches; otherwise
 * leave it in progress"), is the sentence's only word on the state and
 * stays. A branch that opens a sentence ("... to Done. Otherwise leave it
 * in progress") answers the sentence before it.
 */
function withoutAlternativeToClose(text: string): string {
  return text.replace(ALTERNATIVE_BRANCH, (branch: string, offset: number): string => {
    const before = text.slice(0, offset).trimEnd().replace(/\.$/, '');
    const sentenceStart = Math.max(before.lastIndexOf('.'), before.lastIndexOf('\n')) + 1;
    return promisesClose(before.slice(sentenceStart)) ? ' ' : branch;
  });
}

/** Titles are references; quoted surface names and target states still impose obligations. */
export function instructionText(step: string): string {
  return step.replace(QUOTED_SPAN, (span: string, offset: number): string => {
    const before = step.slice(0, offset);
    const after = step.slice(offset + span.length);
    const titleContext =
      /\b(?:ticket|issue|request|message)\s+(?:(?:titled|called|named)\s+)?$/i.test(before) ||
      /^\s+(?:ticket|issue|request|message|title|mismatch)\b/i.test(after);
    return titleContext ? ' ' : span.slice(1, -1);
  });
}

/** One occurrence of a term with the text around it. */
interface TermOccurrence {
  term: string;
  /** Where the term starts in the instruction text. */
  index: number;
  /** The clause the term sits in, from the last boundary before it to the next after it. */
  clause: string;
  /** The clause up to the term. */
  clausePrefix: string;
}

function clauseStart(prefix: string): number {
  CLAUSE_BOUNDARY.lastIndex = 0;
  let boundary = 0;
  for (let separator = CLAUSE_BOUNDARY.exec(prefix); separator; separator = CLAUSE_BOUNDARY.exec(prefix)) {
    boundary = CLAUSE_BOUNDARY.lastIndex;
  }
  return boundary;
}

function clauseEnd(after: string): number {
  CLAUSE_BOUNDARY.lastIndex = 0;
  const separator = CLAUSE_BOUNDARY.exec(after);
  return separator ? separator.index : after.length;
}

interface OccurrenceOptions {
  /** A noun that makes the term before it an adjunct ("close project"). */
  nounHead?: RegExp;
  /** Whether a determiner before the term makes it vocabulary; a withheld "the Done transition" is still about the close. */
  determinerIsVocabulary?: boolean;
}

/**
 * Every occurrence of a term used as a word of its own. A term inside a
 * hyphenated compound on either side ("read-back", "close-week"), after a
 * determiner, "end" or a period label, or followed by a period noun is
 * vocabulary, not an instruction, and is left out.
 */
function occurrences(rawStep: string, terms: RegExp, options: OccurrenceOptions = {}): TermOccurrence[] {
  const step = instructionText(rawStep);
  const found: TermOccurrence[] = [];
  terms.lastIndex = 0;
  for (let match = terms.exec(step); match; match = terms.exec(step)) {
    if (step[match.index - 1] === '-') continue;
    const after = step.slice(match.index + match[0].length);
    if (after.startsWith('-') || PERIOD_NOUN.test(after)) continue;
    const prefix = step.slice(0, match.index);
    const clausePrefix = prefix.slice(clauseStart(prefix));
    if (options.nounHead?.test(after) && !IMPERATIVE_PREFIX.test(clausePrefix)) continue;
    if (PERIOD_LABEL.test(prefix)) continue;
    if (options.determinerIsVocabulary !== false && NOUN_MARKER.test(prefix)) continue;
    found.push({
      term: match[0].toLowerCase(),
      index: match.index,
      clause: clausePrefix + match[0] + after.slice(0, clauseEnd(after)),
      clausePrefix,
    });
  }
  return found;
}

/** Whether the occurrence is an instruction to act rather than to withhold. */
function affirmed(occurrence: TermOccurrence): boolean {
  return !NEGATED_INSTRUCTION.test(occurrence.clausePrefix);
}

function writesInClause(clause: string): boolean {
  WRITE_STEP.lastIndex = 0;
  return WRITE_STEP.test(clause);
}

/**
 * The first term by which a step promises a read, a check or a result the
 * closing phase reasons from: a result verb, or a result noun outside a
 * clause that writes ("quoting the audit line as evidence" is what a
 * comment carries, not a read it promises).
 *
 * Args:
 *   step: An approved plan step.
 *
 * Returns:
 *   The promising term in lower case, or undefined when the step promises none.
 */
export function promisedResultTerm(step: string): string | undefined {
  const verb = occurrences(step, RESULT_VERB).find(affirmed);
  if (verb) return verb.term;
  const noun = occurrences(step, RESULT_NOUN).find(
    (occurrence) =>
      affirmed(occurrence) &&
      (CAPTURE_VERB.test(occurrence.clausePrefix) || !writesInClause(occurrence.clause)),
  );
  return noun?.term;
}

/** Whether a step promises a read, a check or a result the closing phase reasons from. */
export function promisesResult(step: string): boolean {
  return promisedResultTerm(step) !== undefined;
}

/** Whether a step instructs a write to a surface: a comment, a message, a state change, a save. */
export function promisesWrite(step: string): boolean {
  return occurrences(step, WRITE_STEP).some(affirmed);
}

/** Whether a step promises to close, complete or resolve the ticket. */
export function promisesClose(step: string): boolean {
  return occurrences(step, CLOSE_STEP, { nounHead: CLOSE_NOUN_HEAD }).some(affirmed);
}

/**
 * The text with every clause that carries a condition read out, when the
 * plan promises the close: "If the audit line is absent, leave it in
 * progress" and "leave it in progress if the audit line is absent" are one
 * branch of a conditional close, the same instruction as "set it to Done
 * only if ...; otherwise leave it in progress" in another word order. A
 * clause ends at a connective or a colon, so the explanation after "Do
 * not move REVOPS-5 to Done:" never lends its condition to the
 * withholding before it. When the plan promises no close, a withholding
 * under a condition is its only word on the state and stays.
 */
function withoutConditionalBranches(text: string, closePromised: boolean): string {
  if (!closePromised) return text;
  return text
    .split(/(?<=[.;\n])/)
    .map((sentence) =>
      sentence
        .split(/(?<=:)|(?=\b(?:after|before|but|once|then|until)\b)/i)
        .map((clause) => (CONDITION_MARKER.test(clause) ? ' ' : clause))
        .join(''),
    )
    .join('');
}

/**
 * Whether a step, or the plan's summary, says in its own words that the
 * ticket state is left where it is: a close term under a negation ("do not
 * move REVOPS-5 to Done"), or a phrase such as "no status change". The
 * alternative branch of a promised close ("set ... to Done only if ...;
 * otherwise leave it in progress") is read out first: it withholds only
 * when the condition fails. So is a withholding under a condition, when
 * the plan promises the close (see `withoutConditionalBranches`).
 *
 * Args:
 *   text: A plan step or summary.
 *   closePromised: Whether the plan promises the close anywhere; the text's
 *     own promise by default.
 */
export function withholdsClose(text: string, closePromised: boolean = promisesClose(text)): boolean {
  const stated = withoutConditionalBranches(withoutAlternativeToClose(instructionText(text)), closePromised);
  if (NO_TRANSITION.test(stated)) return true;
  return occurrences(stated, CLOSE_STEP, { nounHead: CLOSE_NOUN_HEAD, determinerIsVocabulary: false }).some(
    (occurrence) => !affirmed(occurrence),
  );
}

/**
 * Whether a plan commits the run to the ticket's state transition: a step
 * promises the close and neither the summary nor any step withholds it. A
 * plan that withholds the transition in its own words never promised it,
 * so a closing phase that leaves the state alone satisfies that plan.
 */
export function planPromisesClose(plan: Pick<ExecutionPlan, 'summary' | 'steps'>): boolean {
  if (!plan.steps.some(promisesClose)) return false;
  return !planWithholdsClose(plan);
}

/**
 * Whether a plan says in its own words that the ticket state is left where
 * it is, in its summary or in any step. The gate holds a state change
 * against such a plan for the manager, whatever the autonomy switch says.
 */
export function planWithholdsClose(plan: Pick<ExecutionPlan, 'summary' | 'steps'>): boolean {
  const closePromised = plan.steps.some(promisesClose);
  return withholdsClose(plan.summary, closePromised) || plan.steps.some((step) => withholdsClose(step, closePromised));
}

/** A surface an approved plan may name, by slug or display name. */
export interface NamedSurface {
  slug: string;
  displayName: string;
}

/** A read an approved plan step promises of one surface. */
export interface PromisedRead {
  /** The step number, from 1. */
  step: number;
  /** The result term that promised the read, lower case. */
  term: string;
  /** The clause the term and the surface share. */
  clause: string;
  surface: NamedSurface;
  /** The term sits under a condition, and no step reads the surface outright. */
  conditional: boolean;
}

/**
 * A word that opens a condition. A result term after it refers to a read
 * the plan makes elsewhere ("only if the audit line was read back").
 */
const CONDITION_MARKER = /(?<!\beven\s)\b(?:only if|if|unless|whenever|when|provided(?: that)?|so long as|as long as|as soon as|in case)\b/i;
/** A sentence ends at a full stop that is not part of an ellipsis, a semicolon or a line break. */
const SENTENCE_END = /(?<!\.)\.(?!\.)|[;\n]/g;
/** A connective that starts a new clause inside a sentence. */
const CLAUSE_CONNECTIVE = /\b(?:after|before|but|once|then|until)\b/gi;
/** A verb of capture: the noun after it is a result the step gathers, and a surface it governs is what is read. */
const CAPTURE_WORD = /\b(?:gather|capture|collect|obtain|retrieve|extract|pull)\b/gi;
/** A surface as the subject of what a condition consults ("only if Linear reports the ticket in Backlog"). */
const SUBJECT_READ = /^\s+(reports?|shows?|confirms?|returns?|lists?|says?|indicates?)\b/i;

interface Span {
  start: number;
  end: number;
}

interface Mention extends Span {
  surface: NamedSurface;
}

interface Verb extends Span {
  reads: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every whole-word mention of a listed surface in the text, by slug or
 * display name. A name followed by a hyphenated number is a ticket
 * identifier ("REVOPS-7"), not the surface, and a name inside a longer
 * surface name ("Looker" in "Looker pipeline tile") is that surface's.
 */
function surfaceMentions(text: string, surfaces: readonly NamedSurface[]): Mention[] {
  const mentions: Mention[] = [];
  for (const surface of surfaces) {
    for (const name of new Set([surface.slug, surface.displayName].filter(Boolean))) {
      const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi');
      for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
        const end = match.index + match[0].length;
        if (/^-\d/.test(text.slice(end))) continue;
        mentions.push({ surface, start: match.index, end });
      }
    }
  }
  return mentions
    .filter((mention) => !mentions.some((other) =>
      other !== mention && other.start <= mention.start && other.end >= mention.end &&
      (other.end - other.start) > (mention.end - mention.start)))
    .sort((a, b) => a.start - b.start);
}

/** A word that opens a noun phrase: a determiner, or a possessive ("the manager's"). */
const NOUN_PHRASE_OPENER = /^(?:the|a|an|our|its|their|this|that|these|those|each|every|any|all|no|your|my)$|['\u2019]s$/i;
/**
 * A word that ends a noun phrase before the term: the term after it is an
 * instruction of its own ("the ticket and comment", "the figure you read").
 */
const PHRASE_BREAK = /^(?:and|or|then|but|to|in|on|at|of|for|from|via|with|by|into|onto|after|before|once|until|not|you|we|i|they|it|which|who)$/i;

/**
 * Whether the term after this prefix is the head of a noun phrase rather
 * than an instruction: a determiner or possessive opens the phrase within
 * two words of it, with no conjunction, preposition or pronoun between
 * ("the manager's comment", "the latest message", "the standup summary
 * post"), back to the last punctuation. Read only for write words: a read
 * word after a noun phrase is a relative clause ("the figure you read").
 */
function headsNounPhrase(prefix: string): boolean {
  const segment = prefix.split(/[,;:.()\n]/).pop() ?? '';
  const words = segment.trim().split(/\s+/).filter(Boolean).slice(-3);
  return words.some((word, index) =>
    NOUN_PHRASE_OPENER.test(word) && words.slice(index + 1).every((later) => !PHRASE_BREAK.test(later)));
}

/** Every instruction verb in the text with whether it reads (a result or capture verb) or writes. */
function instructionVerbs(text: string): Verb[] {
  const verbs: Verb[] = [];
  const scan = (terms: RegExp, reads: boolean): void => {
    terms.lastIndex = 0;
    for (let match = terms.exec(text); match; match = terms.exec(text)) {
      if (text[match.index - 1] === '-' || text[match.index + match[0].length] === '-') continue;
      const prefix = text.slice(0, match.index);
      if (NOUN_MARKER.test(prefix) || (!reads && headsNounPhrase(prefix))) continue;
      verbs.push({ start: match.index, end: match.index + match[0].length, reads });
    }
  };
  scan(RESULT_VERB, true);
  scan(CAPTURE_WORD, true);
  scan(WRITE_STEP, false);
  return verbs.sort((a, b) => a.start - b.start);
}

/**
 * The instruction verb that governs a surface mention: the nearest before
 * it, or the first after it when the mention opens the span ("In Linear,
 * read the ticket"). Undefined when the span has no instruction verb, as
 * a bare result noun's has ("Evidence from Linear").
 */
function governingVerb(mention: Span, verbs: readonly Verb[]): Verb | undefined {
  const before = verbs.filter((verb) => verb.end <= mention.start);
  return before.length > 0 ? before[before.length - 1] : verbs.find((verb) => verb.start >= mention.end);
}

/** Whether a surface mention is what the span reads: its governing verb reads, or nothing governs it. */
function readGoverns(mention: Span, verbs: readonly Verb[]): boolean {
  const governing = governingVerb(mention, verbs);
  return governing === undefined || governing.reads;
}

/**
 * Whether a sentence's locus is what a span reads: some read verb in the
 * span governs no surface mention of its own, or the span has a result
 * term and no read verb at all ("Sign in to the tile, set 74%, save and
 * snapshot the audit line": the snapshot is of the tile; "On linear, add a
 * comment quoting the figure you read on the tile": the read is of the
 * tile, so Linear is only written).
 */
function locusRead(span: Span, verbs: readonly Verb[], mentions: readonly Mention[]): boolean {
  const readVerbs = verbs.filter((verb) => verb.reads);
  if (readVerbs.length === 0) return true;
  const governed = new Set(mentions.map((mention) => governingVerb(mention, verbs)?.start));
  return readVerbs.some((verb) => !governed.has(verb.start));
}

/** The sentences of the instruction text, as spans. */
function sentencesOf(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  SENTENCE_END.lastIndex = 0;
  for (let match = SENTENCE_END.exec(text); match; match = SENTENCE_END.exec(text)) {
    spans.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  spans.push({ start, end: text.length });
  return spans.filter((span) => text.slice(span.start, span.end).trim() !== '');
}

/** The clauses of a sentence span, split at the connectives. */
function clausesOf(text: string, sentence: Span): Span[] {
  const spans: Span[] = [];
  let start = sentence.start;
  CLAUSE_CONNECTIVE.lastIndex = sentence.start;
  for (let match = CLAUSE_CONNECTIVE.exec(text); match && match.index < sentence.end; match = CLAUSE_CONNECTIVE.exec(text)) {
    spans.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  spans.push({ start, end: sentence.end });
  return spans.filter((span) => text.slice(span.start, span.end).trim() !== '');
}

/**
 * A clause split at its condition. A condition that opens the clause ends
 * at its comma ("If the page redirects, record the failure"), so what
 * follows is the instruction; one that follows the instruction runs to the
 * clause end ("set ... to Done only if the audit line was read back").
 */
function splitCondition(text: string, clause: Span): { main: Span; condition?: Span } {
  const body = text.slice(clause.start, clause.end);
  const marker = CONDITION_MARKER.exec(body);
  if (!marker) return { main: clause };
  const at = clause.start + marker.index;
  if (IMPERATIVE_PREFIX.test(body.slice(0, marker.index))) {
    const comma = body.indexOf(',', marker.index);
    if (comma < 0) return { main: { start: clause.start, end: clause.start }, condition: clause };
    return { main: { start: clause.start + comma + 1, end: clause.end }, condition: { start: clause.start, end: clause.start + comma } };
  }
  return { main: { start: clause.start, end: at }, condition: { start: at, end: clause.end } };
}

/**
 * The surfaces a sentence opens on, its locus: the mentions in the
 * sentence's first segment (up to its first comma or colon) when no
 * instruction verb precedes them there ("On linear, set ...", "On the
 * looker-pipeline-tile surface, run ...", "Sign in to the Looker pipeline
 * tile, set 74% ..."). The locus names where every clause of the sentence
 * acts. A first segment an instruction verb opens ("Read the ticket on
 * Linear, then ...") has no locus: its mentions are that verb's.
 */
function sentenceLocus(text: string, sentence: Span, mentions: readonly Mention[], verbs: readonly Verb[]): Mention[] {
  const body = text.slice(sentence.start, sentence.end);
  const comma = body.search(/[,:]/);
  const segment: Span = { start: sentence.start, end: comma < 0 ? sentence.end : sentence.start + comma };
  const named = mentions.filter((mention) => mention.start >= segment.start && mention.end <= segment.end);
  if (named.length === 0) return [];
  if (verbs.some((verb) => verb.start >= segment.start && verb.end <= named[0]!.start)) return [];
  return named;
}

function trimClause(text: string): string {
  return text.trim().replace(/^[,:\s]+|[,:\s]+$/g, '');
}

/** The result terms in a span: the step's promising terms that fall inside it. */
function termsIn(occurrences: readonly TermOccurrence[], span: Span): TermOccurrence[] {
  return occurrences.filter((occurrence) => occurrence.index >= span.start && occurrence.index < span.end);
}

/**
 * The result terms of a step, every occurrence: a result verb, or a result
 * noun a capture verb governs or that sits outside a clause that writes.
 */
function resultOccurrences(step: string): TermOccurrence[] {
  const verbs = occurrences(step, RESULT_VERB).filter(affirmed);
  const nouns = occurrences(step, RESULT_NOUN).filter(
    (occurrence) =>
      affirmed(occurrence) &&
      (CAPTURE_VERB.test(occurrence.clausePrefix) || !writesInClause(occurrence.clause)),
  );
  return [...verbs, ...nouns].sort((a, b) => a.index - b.index);
}

/**
 * Every read an approved plan promises, bound to the surface the read acts
 * on. A step promises a read of a surface only when a result term and the
 * surface share a clause and the surface is what is read: the nearest
 * instruction verb governing the surface reads rather than writes, or the
 * surface opens the sentence and a read in the clause has no surface of
 * its own (see `locusRead`). A surface
 * named as a write target ("On linear, set ... to Done", "post it to
 * Linear") is never a promised read. A result term under a condition refers
 * to a read made elsewhere: it binds only when no step reads that surface
 * outright, and is marked conditional. A read that names no surface binds
 * to nothing.
 *
 * Args:
 *   steps: The approved plan's steps, in order.
 *   surfaces: The surfaces the plan may name.
 *
 * Returns:
 *   The promised reads in step order; one per step and surface.
 */
export function promisedReads(steps: readonly string[], surfaces: readonly NamedSurface[]): PromisedRead[] {
  const reads: PromisedRead[] = [];
  steps.forEach((rawStep, stepIndex): void => {
    const text = instructionText(rawStep);
    const occurrences = resultOccurrences(rawStep);
    const mentions = surfaceMentions(text, surfaces);
    const verbs = instructionVerbs(text);
    const found = new Map<string, PromisedRead>();
    const bind = (span: Span, term: TermOccurrence, surface: NamedSurface, conditional: boolean): void => {
      const key = `${surface.slug}:${conditional ? 'c' : 'o'}`;
      if (found.has(key)) return;
      found.set(key, { step: stepIndex + 1, term: term.term, clause: trimClause(text.slice(span.start, span.end)), surface, conditional });
    };
    const within = <T extends Span>(items: readonly T[], span: Span): T[] =>
      items.filter((item) => item.start >= span.start && item.end <= span.end);
    for (const sentence of sentencesOf(text)) {
      const locus = sentenceLocus(text, sentence, mentions, verbs);
      for (const clause of clausesOf(text, sentence)) {
        const { main, condition } = splitCondition(text, clause);
        const mainTerms = termsIn(occurrences, main);
        if (mainTerms.length > 0) {
          const spanVerbs = within(verbs, main);
          const spanMentions = within(mentions, main).filter((mention) => !locus.includes(mention));
          for (const mention of spanMentions) {
            if (readGoverns(mention, spanVerbs)) bind(main, mainTerms[0]!, mention.surface, false);
          }
          if (locus.length > 0 && locusRead(main, spanVerbs, spanMentions)) {
            for (const mention of locus) bind(main, mainTerms[0]!, mention.surface, false);
          }
        }
        if (!condition) continue;
        const spanVerbs = within(verbs, condition);
        const conditionTerms = termsIn(occurrences, condition);
        for (const mention of within(mentions, condition)) {
          const subject = SUBJECT_READ.exec(text.slice(mention.end, condition.end));
          if (subject) {
            bind(condition, { term: subject[1]!.toLowerCase(), index: mention.end, clause: '', clausePrefix: '' }, mention.surface, true);
          } else if (conditionTerms.length > 0 && readGoverns(mention, spanVerbs)) {
            bind(condition, conditionTerms[0]!, mention.surface, true);
          }
        }
      }
    }
    reads.push(...found.values());
  });
  const outright = new Set(reads.filter((read) => !read.conditional).map((read) => read.surface.slug));
  return reads.filter((read) => !read.conditional || !outright.has(read.surface.slug));
}
