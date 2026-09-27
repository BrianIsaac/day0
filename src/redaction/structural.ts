/**
 * The structural grammar: formats that carry a secret by construction.
 *
 * These are not heuristics about what a secret looks like; they are the
 * syntax of six formats in which the secret's position is fixed. A URL's
 * userinfo password, the body of a PEM private-key block, the three segments
 * of a JSON web token, the value after an `Authorization` scheme word, a
 * provider token with a fixed prefix and alphabet, and the value a line
 * assigns to a password-class label (`pwd: …`, `Passcode = …`, `Dashboard
 * login (Looker tile): \`…\``, the second half of `login: user / pass`) are
 * secrets wherever they occur, whatever a model thinks. The last one is a
 * grammar and not a guess only because the label is the line's own word for
 * it; a value that names a reference, a placeholder, a plain word or an
 * unquoted phrase is left to the model. One personal-data format sits beside them: a
 * national identifier whose check letter verifies (the Singapore NRIC and
 * FIN), which no context keeps. The grammar is synchronous and
 * dependency-free, which is why it is also the floor applied where no model
 * can be called: a Convex query rendering an export, and the prompt text
 * assembled from material that was redacted when stored. What is gone is
 * every rule that judged a value by how random it looked.
 */

import { PLAIN_WORD, QUOTE_PAIRS, guardReason, sampleValueReason } from './guard';

export type StructuralLabel =
  | 'connection password'
  | 'password'
  | 'national id'
  | 'private key'
  | 'json web token'
  | 'header value'
  | (typeof PROVIDER_SHAPES)[number]['label'];

export interface StructuralSpan {
  start: number;
  end: number;
  label: StructuralLabel;
  /** What the format carries: a secret, or an identifier the policy removes everywhere. */
  kind: 'secret' | 'id-number';
}

/**
 * Provider tokens with a fixed prefix and a fixed alphabet. A grammar, not a
 * guess: `xoxb-` followed by eight or more token characters is a Slack bot
 * token and nothing else. Most specific first where two share a prefix. The
 * prefixes are case-sensitive and must not follow an identifier character,
 * so `NOTION_SECRET_TOKEN_POLICY` is a variable name and `ntn_prefix` in
 * prose is not a token. `.` is excluded from every tail because no provider
 * uses it and it ends sentences.
 */
export const PROVIDER_SHAPES = [
  { pattern: /lin_api_[A-Za-z0-9_-]{8,}/, label: 'linear service token' },
  { pattern: /xoxe\.xox[abps]-[A-Za-z0-9_-]{8,}/, label: 'slack configuration token' },
  { pattern: /xoxb-[A-Za-z0-9_-]{8,}/, label: 'slack bot token' },
  { pattern: /xoxp-[A-Za-z0-9_-]{8,}/, label: 'slack user token' },
  { pattern: /xoxa-[A-Za-z0-9_-]{8,}/, label: 'slack app token' },
  { pattern: /xox[es]-[A-Za-z0-9_-]{8,}/, label: 'slack token' },
  { pattern: /ntn_[A-Za-z0-9_-]{8,}/, label: 'notion connection token' },
  { pattern: /secret_[A-Za-z0-9_-]{16,}/, label: 'secret' },
  { pattern: /AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/, label: 'aws access key' },
  { pattern: /ghp_[A-Za-z0-9]{36}(?![A-Za-z0-9])/, label: 'github personal access token' },
  { pattern: /github_pat_[A-Za-z0-9_]{40,}/, label: 'github personal access token' },
  { pattern: /sk_live_[A-Za-z0-9]{16,}/, label: 'stripe api key' },
  { pattern: /whsec_[A-Za-z0-9]{16,}/, label: 'webhook signing secret' },
  { pattern: /AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/, label: 'google api key' },
  { pattern: /sk-ant-[A-Za-z0-9_-]{20,}/, label: 'anthropic api key' },
  { pattern: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/, label: 'openai api key' },
] as const;
const PROVIDER_PREFIX = new RegExp(
  `(?<![A-Za-z0-9_-])(?:${PROVIDER_SHAPES.map((shape): string => `(${shape.pattern.source})`).join('|')})`,
  'g',
);
/** The labels the provider grammar emits, which name the system and the kind at once. */
export const PROVIDER_LABELS: ReadonlySet<string> = new Set(
  PROVIDER_SHAPES.map((shape): string => shape.label),
);

