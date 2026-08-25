import type { ActionCtx } from '../../convex/_generated/server';
import type { Id } from '../../convex/_generated/dataModel';
import { actionIdempotencyKey } from '../work/idempotency';
import type { MockAction, MockSurfaceSnapshot } from '../work/types';
import type { DecryptCredential } from './credentials';
import { HttpAdapter, type FetchLike } from './http';
import { McpAdapter, type CreateMcpClient } from './mcp';
import { mockAdapter } from './mock';
import {
  applyProvenance,
  describeAction,
  HELD_NOT_APPROVED,
  heldReason,
  isSurfaceTool,
  NO_GRANT,
  parseSurfaceAction,
  requiredScope,
  serialiseSurfaceAction,
  STATUS_WITHOUT_COMMENT,
  statusChangeWithoutComment,
  surfaceRefusal,
  type ParsedSurfaceAction,
} from './policy';
import type {
  AdapterRun,
  AppliedAction,
  SurfaceAdapter,
  SurfaceRecord,
  SurfaceMode,
} from './types';

/**
 * What the real-mode adapters need from the runtime that hosts them. Supplied
 * by the Node action that applies the run, and by tests with fakes.
 */
export interface RealAdapterDeps {
  decrypt: DecryptCredential;
  createMcpClient: CreateMcpClient;
  fetch: FetchLike;
  now?: () => number;
}

export interface ApplyOptions {
  /** Real-mode adapter dependencies; required whenever `mode` is `real`. */
  deps?: RealAdapterDeps;
  /** Live permission scopes; a surface action without its scope is refused. */
  grants?: ReadonlySet<string>;
  /** Indexes the manager approved; every other index is recorded as held. */
  approvedIndexes?: ReadonlySet<number>;
  /** Clock for the connection verdict. */
  now?: number;
}

/**
 * Resolve action verbs to their adapters for one execution mode.
 *
 * Mock mode maps only the four legacy verbs. Real mode adds `mcp.call` and
 * `http.request` when their runtime dependencies are supplied, and keeps the
 * mock adapter for the legacy verbs so skills authored against the mock still
 * run against the mock tables.
 *
 * Args:
 *   mode: Deployment surface mode.
 *   surfaces: The agent's surfaces.
 *   deps: Real-mode adapter dependencies.
 *
 * Returns:
 *   Adapter mapping keyed by action verb.
 */
export function resolveAdapters(
  mode: SurfaceMode,
  surfaces: readonly SurfaceRecord[],
  deps?: RealAdapterDeps,
): ReadonlyMap<string, SurfaceAdapter> {
  const adapters = new Map<string, SurfaceAdapter>(
    mockAdapter.tools.map((tool: MockAction['tool']) => [tool, mockAdapter]),
  );
  if (mode === 'real' && deps) {
    const now = deps.now ?? ((): number => Date.now());
    const mcp = new McpAdapter(surfaces, {
      decrypt: deps.decrypt,
      createClient: deps.createMcpClient,
      now,
    });
    const http = new HttpAdapter(surfaces, { decrypt: deps.decrypt, fetch: deps.fetch, now });
    for (const tool of mcp.tools) adapters.set(tool, mcp);
    for (const tool of http.tools) adapters.set(tool, http);
  }
  return adapters;
}

/**
 * Read the environment snapshot through the registered adapters.
 *
 * Args:
 *   ctx: Convex action context.
 *   agentId: Agent whose workbench is read.
 *   mode: Deployment surface mode.
 *   surfaces: The agent's surfaces.
 *
 * Returns:
 *   Complete environment snapshot consumed by skill execution.
 */
