import type { TranscriptTurn } from '../agent/transcript-turns';
import { personNameKey } from './vocabulary';

/*
 * The words a proposed person rests on (wave 13, 13-P; A1: quote-grounded): the manager's own
 * sentence from the one-to-one that names them, and a documentation page's quote checked against
 * the page before it is kept. Pure.
 */

/** The longest quote kept as evidence, in characters. */
export const QUOTE_LIMIT = 280;

/** The marker on a quote cut to {@link QUOTE_LIMIT}. */
const CUT = '...';

/**
 * Whether a text names a person: the name's words, in order, as whole words, case and accents
 * aside. A name with no letter or digit is named nowhere.
 *
 * @param text - The text.
 * @param name - The person's name.
 */
export function mentions(text: string, name: string): boolean {
  const key = personNameKey(name);
  if (key === '') return false;
  return ` ${personNameKey(text)} `.includes(` ${key} `);
}

/** A quote cut to the limit between words, marked as cut. */
function clipped(sentence: string): string {
  if (sentence.length <= QUOTE_LIMIT) return sentence;
  const room = sentence.slice(0, QUOTE_LIMIT - CUT.length);
  const lastSpace = room.lastIndexOf(' ');
  return `${(lastSpace > 0 ? room.slice(0, lastSpace) : room).trimEnd()}${CUT}`;
}

/**
 * The manager's sentence in the one-to-one that names a person, as evidence for proposing them:
 * the first manager turn naming them, cut to that sentence. The employee's own words are never
 * evidence: they are questions.
 *
 * @param name - The person's name, as the charter has it.
 * @param turns - The one-to-one's turns, kept or read back from its transcript.
 * @returns The quote, or undefined when no manager turn names them.
 */
export function managerQuoteFor(
  name: string,
  turns: readonly TranscriptTurn[],
): string | undefined {
  for (const turn of turns) {
    if (turn.speaker !== 'manager' || !mentions(turn.text, name)) continue;
    const sentences = turn.text
      .split(/(?<=[.!?])\s+|\n+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence !== '');
    const sentence = sentences.find((candidate) => mentions(candidate, name)) ?? turn.text.trim();
    return clipped(sentence);
  }
  return undefined;
}

/** A text with every run of whitespace one space, trimmed, in lower case: how quotes compare. */
function comparable(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A model's quote kept as evidence only when the page says it (whitespace and case aside) and it
 * names the person it is evidence for: a model that paraphrases or invents grounds nobody.
 *
 * @param quote - The quote the model gave.
 * @param page - The page's text.
 * @param name - The person the quote is for.
 * @returns The quote with its whitespace made single and cut to the limit, or undefined.
 */
export function groundedQuote(quote: string, page: string, name: string): string | undefined {
  const wanted = comparable(quote);
  if (wanted === '' || !comparable(page).includes(wanted)) return undefined;
  if (!mentions(quote, name)) return undefined;
  return clipped(quote.replace(/\s+/g, ' ').trim());
}
