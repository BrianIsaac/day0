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

import { NEVER_REDACT } from './policy';

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
    pattern: /^(?:password|passwd|pwd|passcode|passphrase|pin|token|secret|key|api key|credential|credentials|login|username|user|account|bearer|basic|authorization)$/i,
  },
  /** A provider prefix with nothing after it but a mode word: a placeholder, not a key. */
  { name: 'placeholder', pattern: /^[a-z]{1,4}[-_](?:test|live|example|sample|dummy|placeholder|changeme)$/i },
  /** Dot-separated lowercase labels ending in an alphabetic top label: an address, not a value. */
  { name: 'hostname', pattern: /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/ },
  /** A ticket key then a slug: the branch a ticket tracker names for its issue. */
  { name: 'branch name', pattern: /^[a-z]+-\d+(?:-[a-z0-9]+)+$/ },
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
const PASSWORD_LABEL = /(?:^|\s)(?:password|passwd|pwd|passcode|pin|密码|口令)$/i;
const RUNBOOK_WORD = /^(?:[a-z]{4,}|[A-Z][a-z]{3,}|[a-z]+(?:_[a-z]+)+)$/;
/**
 * A word that names a credential, on its own or as the tail of a longer name
 * (`LOOKER_PASSWORD`, `X-Auth-Token`, `secret key`, `GH_PAT`).
 */
const SECRET_LABEL =
  '(?:password|passwd|pwd|passcode|passphrase|pin|token|key|secret|login|credentials?|auth|pat|密码|口令|令牌|密钥|秘钥|凭证)';
/** A quote around a label or value, literal or JSON-escaped. */
const QUOTE = '(?:\\\\?[`\'"])?';
/**
 * A credential label with its separator directly before the value: the
 * assignment forms a runbook writes, including a table cell after a labelled
 * cell. Prose that only mentions a label ("no token value is on this page")
 * has no separator and is not one.
 */