export async function readSurfaceSnapshot(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
  mode: SurfaceMode,
  surfaces: readonly SurfaceRecord[],
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

function refused(tool: string, reason: string, idempotencyKey: string): AppliedAction {
  return { tool, ok: false, reason, idempotencyKey };
}

/**
 * Apply skill actions through the adapter registry in their original order.
 *
 * Every surface action passes the same rules before its adapter runs:
 * arguments parse under the size cap, the surface is known and connected, a
 * public post is held rather than sent, the agent holds the scope the action
 * needs, a status change follows a landed audit comment, and provenance is
 * added by the server. Actions the manager did not approve are recorded as
 * held so the ledger accounts for every index the skill emitted.
 *
 * Args:
 *   ctx: Convex action context.
 *   mode: Deployment surface mode.
 *   surfaces: The agent's surfaces.
 *   run: Work execution identity and agent scope.
 *   actions: Actions emitted by the approved skill.
 *   options: Dependencies, grants, approvals and clock.
 *
 * Returns:
 *   One evidence row per emitted action.
 *
 * Raises:
 *   Error: If real mode is requested without adapter dependencies.
 */
export async function applySurfaceActions(
  ctx: ActionCtx,
  mode: SurfaceMode,
  surfaces: readonly SurfaceRecord[],
  run: AdapterRun,
  actions: MockAction[],
  options: ApplyOptions = {},
): Promise<AppliedAction[]> {
  if (mode === 'real' && !options.deps) {
    throw new Error('real-mode surface adapters need their runtime dependencies');
  }
  const adapters = resolveAdapters(mode, surfaces, options.deps);
  const now = options.now ?? Date.now();
  const applied: AppliedAction[] = [];
  const parsedByIndex: Array<ParsedSurfaceAction | undefined> = [];
  for (const [index, action] of actions.entries()) {
    const idempotencyKey = actionIdempotencyKey({
      workItemId: run.workItemId,
      runId: run.runId,
      actionIndex: index,
    });
    if (options.approvedIndexes && !options.approvedIndexes.has(index)) {
      applied.push({
        tool: action.tool,
        ok: true,
        held: true,
        reason: HELD_NOT_APPROVED,
        effect: describeAction(action),
        idempotencyKey,
      });
      continue;
    }
    const adapter = adapters.get(action.tool);
    if (!adapter) {
      applied.push(refused(action.tool, 'unknown tool', idempotencyKey));
      continue;
    }
    if (!isSurfaceTool(action.tool)) {
      applied.push(await adapter.apply(ctx, run, action, index, idempotencyKey));
      continue;
    }
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok) {
      applied.push(refused(action.tool, parsed.reason, idempotencyKey));
      continue;
    }
    parsedByIndex[index] = parsed.action;
    const surface = surfaces.find((row) => row.slug === parsed.action.surface);
    const refusal = surfaceRefusal(surface, now);
    if (!surface || refusal) {
      applied.push(refused(action.tool, refusal ?? 'unknown surface', idempotencyKey));
      continue;
    }
    const held = heldReason(parsed.action, surface);
    if (held) {
      applied.push({
        tool: action.tool,
        ok: true,
        held: true,
        reason: held,
        effect: describeAction(action),
        idempotencyKey,
      });
      continue;
    }
    const scope = requiredScope(parsed.action);
    if (!options.grants?.has(scope)) {
      applied.push(refused(action.tool, `${NO_GRANT} (${scope})`, idempotencyKey));
      continue;
    }
    if (statusChangeWithoutComment(parsed.action, index, parsedByIndex, applied)) {
      applied.push(refused(action.tool, STATUS_WITHOUT_COMMENT, idempotencyKey));
      continue;
    }
    const provenance = applyProvenance(
      parsed.action,
      surface,
      { agentName: run.agentName, workItemId: run.workItemId, runId: run.runId },
      surface.credentialKind ?? 'value',
    );
    if (!provenance.ok) {
      applied.push(refused(action.tool, provenance.reason, idempotencyKey));
      continue;
    }
    applied.push(
      await adapter.apply(ctx, run, serialiseSurfaceAction(provenance.action), index, idempotencyKey),
    );
  }
  return applied;
}
