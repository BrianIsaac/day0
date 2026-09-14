import {
  CONNECTION_PASSWORD,
  LABELLED_ENTROPY_FLOOR_BITS,
  REFERENCE_START,
  URL_SCHEME,
  shannonBits,
} from '../docs/redaction';

/**
 * Defence in depth for credential material in surface metadata.
 *
 * Documentation is redacted at sync time before it is persisted, so the
 * orientation run, the probe and intake should only ever see markers. These
 * helpers exist for the page that was not redacted, the provider error that
 * echoes a header, and the model draft that copies its input: nothing that
 * passes through them can carry a recognisable token shape into a card, an
 * event, a reason or a model prompt.
 */

const TOKEN_SHAPE =
  /(?<![A-Za-z0-9])(?:lin_api_|xox[baprs]-|ntn_|secret_|sk-(?:proj-|svcacct-)?)[A-Za-z0-9._-]{5,}[A-Za-z0-9_-]/gi;
// A bearer value is at least twelve characters: "Bearer header." in prose is
// not a credential, "Bearer opaque-value-here" is.
const BEARER = /\bBearer\s+(?=[^\s,;"'`<>]{12,})[^\s,;"'`<>]+/gi;
const LABELLED_VALUE =
  /(^|\n)([^\n:]{0,48}\b(?:token|key|secret|password)\b[^\n:]{0,32}:[ \t]*)`?([^\s`<]+)`?/gi;
// A password or secret label names a credential outright, and real passwords
// are short ("hunter2"), so the value is redacted at any entropy. A token or
// key label also introduces identifiers ("Ticket key: REVOPS-7") and counts,
// and a URL on any line is a location whose password segment is handled on
// its own, so those values must clear the documentation redactor's floor.
const CREDENTIAL_LABEL = /\b(?:secret|password)\b/i;

export const REDACTED = '<redacted>';

/**
 * Replace every recognisable credential shape in a text.
 *
 * Four shapes are covered: provider-prefixed tokens wherever they occur,
 * the value after `Bearer`, the password segment of a connection string,
 * and the value on a line that labels itself as a
 * token, key, secret or password. A password or secret value is redacted
 * whatever its length; a token or key value only when it clears the
 * documentation redactor's entropy floor, so an issue key or a budget on
 * such a line survives. A reference (`<password>`, `${VAR}`) and a
 * `<credential: ..., stored>` marker are left alone, because they are
 * already the safe form.
 *
 * Args:
 *   text: Untrusted text from a page, a provider or a model.
 *
 * Returns:
 *   The same text with each shape replaced by `<redacted>`.
 */
export function redactTokenShapes(text: string): string {
  return text
    .replace(TOKEN_SHAPE, REDACTED)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(CONNECTION_PASSWORD, (match: string, _scheme: string, password: string): string =>
      REFERENCE_START.test(password)
        ? match
        : `${match.slice(0, match.lastIndexOf(`${password}@`))}${REDACTED}@`,
    )
    .replace(
      LABELLED_VALUE,
      (match: string, lineStart: string, label: string, value: string): string => {
        if (REFERENCE_START.test(value)) return match;
        const credential =
          (CREDENTIAL_LABEL.test(label) && !URL_SCHEME.test(value)) ||
          shannonBits(value) >= LABELLED_ENTROPY_FLOOR_BITS;
        return credential ? `${lineStart}${label}${REDACTED}` : match;
      },
    );
}

/**
 * Decide whether a text carries a recognisable credential shape.
 *
 * Args:
 *   text: Untrusted text.
 *
 * Returns:
 *   True when redaction would change the text.
 */
export function containsTokenShape(text: string): boolean {
  return redactTokenShapes(text) !== text;
}

/**
 * Remove an exact secret value and every token shape from a text.
 *
 * Args:
 *   text: Untrusted text that may quote the secret.
 *   secret: The decrypted value to remove exactly, or an empty string.
 *
 * Returns:
 *   Text with the exact value and every recognisable shape redacted.
 */
export function redactSecret(text: string, secret: string): string {
  const withoutExactValue = secret ? text.replaceAll(secret, REDACTED) : text;
  return redactTokenShapes(withoutExactValue);
}

/**
 * Convert a provider or transport failure into one safe, bounded line.
 *
 * Only the first non-empty line of the message is kept: a client library
 * that appends its stack trace to the provider's answer would otherwise
 * fill the card with file paths instead of the reason.
 *
 * Args:
 *   error: The failure.
 *   secret: The decrypted value that must not appear in the line.
 *   fallback: Message when the failure carries no text at all.
 *   maxLength: Upper bound on the persisted line.
 *
 * Returns:
 *   A single line with no credential material.
 */
export function safeFailureMessage(
  error: unknown,
  secret: string,
  fallback: string,
  maxLength = 300,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line: string): string => line.trim())
      .find((line: string): boolean => line.length > 0) ?? '';
  const safe = redactSecret(firstLine, secret).replace(/\s+/g, ' ').trim();
  return (safe || fallback).slice(0, maxLength);
}
