import { droppedScriptSuffix } from '../lib/short-hash';

/**
 * Convert a provider or candidate label to the surface slug convention.
 *
 * Kept free of model imports so the planner and the evaluator can share it
 * without the planner pulling in the evaluator's model client. A name in any
 * script keeps a key of its own: the ASCII part as before, and a digest of the
 * name beside it when the name has letters the ASCII part cannot hold (N8).
 *
 * Args:
 *   value: Provider or candidate label.
 *
 * Returns:
 *   A lowercase URL-safe surface slug.
 */
export function surfaceSlug(value: string): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${ascii || 'system'}${droppedScriptSuffix(value)}`;
}
