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

/** A literal as a pattern matches it. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `other` is `marked` with each of its markers standing for a short run of text: the
 * same line before and after every marker, and between one and `MAX_REDACTED_CHARS` characters
 * where each marker is.
 */
function matchesButForMarkers(marked: string, other: string): boolean {
  const literals = marked.split(MARKER);
  if (literals.length === 1 || literals.length - 1 > MAX_LINE_MARKERS) return false;
  if (marked.length > MAX_LINE_CHARS || other.length > MAX_LINE_CHARS) return false;
  const value = `[\\s\\S]{1,${MAX_REDACTED_CHARS}}?`;
  return new RegExp(`^${literals.map(escaped).join(value)}$`).test(other);
}

/**
 * Whether two stored texts of a page are the same text but for what the redaction took out: line
 * for line equal, or differing only where one of the two holds a redaction marker and the other a
 * short run of text (or a marker of its own). Strict where it cannot tell: a line added or
 * removed, a marker where the other text holds nothing, a line too long or too full of markers
 * to compare, and a line each of the two redacts in a place the other does not all read as a
 * change, since a change that goes unsaid leaves a skill running on a runbook it never read.
 *
 * @param stored - The page's text as it was stored.
 * @param incoming - Its text as the sync is about to store it.
 */
export function sameButForRedaction(stored: string, incoming: string): boolean {
  if (stored === incoming) return true;
  const before = stored.split('\n');
  const after = incoming.split('\n');
  if (before.length !== after.length) return false;
  return before.every(
    (line, index) =>
      line === after[index] ||
      matchesButForMarkers(line, after[index]) ||
      matchesButForMarkers(after[index], line),
  );
}
