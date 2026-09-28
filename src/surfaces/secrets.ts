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

/** `{{secret}}`, or its qualified form `{{secret:<slug>}}`. */
const SECRET_PLACEHOLDER = /\{\{\s*secret(?:[:.][A-Za-z0-9_-]+)?\s*\}\}/;

/** Whether a template names the credential, bare or qualified. */
function namesSecret(template: string): boolean {
  return SECRET_PLACEHOLDER.test(template);
}

/** The parts of an `http.request` a placeholder could sit in. */
export interface HttpRequestParts {
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/**
 * Why an `http.request` may not carry the credential where it asks to, or
 * undefined when every placeholder sits in a header value.
 *
 * A header is how an API takes its key; a body or a path is content the
 * system stores or logs, and a skill's body can be steered by what a
 * colleague wrote in a ticket, so `{"body":"key: {{secret}}"}` would post the
 * key as a comment while the manager's preview showed only the placeholder.
 * So the HTTP rung, like the browser rung, puts the credential only where a
 * credential goes.
 *
 * @param request - The request as the skill wrote it, before substitution.
 */
export function httpSecretPlacementRefusal(request: HttpRequestParts): string | undefined {
  const misplaced = [
    ...(namesSecret(request.path) ? ['the path'] : []),
    ...Object.keys(request.headers)
      .filter((name: string): boolean => namesSecret(name))
      .map((name: string): string => `the header name ${name}`),
    ...(request.body !== undefined && namesSecret(request.body) ? ['the body'] : []),
  ];
  if (misplaced.length === 0) return undefined;
  return `{{secret}} goes only in a header value, never in ${misplaced.join(', ')}, so the credential was not sent`;
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
