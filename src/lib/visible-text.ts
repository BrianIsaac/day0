/**
 * Text one person types for another to read (an employee's name, a handover note, a decline
 * reason), held to what a reader can see and measured the way a reader counts it.
 *
 * Nothing here escapes markup: every screen draws these strings as plain text.
 */

/** Line feed and tab: the two control characters a note may keep. */
const KEPT_CONTROLS: ReadonlySet<number> = new Set([0x09, 0x0a]);

/**
 * Bidirectional controls, which reorder what follows them on screen (an address that reads one
 * way and is stored another), and characters with no width, which make two strings look equal.
 */
const INVISIBLE_FORMAT_CHARACTERS: ReadonlySet<number> = new Set([
  0x061c, // Arabic letter mark
  0x180e, // Mongolian vowel separator
  0x200b, // zero width space
  0x200c, // zero width non-joiner
  0x200d, // zero width joiner
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e, // embeddings, overrides and their pop
  0x2060, // word joiner
  0x2061,
  0x2062,
  0x2063,
  0x2064, // invisible operators
  0x2066,
  0x2067,
  0x2068,
  0x2069, // isolates and their pop
  0xfeff, // zero width no-break space
]);

function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/**
 * The text with every control character but a line feed and a tab, every bidirectional control
 * and every zero-width character removed. A carriage return goes too, so a pasted CRLF reads as
 * one line break.
 */
export function withoutInvisibles(text: string): string {
  let kept = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (INVISIBLE_FORMAT_CHARACTERS.has(codePoint)) continue;
    if (isControl(codePoint) && !KEPT_CONTROLS.has(codePoint)) continue;
    kept += character;
  }
  return kept;
}

/**
 * How many characters a reader counts in the text: code points, so an emoji or a character
 * outside the basic plane is one, where `String.length` counts two.
 */
export function characterCount(text: string): number {
  return Array.from(text).length;
}

/**
 * The text's first `limit` characters, counted as {@link characterCount} counts them, so a clip
 * never splits a surrogate pair.
 */
export function clipCharacters(text: string, limit: number): string {
  return Array.from(text).slice(0, limit).join('');
}
