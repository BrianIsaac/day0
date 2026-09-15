/**
 * Convert a provider or candidate label to the surface slug convention.
 *
 * Kept free of imports so the planner and the evaluator can share it without
 * the planner pulling in the evaluator's model client.
 *
 * Args:
 *   value: Provider or candidate label.
 *
 * Returns:
 *   A lowercase URL-safe surface slug.
 */
export function surfaceSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'system'
  );
}
