/**
 * `{{secret}}` substitution for `http.request` headers and bodies.
 *
 * A skill never sees a credential value: the runbook shows `{{secret}}` where
 * the token goes, the model copies the placeholder, and the adapter replaces
 * it inside the action with the surface's decrypted credential. The grammar is
 * deliberately tiny. `{{secret}}` is the surface's own credential;
 * `{{secret:<slug>}}` is accepted only when `<slug>` is the action's target,
 * because a template that asks for another surface's secret is either a
 * confused skill or an attempt to send one system's key to another.
 */

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

export const REDACTED = '<redacted>';

/** Raised when a template asks for something other than its own secret. */
export class SecretTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretTemplateError';
  }
}

/**
 * Whether a template contains any `{{...}}` placeholder.
 *
 * Args:
 *   template: Header value or body text.
 *
 * Returns:
 *   True when at least one placeholder is present.
 */
export function hasPlaceholder(template: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(template);
}

/**
 * Replace `{{secret}}` with the surface's credential value.
 *
 * Args:
 *   template: Header value or body text written by the skill.
 *   value: The decrypted credential for the action's target surface.
 *   surfaceSlug: The action's target surface, used to check a qualified
 *     placeholder such as `{{secret:linear}}`.
 *
 * Returns:
 *   The template with every secret placeholder substituted.
 *
 * Raises:
 *   SecretTemplateError: If a placeholder names another surface's secret or
 *     an unknown value.
 */
export function injectSecret(template: string, value: string, surfaceSlug?: string): string {
  return template.replace(PLACEHOLDER, (_match: string, rawName: string): string => {
    const name = rawName.trim();
    if (name === 'secret') return value;
    const qualified = /^secret[:.]([A-Za-z0-9_-]+)$/.exec(name);
    if (qualified) {
      const named = qualified[1];
      if (surfaceSlug !== undefined && named === surfaceSlug) return value;
      throw new SecretTemplateError(
        `template names a secret for surface "${named}", which is not the action's target`,
      );
    }
    throw new SecretTemplateError(`unknown placeholder {{${name}}}; only {{secret}} is allowed`);
  });
}

/**
 * Remove a credential value from text destined for the ledger or a log.
 *
 * Args:
 *   text: Provider output or error message.
 *   value: The credential value to remove; ignored when empty.
 *
 * Returns:
 *   The text with every occurrence of the value replaced by `<redacted>`.
 */
export function redactValue(text: string, value: string): string {
  if (!value) return text;
  const representations = new Set([
    value,
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
  ]);
  let redacted = text;
  for (const representation of representations) {
    if (representation) redacted = redacted.split(representation).join(REDACTED);
  }
  return redacted;
}
