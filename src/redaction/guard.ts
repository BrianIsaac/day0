/**
 * The guard between a model's opinion and the stored text.
 *
 * A span model asked for "access token" will offer `REVOPS-7`, and asked for
 * "secret key" will offer `{{secret}}`. Both are working material: the first
 * is the ticket the work is about and the second is the placeholder that
 * keeps the real value out of every prompt. The guard is the list of shapes a
 * secret never has. It removes candidates and never adds one, so recall stays
 * the model's and precision becomes the guard's. Measured on the corpus it
 * takes the same model from precision 61 to 93 at no cost in recall.
 */

export interface Span {
  start: number;
  end: number;
}

export interface NeverASecret {
  name: string;
  pattern: RegExp;
}

/** Shapes a secret value never has, tried against the trimmed span text. */
export const NEVER_A_SECRET: readonly NeverASecret[] = [
  { name: 'reference', pattern: /^(?:<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\})$/ },
  { name: 'marker or placeholder inside', pattern: /<credential:|\{\{|\$\{/ },
  { name: 'upper-case name', pattern: /^[A-Z][A-Z_]{2,}$/ },
  { name: 'issue key', pattern: /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/ },
  { name: 'url', pattern: /^[a-z][a-z0-9+.-]*:\/\//i },
  { name: 'masked', pattern: /^(.)\1{3,}$/ },
  {
    name: 'label word',
    pattern: /^(?:password|passwd|pwd|passcode|pin|token|secret|key|api key|credential|credentials|login|bearer|basic|authorization)$/i,
  },
  { name: 'uuid', pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
  { name: 'hex id', pattern: /^(?:[0-9a-f]{32}|[0-9a-f]{40})$/i },
  { name: 'slack id', pattern: /^[CDUTBW][0-9A-Z]{8,12}$/ },
  { name: 'date', pattern: /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/ },
  { name: 'figure', pattern: /^[~$€£]?\d{1,3}(?:,\d{3})*(?:\.\d+)?[%kKmM]?$/ },
  { name: 'prose', pattern: /^[A-Za-z]+(?: [A-Za-z]+)+$/ },
  { name: 'too short', pattern: /^.{0,3}$/ },
];

/**
 * A span that swallowed its own label: "password: hunter2", "the token is
 * abc123". The value is the last word; everything before it names the kind.
 */
const LABEL_THEN_VALUE =
  /^(?:[^\s:=]+\s+){0,3}(?:password|passwd|pwd|passcode|pin|token|key|secret|login|credential|密码|口令|令牌|密钥|秘钥|凭证)s?\s*(?:\bis\b|=|:|：|是|为)?\s*[`'"]?([^\s`'"，。]+)[`'"，。]?$/i;
const LEADING_PUNCTUATION = /^[(\[{'"`]+/;
/** Sentence punctuation a model swallows; `!` and `?` stay, a password may end in one. */
const TRAILING_PUNCTUATION = /[.,;:)\]}'"`]+$/;

/**
 * Narrow a model's secret span to the value it means, or reject it.
 *
 * Whitespace and enclosing punctuation are trimmed; a span that includes its
 * label narrows to the value; a span that still holds whitespace is prose
 * unless it is a private key; then the shapes above are tried.
 *
 * Args:
 *   text: The text the span indexes into.
 *   span: The model's span.
 *   label: The model's label, so a private key may keep its whitespace.
 *
 * Returns:
 *   The narrowed span, or undefined when the guard rejects it.
 */
export function guardSecretSpan(text: string, span: Span, label: string): Span | undefined {
  let { start, end } = span;
  let value = text.slice(start, end);
  start += value.length - value.trimStart().length;
  end -= value.length - value.trimEnd().length;
  value = text.slice(start, end);
  const leading = LEADING_PUNCTUATION.exec(value);
  if (leading) start += leading[0].length;
  value = text.slice(start, end);
  const trailing = TRAILING_PUNCTUATION.exec(value);
  if (trailing) end -= trailing[0].length;
  value = text.slice(start, end);
  const narrowed = label === 'private key' ? null : LABEL_THEN_VALUE.exec(value);
  if (narrowed && narrowed[1] !== value) {
    start += value.lastIndexOf(narrowed[1]);
    end = start + narrowed[1].length;
    value = text.slice(start, end);
  } else if (/\s/.test(value) && label !== 'private key') {
    return undefined;
  }
  if (end <= start) return undefined;
  const rejected = NEVER_A_SECRET.find((shape: NeverASecret): boolean => shape.pattern.test(value));
  return rejected ? undefined : { start, end };
}

/** Shapes an identifier has and personal data does not: the working ids of a ticket queue. */
const WORKING_IDENTIFIER = new Set(['reference', 'marker or placeholder inside', 'issue key', 'url', 'uuid', 'hex id', 'slack id', 'date', 'figure', 'too short']);
const DIGITS = /\d/g;

/**
 * Reject a personal-data span whose shape says it is something else.
 *
 * A model asked for "id number" offers UUIDs, commit hashes, Slack ids and
 * ticket keys; asked for "address" it offers hostnames. Each kind has a
 * shape a real value of that kind always has, and the working identifiers
 * of a ticket queue never do.
 *
 * Args:
 *   kind: The policy kind the model's label maps to.
 *   value: The trimmed span text.
 *
 * Returns:
 *   The rule that rejects it, or undefined when it may be that kind.
 */
export function personalDataGuardReason(kind: string, value: string): string | undefined {
  const identifier = NEVER_A_SECRET.find(
    (shape: NeverASecret): boolean => WORKING_IDENTIFIER.has(shape.name) && shape.pattern.test(value),
  );
  if (identifier) return identifier.name;
  const digits = (value.match(DIGITS) ?? []).length;
  if (kind === 'id-number' && digits < 6) return 'id number without six digits';
  if (kind === 'phone' && digits < 7) return 'phone number without seven digits';
  if (kind === 'address' && !/\s/.test(value)) return 'address without a space';
  if (kind === 'email' && !value.includes('@')) return 'email without an at sign';
  return undefined;
}

/**
 * Name the guard rule that rejects a value, for a test or a reader.
 *
 * Args:
 *   value: A candidate value.
 *
 * Returns:
 *   The rule name, or undefined when the value passes.
 */
export function guardReason(value: string): string | undefined {
  return NEVER_A_SECRET.find((shape: NeverASecret): boolean => shape.pattern.test(value))?.name;
}