/**
 * The password segment of a connection string. The scheme, user and host
 * stay in the clear: they are the address the runbook needs, and only the
 * password is the credential.
 */
export const CONNECTION_PASSWORD =
  /(?<![A-Za-z0-9])([a-z][a-z0-9+.-]*):\/\/[^\s/:@`'"<>]*:([^\s/@`'"<>]+)@/gi;
const PEM_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*([\s\S]*?)\s*-----END [A-Z ]*PRIVATE KEY-----/g;
const JSON_WEB_TOKEN =
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g;
/**
 * Every bare value below stops at CJK text and full-width punctuation, which no
 * token or password written without quotes carries, so the Chinese sentence
 * after a value (`Bearer abc123，然后调用`, `密码：abc123然后登录`) is never
 * stored as part of it.
 *
 * The value after an `Authorization` scheme word. Eight characters keeps
 * "Bearer header." in prose out; a placeholder (`Bearer <token>`,
 * `Bearer {{secret}}`, `Bearer YOUR_TOKEN`) is left as the safe form it is.
 */
const AUTHORIZATION_VALUE =
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+([^\s,;"'`<>\\　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿！-｠]+)/gi;
const HEADER_VALUE = /\b(?:Bearer|Basic)\s+([^\s,;"'`<>\\　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿！-｠]{8,})/g;
/** A named credential header: `X-Api-Key: value`, `Api-Key: value`, `X-Auth-Token: value`. */
const CREDENTIAL_HEADER =
  /\b(?:X-Api-Key|Api-Key|X-Auth-Token|X-Access-Token)\s*:\s*([^\s,;"'`<>\\　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿！-｠]{8,})/gi;
/** curl's `-u user:password` and `--user user:password`. */
const CURL_USER = /(?:^|\s)(?:-u|--user)\s+[^\s:@"']+:([^\s"'　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿！-｠]+)/g;
/** What a bare labelled value is made of: no whitespace, quote mark, closing punctuation or CJK text. */
const BARE_VALUE_CHARACTER = '[^\\s`\'",;)　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿！-｠]';
/**
 * A line that assigns a value to a password-class label. The label must sit
 * directly before the separator (an optional parenthetical allowed), so
 * "password policy: rotate quarterly" is prose and "PIN for the phone: 0419"
 * is the model's to find. A value between any pair of `QUOTE_PAIRS` is taken
 * whole, one capture group per pair in the table's order; a bare value (the
 * group after them) stops at whitespace and closing punctuation, ASCII or
 * full-width, never gives back a character to let the rest of the pattern
 * match (so `login: Admin / pass` cannot store `Admi`), and is not taken when
 * it starts a `user / password` pair, which `LOGIN_PAIR` reads instead.
 */
const LABELLED_PASSWORD = new RegExp(
  '(?<![A-Za-z0-9_])(?:dashboard login|login|password|passwd|pwd|passcode|passphrase|pin|密码|口令)' +
    '(?:[ \\t]*\\([^)\\n]{0,60}\\))?[ \\t]*[:=：][ \\t]*' +
    `(?:${QUOTE_PAIRS.map(([open, close]): string => `${open}([^${close}\\n]+)${close}`).join('|')}` +
    `|(${BARE_VALUE_CHARACTER}+)(?!${BARE_VALUE_CHARACTER})(?![ \\t]*\\/[ \\t]*[^\\s/]))`,
  'gi',
);
/** `login: user / password`, `credentials: user/password`: the second half is the secret. */
const LOGIN_PAIR =
  /(?<![A-Za-z0-9_])(?:login|credentials?|user(?:name)?[ \t]*\/[ \t]*pass(?:word)?)[ \t]*[:=：][ \t]*([^\s/`'"]+)[ \t]*\/[ \t]*([^\s`'",;)　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿！-｠]+)/gi;
/**
 * Whether an unquoted value after a password-class label is the author's
 * prose rather than a password: "Login: Google Workspace SSO", "Password:
 * Summer". Only a plain word is: a letters-only value with capitals inside
 * (`Password: HqZwTrPx for the ops account`) is a password with words after
 * it. A CJK phrase ("密码：请联系IT管理员") never reaches here, because a bare
 * value stops at the first CJK character. A quoted value is the author's own
 * marking of the secret and is never refused here.
 *
 * @param value - The bare value, trailing punctuation shed.
 */
function bareValueIsProse(value: string): boolean {
  return PLAIN_WORD.test(value);
}
/** A Singapore NRIC or FIN: a series letter, seven digits and a check letter. */
const NATIONAL_ID = /(?<![A-Za-z0-9])([STFGM])(\d{7})([A-Z])(?![A-Za-z0-9])/g;
const NATIONAL_ID_WEIGHTS = [2, 7, 6, 5, 4, 3, 2];
const NATIONAL_ID_CHECK: Readonly<Record<string, { offset: number; letters: string }>> = {
  S: { offset: 0, letters: 'JZIHGFEDCBA' },
  T: { offset: 4, letters: 'JZIHGFEDCBA' },
  F: { offset: 0, letters: 'XWUTRQPNMLK' },
  G: { offset: 4, letters: 'XWUTRQPNMLK' },
  M: { offset: 3, letters: 'KLJNPQRTUWX' },
};

/**
 * Whether a series letter, seven digits and a check letter are a valid
 * national identifier, by the published checksum.
 *
 * Args:
 *   series: The leading letter.
 *   digits: The seven digits.
 *   check: The trailing letter.
 *
 * Returns:
 *   True when the check letter is the one the digits produce.
 */
export function nationalIdVerifies(series: string, digits: string, check: string): boolean {
  const rule = NATIONAL_ID_CHECK[series];
  if (!rule) return false;
  const sum = [...digits].reduce(
    (total: number, digit: string, index: number): number =>
      total + Number(digit) * NATIONAL_ID_WEIGHTS[index]!,
    rule.offset,
  );
  return rule.letters[sum % 11] === check;
}
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;
/** What a labelled password sheds at its end; `!` and `?` stay, a password may end in one. */
const PASSWORD_TRAILING = /[.,;:)\]}'"]+$/;
/** A value that refers to a secret rather than carrying one: `<password>`, `${VAR}`, `{{ secret }}`. */
export const REFERENCE_START = /^[<${]/;
export const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** An upper-case name with no digits is a placeholder or a variable name, never a value. */
const UPPER_NAME = /^[A-Z][A-Z_]{2,}$/;

/**
 * Locate every structural secret in a text.
 *
 * Args:
 *   text: Any text.
 *
 * Returns:
 *   Non-overlapping spans in document order.
 */
export function structuralSpans(text: string): StructuralSpan[] {
  const spans: StructuralSpan[] = [];
  for (const match of text.matchAll(CONNECTION_PASSWORD)) {
    if (match.index === undefined || REFERENCE_START.test(match[2])) continue;
    const start = match.index + match[0].lastIndexOf(`${match[2]}@`);
    spans.push({
      start,
      end: start + match[2].length,
      label: 'connection password',
      kind: 'secret',
    });
  }
  for (const match of text.matchAll(PEM_BLOCK)) {
    if (match.index === undefined || !match[1]) continue;
    const start = match.index + match[0].indexOf(match[1]);
    spans.push({ start, end: start + match[1].length, label: 'private key', kind: 'secret' });
  }
  for (const match of text.matchAll(JSON_WEB_TOKEN)) {
    if (match.index === undefined) continue;
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      label: 'json web token',
      kind: 'secret',
    });
  }
  for (const match of text.matchAll(PROVIDER_PREFIX)) {
    if (match.index === undefined || sampleValueReason(match[0])) continue;
    const group = match.slice(1).findIndex((value): boolean => value !== undefined);
    const label = PROVIDER_SHAPES[Math.max(group, 0)].label;
    spans.push({ start: match.index, end: match.index + match[0].length, label, kind: 'secret' });
  }
  for (const pattern of [AUTHORIZATION_VALUE, HEADER_VALUE, CREDENTIAL_HEADER, CURL_USER]) {
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const value = match[1].replace(TRAILING_PUNCTUATION, '');
      if (
        REFERENCE_START.test(value) ||
        UPPER_NAME.test(value) ||
        value.startsWith('<credential:') ||
        sampleValueReason(value)
      )
        continue;
      const start = match.index + match[0].lastIndexOf(match[1]);
      spans.push({ start, end: start + value.length, label: 'header value', kind: 'secret' });
    }
  }
  for (const match of text.matchAll(LOGIN_PAIR)) {
    if (match.index === undefined) continue;
    const value = match[2].replace(PASSWORD_TRAILING, '');
    // The second half of `user / pass` is a password by its position, so no word test applies.
    if (!value || guardReason(value, { assigned: true })) continue;
    const start = match.index + match[0].lastIndexOf(match[2]);
    spans.push({ start, end: start + value.length, label: 'password', kind: 'secret' });
  }
  for (const match of text.matchAll(LABELLED_PASSWORD)) {
    if (match.index === undefined) continue;
    const quoted = match
      .slice(1, QUOTE_PAIRS.length + 1)
      .find((group: string | undefined): boolean => group !== undefined);
    const raw = quoted ?? match[QUOTE_PAIRS.length + 1] ?? '';
    const value = quoted === undefined ? raw.replace(PASSWORD_TRAILING, '') : raw;
    if (
      !value ||
      guardReason(value, { assigned: true, quoted: quoted !== undefined }) ||
      (quoted === undefined && bareValueIsProse(value))
    )
      continue;
    const start = match.index + match[0].lastIndexOf(raw);
    spans.push({ start, end: start + value.length, label: 'password', kind: 'secret' });
  }
  for (const match of text.matchAll(NATIONAL_ID)) {
    if (match.index === undefined || !nationalIdVerifies(match[1], match[2], match[3])) continue;
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      label: 'national id',
      kind: 'id-number',
    });
  }
  return mergeSpans(spans);
}

/** Merge overlapping coverage so a later span cannot expose a trailing suffix. */
export function mergeSpans<T extends { start: number; end: number }>(spans: T[]): T[] {
  const sorted = [...spans].sort(
    (left, right): number => left.start - right.start || right.end - left.end,
  );
  const kept: T[] = [];
  for (const span of sorted) {
    const last = kept[kept.length - 1];
    if (last && span.start < last.end) {
      kept[kept.length - 1] = { ...last, end: Math.max(last.end, span.end) };
      continue;
    }
    kept.push(span);
  }
  return kept;
}

/**
 * Replace spans with a marker, working from the end so offsets hold.
 *
 * Args:
 *   text: The text the spans index into.
 *   spans: Non-overlapping spans.
 *   marker: What each span becomes, given its span.
 *
 * Returns:
 *   The text with every span replaced.
 */
export function replaceSpans<T extends { start: number; end: number }>(
  text: string,
  spans: T[],
  marker: (span: T) => string,
): string {
  let out = text;
  for (const span of [...spans].sort((left, right): number => right.start - left.start)) {
    out = `${out.slice(0, span.start)}${marker(span)}${out.slice(span.end)}`;
  }
  return out;
}
