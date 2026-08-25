import type { ActionCtx } from '../../convex/_generated/server';
import type { Id } from '../../convex/_generated/dataModel';
import { actionIdempotencyKey } from '../work/idempotency';
import type { MockAction, MockSurfaceSnapshot } from '../work/types';
import { mockAdapter } from './mock';
import type {
  AdapterRun,
  AppliedAction,
  SurfaceAdapter,
  SurfaceDescriptor,
  SurfaceMode,
} from './types';

/**
 * Resolve action verbs to their adapters for one execution mode.
 *
 * Args:
 *   mode: Deployment surface mode.
 *   surfaces: Discovered real surfaces available to later adapters.
 *
 * Returns:
 *   Adapter mapping keyed by action verb.
 */
export function resolveAdapters(
  mode: SurfaceMode,
  surfaces: readonly SurfaceDescriptor[],
): ReadonlyMap<string, SurfaceAdapter> {
  void mode;
  void surfaces;
  return new Map(mockAdapter.tools.map((tool: MockAction['tool']) => [tool, mockAdapter]));
}

/**
 * Read the environment snapshot through the registered adapters.
 *
 * Args:
 *   ctx: Convex action context.
 *   agentId: Agent whose workbench is read.
 *   mode: Deployment surface mode.
 *   surfaces: Discovered real surfaces available to later adapters.
 *
 * Returns:
 *   Complete environment snapshot consumed by skill execution.
 */
export async function readSurfaceSnapshot(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
  mode: SurfaceMode,
  surfaces: readonly SurfaceDescriptor[],
): Promise<MockSurfaceSnapshot> {
  const adapters = new Set(resolveAdapters(mode, surfaces).values());
  const snapshot: MockSurfaceSnapshot = {
    howToGuides: [],
    teamDocs: [],
    spreadsheets: [],
    slackChannels: [],
    tweets: [],
    tickets: [],
  };
  for (const adapter of adapters) {
    const fragment = await adapter.read(ctx, agentId);
    for (const key of Object.keys(snapshot) as Array<keyof MockSurfaceSnapshot>) {
      const values = fragment[key];
      if (values) snapshot[key].push(...(values as never[]));
    }
  }
  return snapshot;
}

/**
 * Apply skill actions through the adapter registry in their original order.
 *
 * Args:
 *   ctx: Convex action context.
 *   mode: Deployment surface mode.
 *   surfaces: Discovered real surfaces available to later adapters.
 *   run: Work execution identity and agent scope.
 *   actions: Actions emitted by the approved skill.
 *
 * Returns:
 *   One evidence row per proposed action.
 */
export async function applySurfaceActions(
  ctx: ActionCtx,
  mode: SurfaceMode,
  surfaces: readonly SurfaceDescriptor[],
  run: AdapterRun,
  actions: MockAction[],
): Promise<AppliedAction[]> {
  const adapters = resolveAdapters(mode, surfaces);
  const applied: AppliedAction[] = [];
  for (const [index, action] of actions.entries()) {
    const idempotencyKey = actionIdempotencyKey({
      workItemId: run.workItemId,
      runId: run.runId,
      actionIndex: index,
    });
    const adapter = adapters.get(action.tool);
    if (!adapter) {
      applied.push({
        tool: action.tool,
        ok: false,
        reason: 'unknown tool',
        idempotencyKey,
      });
      continue;
    }
    applied.push(await adapter.apply(ctx, run, action, index, idempotencyKey));
  }
  return applied;
}
