import type { SpanModel } from '../redaction/client';
import { redactStructural, REDACTED, redactText, type RedactionDegradation } from '../redaction/redact';

/**
 * The synchronous redaction floor for surface metadata, prompts and exports.
 *
 * Documentation is redacted by the span model at sync time and provider
 * outcomes at persistence, so the orientation run, the probe, intake and the
 * executor prompt only ever see stored, already-redacted text. These helpers
 * exist for the places that cannot await a model - a query rendering an
 * export, a prompt line assembled from stored material, a failure message on
 * its way into a card - and apply the two layers that need no model: the
 * exact value a transport holds, and the structural grammar (a URL's userinfo
 * password, a PEM block, a JSON web token, an `Authorization` header value).
 */

export { REDACTED };

/**
 * Replace every structural secret in a text.
 *
 * Args:
 *   text: Untrusted text from a page, a provider or a model.
 *
 * Returns:
 *   The same text with each structural secret replaced by `<redacted>`.
 */
export function redactTokenShapes(text: string): string {
  return redactStructural(text);
}

/**
 * Decide whether a text carries a structural secret.
 *
 * Args:
 *   text: Untrusted text.
 *
 * Returns:
 *   True when redaction would change the text.
 */
export function containsTokenShape(text: string): boolean {
  return redactStructural(text) !== text;
}

/**
 * Remove an exact secret value and every structural secret from a text.
 *
 * Args:
 *   text: Untrusted text that may quote the secret.
 *   secret: The decrypted value to remove exactly, or an empty string.
 *   known: The owner's other stored values, removed the same way.
 *
 * Returns:
 *   Text with every exact value and every structural secret redacted.
 */
export function redactSecret(text: string, secret: string, known: readonly string[] = []): string {
  return redactStructural(text, [...(secret ? [secret] : []), ...known]);
}

export interface RedactedOutcome {
  text: string;
  /** Set when the span model was not consulted and only the two floors ran. */
  redaction?: RedactionDegradation;
}

/**
 * Redact a provider outcome before it is persisted to the ledger.
 *
 * The transport's own credential and every value the owner stores are
 * removed exactly, the structural grammar runs, and the span model decides
 * the rest under the `outcome` policy. A model that cannot be reached does
 * not lose the outcome: the row is persisted with the two floors applied and
 * says so in `redaction`; the exact layer is never what degraded.
 *
 * Args:
 *   text: A provider effect, reason or error message.
 *   secret: The decrypted credential the transport sent, or an empty string.
 *   model: The span model, or undefined when none is configured.
 *   known: The owner's stored values, resolved once by the hosting action.
 *
 * Returns:
 *   The redacted text and whether the model was part of it.
 */
export async function redactOutcome(
  text: string,
  secret: string,
  model: SpanModel | undefined,
  known: readonly string[] = [],
): Promise<RedactedOutcome> {
  const result = await redactText(text, 'outcome', {
    model,
    known: [...(secret ? [secret] : []), ...known],
    onUnavailable: 'structural',
  });
  return result.degraded ? { text: result.text, redaction: result.degraded } : { text: result.text };
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
 *   known: The owner's stored values, removed the same way as the secret.
 *
 * Returns:
 *   A single line with no credential material.
 */
export function safeFailureMessage(
  error: unknown,
  secret: string,
  fallback: string,
  maxLength = 300,
  known: readonly string[] = [],
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line: string): string => line.trim())
      .find((line: string): boolean => line.length > 0) ?? '';
  const safe = redactSecret(firstLine, secret, known).replace(/\s+/g, ' ').trim();
  return (safe || fallback).slice(0, maxLength);
}
