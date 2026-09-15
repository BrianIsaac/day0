/**
 * What an approved plan step commits the run to, read the same way by the
 * executor (which decides whether a run has a closing phase) and the gate
 * (which checks the closing phase against the plan).
 */

/** A verb that reads, checks or captures something the closing phase reasons from. */
const RESULT_VERB =
  /\b(read|check|identify|inspect|verify|validate|find|look up|snapshot)\b/gi;
/** A noun for such a result; a promise only outside a clause that writes. */
const RESULT_NOUN = /\b(evidence|result)\b/gi;
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
const QUOTED_SPAN = /"[^"\n]*"|“[^”\n]*”/g;

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

/**
 * Every occurrence of a term used as a word of its own. A term inside a
 * hyphenated compound on either side ("read-back", "close-week"), after a
 * determiner, "end" or a period label, or followed by a period noun is
 * vocabulary, not an instruction, and is left out.
 */
function occurrences(rawStep: string, terms: RegExp, nounHead?: RegExp): TermOccurrence[] {
  const step = instructionText(rawStep);
  const found: TermOccurrence[] = [];
  terms.lastIndex = 0;
  for (let match = terms.exec(step); match; match = terms.exec(step)) {
    if (step[match.index - 1] === '-') continue;
    const after = step.slice(match.index + match[0].length);
    if (after.startsWith('-') || PERIOD_NOUN.test(after)) continue;
    if (nounHead?.test(after)) continue;
    const prefix = step.slice(0, match.index);
    if (NOUN_MARKER.test(prefix) || PERIOD_LABEL.test(prefix)) continue;
    const start = clauseStart(prefix);
    const clausePrefix = prefix.slice(start);
    found.push({
      term: match[0].toLowerCase(),
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
    (occurrence) => affirmed(occurrence) && !writesInClause(occurrence.clause),
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
  return occurrences(step, CLOSE_STEP, CLOSE_NOUN_HEAD).some(affirmed);
}
