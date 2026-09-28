/**
 * The personal data a grammar can find without the model: an e-mail
 * address, a phone number written with its country code or after a phone
 * label, a date after a birth label, and an address after an address label.
 *
 * Each form is unmistakable or labelled, never a guess: a bare number or a
 * bare date is left alone, because tickets and ledgers are full of both
 * (amounts, timestamps, ids, due dates). What a context does with each kind
 * is the policy's (`ENTITY_POLICY`); this module only finds them. The model
 * finds the rest where a context runs it.
 */
import type { EntityKind } from './policy';

/** The kinds this grammar finds. */
export type PersonalKind = Extract<EntityKind, 'email' | 'phone' | 'date-of-birth' | 'address'>;

/** One span of personal data in a text. */
export interface PersonalSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: PersonalKind;
}

/** An e-mail address, not glued to a longer token on either side. */
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g;

/** A number written with its country code: `+65 9123 4567`, `+1 (415) 555-0100`. */
const INTERNATIONAL_PHONE = /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,6}(?![\w])/g;

/** A number after a phone label, in either language: `Tel: 6123 4567`, `手机：13800138000`. */
const LABELLED_PHONE =
  /(?:\b(?:phone|tel|telephone|mobile|cell|whatsapp)\b(?:\s*(?:no\.?|number))?|电话|手机|联系电话)\s*[:：]?\s*(\+?\(?\d[\d ().-]{5,}\d)/gi;

/** The shortest and longest digit counts a phone number carries (E.164 caps it at 15). */
const PHONE_DIGITS = { min: 7, max: 15 } as const;

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/** A calendar date in the shapes people write one. */
const DATE = `(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{1,2}\\s+${MONTH}\\.?\\s+\\d{4}|${MONTH}\\.?\\s+\\d{1,2},?\\s+\\d{4}|\\d{4}年\\d{1,2}月\\d{1,2}日)`;

/** A date after a birth label: `Date of birth: 12 March 1990`, `出生日期：1990年3月12日`. */
const LABELLED_BIRTH_DATE = new RegExp(
  `(?:\\b(?:date of birth|d\\.?o\\.?b\\.?|born(?: on)?|birthday)\\b|出生日期|生日)\\s*[:：]?\\s*(${DATE})`,
  'gi',
);

/**
 * The rest of the line after an address label: a qualified one anywhere
 * (`home address: ...`), a bare `Address:` only where it opens a line or a
 * list item, so an e-mail, IP or endpoint address is never taken for one.
 */
const LABELLED_ADDRESS =
  /(?:\b(?:home|postal|mailing|residential|street|billing|delivery|shipping) address|(?:^|\n)[ \t]*(?:[-*][ \t]+)?address|地址|住址)[ \t]*[:：][ \t]*([^\n]*[^\s])/gim;

/** The span of a regex's first group within its match. */
function groupSpan(match: RegExpMatchArray): { start: number; end: number } {
  const group = match[1]!;
  const start = match.index! + match[0].lastIndexOf(group);
  return { start, end: start + group.length };
}

/** Whether a candidate phone carries as many digits as a phone number does. */
function phoneLength(value: string): boolean {
  const digits = value.replace(/\D/g, '').length;
  return digits >= PHONE_DIGITS.min && digits <= PHONE_DIGITS.max;
}

/**
 * Every span of personal data the grammar finds, in text order, unmerged.
 *
 * @param text - Untrusted text.
 */
export function personalDataSpans(text: string): PersonalSpan[] {
  const spans: PersonalSpan[] = [];
  for (const match of text.matchAll(EMAIL)) {
    spans.push({ start: match.index, end: match.index + match[0].length, kind: 'email' });
  }
  for (const match of text.matchAll(INTERNATIONAL_PHONE)) {
    if (phoneLength(match[0])) {
      spans.push({ start: match.index, end: match.index + match[0].length, kind: 'phone' });
    }
  }
  for (const match of text.matchAll(LABELLED_PHONE)) {
    if (phoneLength(match[1]!)) spans.push({ ...groupSpan(match), kind: 'phone' });
  }
  for (const match of text.matchAll(LABELLED_BIRTH_DATE)) {
    spans.push({ ...groupSpan(match), kind: 'date-of-birth' });
  }
  for (const match of text.matchAll(LABELLED_ADDRESS)) {
    spans.push({ ...groupSpan(match), kind: 'address' });
  }
  return spans.sort((left, right) => left.start - right.start);
}
