import type { Doc, Id } from '../../convex/_generated/dataModel';

/**
 * Whether an employee reads one of its owner's documentation sources: every source the owner
 * links, before or after the deploy, except the ones it was deployed without.
 *
 * @param agent - The employee's row, of which only its deploy-time exclusions are read.
 * @param sourceId - The owner-level source.
 * @returns True when the source is mirrored for the employee.
 */
export function agentReadsSource(
  agent: Pick<Doc<'agents'>, 'excludedDocSourceIds'>,
  sourceId: Id<'docSources'>,
): boolean {
  return !agent.excludedDocSourceIds?.includes(sourceId);
}