const SECRET_ASSIGNMENT = new RegExp(`${SECRET_LABEL}${QUOTE}\\s*(?:[:=：|]|\\bis\\b|是|为)\\s*${QUOTE}$`, 'i');
const SECRET_LABEL_WORD = new RegExp(`(?:^|[^A-Za-z])${SECRET_LABEL}(?:$|[^A-Za-z])`, 'i');
const PASSWORD_ASSIGNMENT = /(?:password|passwd|pwd|passcode|pin|密码|口令)\s*(?:[:=：]|\bis\b|是|为)\s*[`'"]?$/i;
const ASSIGNED_VALUE = /^(?:[:=：]\s*|[ \t]+(?:is|是|为)[ \t]*)([^\s`'"，。<>\\]+(?:\r?\n[0-9]+)?)/i;
/**
 * A label with a short phrase before its separator ("PIN for the shared
 * phone: 0419"); only a value with a digit is taken this way, so "password
 * policy: rotate quarterly" stays prose.
 */
const PHRASED_ASSIGNED_VALUE = /^(?:[ \t]+[^\s:=：]+){1,4}[ \t]*[:=：][ \t]*([^\s`'"，。<>\\]*\d[^\s`'"，。<>\\]*)/i;
/** `user / password` in one span: the model read the pair as one name. */
const USER_PASSWORD_PAIR = /^([^\s/`'"]+)[ \t]*\/[ \t]*([^\s/`'"]+)$/;
/**
 * What introduces a username rather than a secret: "login is revops",
 * "username: revops", "user = revops". A `login:` assignment is not here; the
 * grammar reads it as the credential unless it is a user / password pair.
 */
const USERNAME_DESIGNATOR = /(?:\blogin[ \t]+is|(?:\buser ?name|\buser|\baccount)[ \t]*(?:\bis\b|[:=：]))[ \t]*[`'"]?$/i;
/** JSON keys whose string values are identifiers by construction. */
const IDENTIFIER_KEY = /"(?:id|identifier|branchName|branch|slug|url|name|title|ts|channel|team|state|status|key)"[ \t]*:[ \t]*"$/;
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
  // Some detectors return the assignment label rather than its value.
  // Only extend a password label across explicit assignment syntax.
  if (label === 'password' && PASSWORD_LABEL.test(value)) {
    const rest = text.slice(end);
    const assigned = ASSIGNED_VALUE.exec(rest) ?? PHRASED_ASSIGNED_VALUE.exec(rest);
    if (!assigned) return undefined;
    const assignedValue = assigned[1].replace(TRAILING_PUNCTUATION, '');
    if (!assignedValue) return undefined;
    start = end + assigned[0].indexOf(assigned[1]);
    end = start + assignedValue.length;
    value = text.slice(start, end);
  }
  const explicitPassword = label === 'password' && PASSWORD_ASSIGNMENT.test(text.slice(0, start));
  const wrappedPassword = explicitPassword && /^[^\s]+\r?\n[0-9]+$/.test(value);
  const narrowed = label === 'private key' ? null : LABEL_THEN_VALUE.exec(value);
  if (narrowed && narrowed[1] !== value) {
    start += value.lastIndexOf(narrowed[1]);
    end = start + narrowed[1].length;
    value = text.slice(start, end);
  } else if (/\s/.test(value) && label !== 'private key' && !wrappedPassword) {
    return undefined;
  }
  const padding = /^={1,2}(?![=A-Za-z0-9+/])/.exec(text.slice(end));
  if (padding && /^[A-Za-z0-9+/]{8,}$/.test(value) && (value.length + padding[0].length) % 4 === 0) {
    end += padding[0].length;
    value = text.slice(start, end);
  }
  if (end <= start) return undefined;
  const before = text.slice(0, start);
  if (!explicitPassword && (USERNAME_DESIGNATOR.test(before) || IDENTIFIER_KEY.test(before))) return undefined;
  // Tool names and prose are not credentials merely because a detector
  // labels them as such. Explicit assignments still protect weak passwords.
  const wholeWord = !/[A-Za-z0-9_]$/.test(before) && !/^[A-Za-z0-9_]/.test(text.slice(end));
  if (wholeWord && RUNBOOK_WORD.test(value) && !SECRET_ASSIGNMENT.test(before) && !inCredentialColumn(text, start, end)) {
    return undefined;
  }
  if (NEVER_REDACT.has(value)) return undefined;
  const rejected = NEVER_A_SECRET.find((shape: NeverASecret): boolean => {
    if (explicitPassword && (shape.name === 'too short' || (shape.name === 'figure' && /^\d+$/.test(value)))) {
      return false;
    }
    return shape.pattern.test(value);
  });
  return rejected ? undefined : { start, end };
}

/**
 * Whether a span is a whole cell of a Markdown table whose column header
 * names a credential: the `| Service | Username | Password |` table a
 * runbook keeps its logins in, where the label sits rows above the value.
 *
 * Args:
 *   text: The text the span indexes into.
 *   start: Span start.
 *   end: Span end.
 *
 * Returns:
 *   True when the value is the only content of a credential column's cell.
 */
function inCredentialColumn(text: string, start: number, end: number): boolean {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lineEndIndex = text.indexOf('\n', end);
  const lineEnd = lineEndIndex === -1 ? text.length : lineEndIndex;
  const cellBefore = text.slice(lineStart, start);
  const cellAfter = text.slice(end, lineEnd);
  if (!/\|[ \t]*$/.test(cellBefore) || !/^[ \t]*\|/.test(cellAfter)) return false;
  const cells = (line: string): string[] => {
    const parts = line.split('|').map((cell: string): string => cell.trim());
    return line.trimStart().startsWith('|') ? parts.slice(1) : parts;
  };
  const column = cells(cellBefore).length - 1;
  const lines = text.slice(0, lineStart).split('\n').slice(0, -1);
  let header: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (!line.includes('|')) break;
    if (!/^[\s|:-]+$/.test(line)) header = line;
  }
  if (header === undefined) return false;
  return SECRET_LABEL_WORD.test(cells(header)[column] ?? '');
}

/**
 * Read a span the model called a username as a `user / password` pair.
 *
 * "revops / hunter2" in a table cell or after "login:" is one name to the
 * model and two things to a reader: the half before the slash is the
 * username and stays, the half after it is the password and goes.
 *
 * Args:
 *   value: The trimmed span text.
 *
 * Returns:
 *   The two halves, or undefined when the span is not such a pair or the
 *   password half is a shape a secret never has.
 */
export function splitUserPasswordPair(value: string): { username: string; password: string } | undefined {
  const pair = USER_PASSWORD_PAIR.exec(value);
  if (!pair) return undefined;
  const password = pair[2].replace(TRAILING_PUNCTUATION, '');
  if (!password || guardReason(password)) return undefined;
  return { username: pair[1], password };
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
  const shape = NEVER_A_SECRET.find((candidate: NeverASecret): boolean => candidate.pattern.test(value))?.name;
  if (shape) return shape;
  return NEVER_REDACT.has(value) ? 'never-redact list' : undefined;
}
