import type { Doc, Id } from '../../convex/_generated/dataModel';
import type { QueryCtx } from '../../convex/_generated/server';

/**
 * The fence every documentation write carries: a sync generation writes only
 * while it is its source's running one. A newer sync supersedes the older
 * run, and without the fence the older action, still reading its last batch,
 * could write a page back after the newer generation removed it or revive a
 * credential the newer generation retired (P10-1, U2's residual).
 */
export const SUPERSEDED_GENERATION_REASON =
  'this documentation sync was superseded by a newer one, so its writes are refused';

/**
 * Why a generation may not write, or undefined when it may.
 *
 * @param sourceId - The source the write is for.
 * @param source - That source as it is now, or null once unlinked.
 * @param run - The generation the write came from, or null once deleted.
 */
export function generationRefusal(
  sourceId: Id<'docSources'>,
  source: Pick<Doc<'docSources'>, 'activeSyncId'> | null,
  run: Pick<Doc<'docSyncRuns'>, '_id' | 'sourceId' | 'state'> | null,
): string | undefined {
  if (source === null || run === null) return 'the documentation source or its sync is gone';
  if (run.sourceId !== sourceId) return 'the sync is not this source’s';
  if (source.activeSyncId !== run._id || run.state !== 'running') {
    return SUPERSEDED_GENERATION_REASON;
  }
  return undefined;
}

/**
 * Refuse a write from any generation but the source's running one, inside
 * the writing transaction so the check and the write cannot be separated.
 *
 * @throws Error naming why the generation may not write.
 */
export async function assertCurrentGeneration(
  ctx: Pick<QueryCtx, 'db'>,
  sourceId: Id<'docSources'>,
  syncRunId: Id<'docSyncRuns'>,
): Promise<void> {
  const [source, run] = await Promise.all([ctx.db.get(sourceId), ctx.db.get(syncRunId)]);
  const refusal = generationRefusal(sourceId, source, run);
  if (refusal !== undefined) throw new Error(refusal);
}
