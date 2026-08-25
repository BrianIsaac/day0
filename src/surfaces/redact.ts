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
  /(?<![A-Za-z0-9])(?:lin_api_|xox[baprs]-|ntn_|secret_)[A-Za-z0-9._-]{5,}[A-Za-z0-9_-]/gi;
const BEARER = /\bBearer\s+[^\s,;"'`<>]+/gi;
const LABELLED_VALUE =
  /(^|\n)([^\n:]{0,48}\b(?:token|key|secret|password)\b[^\n:]{0,32}:[ \t]*)`?([^\s`<]+)`?/gi;

export const REDACTED = '<redacted>';

/**
 * Replace every recognisable credential shape in a text.
 *
 * Three shapes are covered: provider-prefixed tokens wherever they occur,
 * the value after `Bearer`, and the value on a line that labels itself as a
 * token, key, secret or password. A `<credential: ..., stored>` marker is
 * left alone, because it is already the safe form.
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
    .replace(
      LABELLED_VALUE,
      (_match: string, lineStart: string, label: string): string =>
        `${lineStart}${label}${REDACTED}`,
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
  const safe = redactSecret(raw, secret).replace(/\s+/g, ' ').trim();
  return (safe || fallback).slice(0, maxLength);
}
