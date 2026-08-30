/** The model every arm of the evaluation and every shipped agent run uses unless configured. */
export const DEFAULT_MODEL = 'gpt-5.5';

/**
 * Resolve the configured model name the way the app does, from a plain
 * environment, so a Convex query can report the deployment's setting
 * without importing the provider client.
 *
 * Args:
 *   values: Environment values to inspect.
 *
 * Returns:
 *   The configured model name, or the shipped default when unset or empty.
 */
export function modelName(values: Partial<NodeJS.ProcessEnv> = process.env): string {
  const configured = values.OPENAI_MODEL?.trim();
  return configured ? configured : DEFAULT_MODEL;
}
