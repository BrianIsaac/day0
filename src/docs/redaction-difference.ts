/*
 * Whether two stored texts of one page differ in more than their redaction (wave 17, 17-FD;
 * W15-R42, W16-R34). A page is stored redacted, so a sync that stores it again with other words
 * has either read other words at the source or redacted the same words otherwise: a value taken
 * out that was left in before, a marker under another label. Only the first is a change a skill
 * that read the page must be checked against. The page's hash before redaction settles it where
 * both stores carry one under the same key, redaction and models; where they do not (a page whose
 * split never wrote its hash, a release that re-takes every hash), the two stored texts are all
 * there is to read, and this reads them.
 *
 * Pure, and apart from `./redaction`, whose code a page's hash is pinned to: this reads the
 * markers that module and `src/redaction/redact.ts` write and changes nothing about how a page
 * is redacted.
 */

/** A marker the redaction leaves where it took a value out: a stored credential, or personal data. */
const MARKER = /<credential:[^>\n]*>|<redacted:[^>\n]*>/g;

/** The longest text one marker may stand for: a value or a name, never a sentence. */
const MAX_REDACTED_CHARS = 120;

/** The longest line compared marker by marker, and the most markers on it; past either, no guess. */
const MAX_LINE_CHARS = 4_096;
const MAX_LINE_MARKERS = 16;

/**
 * The most places one call compares, over every line of the page (W17-R15): past it the two
 * texts are judged changed. The walk is bounded a line by its length, but a page of fifty lines
 * each built to line up only at the end of its walk (sixteen markers a letter apart against
 * fifteen hundred of that letter) cost about a second inside the page store's mutation, which
 * then failed at every sync. An ordinary page compares a few hundred places a marker, so this
 * judges a page of hundreds of redacted lines and costs a hostile page a stamp, not a sync.
 */
export const REDACTION_WALK_STEPS = 200_000;

/** The places a call may still compare, spent by every line it walks. */
interface WalkBudget {
  steps: number;
}

/**
 * Whether `other` is `marked` with each of its markers standing for a short run of text: the
 * same line before and after every marker, and between one and `MAX_REDACTED_CHARS` characters
 * where each marker is.
 *
 * Read by walking the places each stretch between two markers can end, never by a pattern: a
 * pattern of bounded wildcards tries every way to place them on a line that does not match, and
 * a page's author can write such a line (the second pass: sixteen markers a letter apart against
 * fifteen hundred of that letter never returned). The walk is bounded by the line's length times
 * the longest run a marker stands for, for each marker, and spends the call's budget: once that
 * is spent the line does not match.
 */
function matchesButForMarkers(marked: string, other: string, budget: WalkBudget): boolean {
  const literals = marked.split(MARKER);
  const markers = literals.length - 1;
  if (markers === 0 || markers > MAX_LINE_MARKERS) return false;
  if (marked.length > MAX_LINE_CHARS || other.length > MAX_LINE_CHARS) return false;
  if (!other.startsWith(literals[0])) return false;
  // Where in `other` the text matched so far may end, before the next marker's run begins.
  let ends = new Set([literals[0].length]);
  for (let index = 1; index <= markers; index += 1) {
    const literal = literals[index];
    const last = index === markers;
    const next = new Set<number>();
    for (const end of ends) {
      for (let run = 1; run <= MAX_REDACTED_CHARS; run += 1) {
        if (budget.steps <= 0) return false;
        budget.steps -= 1;
        const at = end + run;
        if (at + literal.length > other.length) break;
        // The last stretch must close the line; the others may sit anywhere the run allows.
        if (
          last
            ? at + literal.length === other.length && other.endsWith(literal)
            : other.startsWith(literal, at)
        ) {
          next.add(at + literal.length);
        }
      }
    }
    if (next.size === 0) return false;
    ends = next;
  }
  return true;
}

/**
 * Whether two stored texts of a page are the same text but for what the redaction took out: line
 * for line equal, or differing only where one of the two holds a redaction marker and the other a
 * short run of text (or a marker of its own). Strict where it cannot tell: a line added or
 * removed, a marker where the other text holds nothing, a line too long or too full of markers
 * to compare, a line each of the two redacts in a place the other does not, and a page whose
 * comparison passes `REDACTION_WALK_STEPS` all read as a change, since a change that goes unsaid
 * leaves a skill running on a runbook it never read.
 *
 * @param stored - The page's text as it was stored.
 * @param incoming - Its text as the sync is about to store it.
 */
export function sameButForRedaction(stored: string, incoming: string): boolean {
  if (stored === incoming) return true;
  const before = stored.split('\n');
  const after = incoming.split('\n');
  if (before.length !== after.length) return false;
  const budget: WalkBudget = { steps: REDACTION_WALK_STEPS };
  return before.every(
    (line, index) =>
      line === after[index] ||
      matchesButForMarkers(line, after[index], budget) ||
      matchesButForMarkers(after[index], line, budget),
  );
}
