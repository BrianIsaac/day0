/**
 * What an approved plan step commits the run to, read the same way by the
 * executor (which decides whether a run has a closing phase) and the gate
 * (which checks the closing phase against the plan).
 */

const RESULT_STEP =
  /\b(read|read-back|check|identify|inspect|verify|validate|find|look up|snapshot|evidence|result)\b/gi;
const CLOSE_STEP = /\b(close|closed|complete|completed|done|resolve|resolved)\b/gi;
const CLAUSE_BOUNDARY = /\b(?:after|before|but|once|then|until)\b|[.;\n]/gi;
const NEGATED_INSTRUCTION = /\b(?:defer|do not|don't|hold|never|not|wait for|without|withhold)\b/i;
/** A term that names a period is a noun phrase ("close week", "close of quarter"), not a verb. */
const PERIOD_NOUN = /^\s*(?:of\s+(?:the\s+)?)?(?:day|week|month|quarter|year|period|cycle|date)s?\b/i;
/** A term after a determiner or "end" is a noun ("the close", "month-end close"), not a verb. */
const NOUN_MARKER = /\b(?:the|a|an|our|its|their|this|that|each|every|end|of)\s+$/i;
const QUOTED_SPAN = /"[^"\n]*"|\u201c[^\u201d\n]*\u201d/g;

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

/**
 * Whether at least one occurrence is an instruction to act rather than to
 * withhold. A term inside a hyphenated compound on either side ("read-back",
 * "close-week"), after a determiner or "end", or followed by a period noun is
 * vocabulary, not an instruction.
 */
function affirmedStepTerm(rawStep: string, terms: RegExp): boolean {
  const step = instructionText(rawStep);
  terms.lastIndex = 0;
  for (let match = terms.exec(step); match; match = terms.exec(step)) {
    if (step[match.index - 1] === '-') continue;
    const after = step.slice(match.index + match[0].length);
    if (after.startsWith('-') || PERIOD_NOUN.test(after)) continue;
    const prefix = step.slice(0, match.index);
    if (NOUN_MARKER.test(prefix)) continue;
    CLAUSE_BOUNDARY.lastIndex = 0;
    let boundary = 0;
    for (
      let separator = CLAUSE_BOUNDARY.exec(prefix);
      separator;
      separator = CLAUSE_BOUNDARY.exec(prefix)
    ) {
      boundary = CLAUSE_BOUNDARY.lastIndex;
    }
    if (!NEGATED_INSTRUCTION.test(prefix.slice(boundary))) return true;
  }
  return false;
}

/** Whether a step promises a read, a check or a result the closing phase reasons from. */
export function promisesResult(step: string): boolean {
  return affirmedStepTerm(step, RESULT_STEP);
}

/** Whether a step promises to close, complete or resolve the ticket. */
export function promisesClose(step: string): boolean {
  return affirmedStepTerm(step, CLOSE_STEP);
}

