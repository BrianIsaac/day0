import type { ActionCtx } from '../../convex/_generated/server';
import type { Id } from '../../convex/_generated/dataModel';
import { actionIdempotencyKey } from '../work/idempotency';
import type { MockAction, MockSurfaceSnapshot } from '../work/types';
import type { DecryptCredential } from './credentials';
import { HttpAdapter, type FetchLike } from './http';
import { McpAdapter, type CreateMcpClient } from './mcp';
import { MOCK_TOOLS, mockAdapter } from './mock';
import {
  applyProvenance,
  AWAITING_APPROVAL,
  describeAction,
  grantRefusal,
  HELD_NOT_APPROVED,
  isAutomatic,
  isSurfaceTool,
  mockVerbRefusal,
  NOT_AUTOMATIC,
  parseSurfaceAction,
  pathRefusal,
  serialiseSurfaceAction,
  SHARED_WRITE_WITHOUT_ATTRIBUTION,
  sharedWriteWithoutAttribution,
  STATUS_WITHOUT_COMMENT,
  statusChangeWithoutComment,
  surfaceRefusal,
  toolRefusal,
  UNKNOWN_SURFACE,
  UNKNOWN_TOOL,
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
  /** Indexes to apply in this phase; every other index is recorded as held. */
  approvedIndexes?: ReadonlySet<number>;
  /** Reasons rows were held when the run was held; an unapproved index carries its own over `HELD_NOT_APPROVED`. */
  heldReasons?: ReadonlyMap<number, string>;
  /**
   * Rows the manager has not decided yet. Each gets a placeholder ledger row
   * (`AWAITING_APPROVAL`) and no adapter call; the approved phase replaces it.
   */
  deferredIndexes?: ReadonlySet<number>;
  /**
   * Ledger rows an earlier phase already decided, by index. They are carried
   * verbatim and their actions re-parsed, so the rules that read earlier rows
   * (comment before status, shared-write attribution) see what landed.
   */
  priorLedger?: ReadonlyArray<AppliedAction | undefined>;
  /**
   * Identifiers the run is working on. When set, this is the auto phase: a
   * row that is not a read, the manager DM or a comment on one of these is
   * refused even if it was listed, so a stale verdict cannot send it.
   */
  autoTargets?: readonly string[];
  /** Clock for the connection verdict. */
  now?: number;
}

/**
 * Resolve action verbs to their adapters for one execution mode.
 *
 * Mock mode maps only the four legacy verbs. Real mode maps `mcp.call` and
 * `http.request` when their runtime dependencies are supplied, and nothing
 * else: the mock tables are not a work surface in real mode (the seed never
 * fills them), and a legacy verb would otherwise write there without the
 * surface, grant and held checks every real action passes. No demo path
 * needs a mock verb in real mode - the manager DM goes through the connected
 * chat surface and the audit comment through the kanban surface.
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
    mode === 'mock' ? mockAdapter.tools.map((tool: MockAction['tool']) => [tool, mockAdapter]) : [],
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
 * Callers pass `'mock'` even in real mode: the mirrored documentation lives
 * in the mock docs table and is read-only context, which is not a write
 * surface.
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
 * arguments parse under the size cap, the surface is known and connected,
 * the agent holds the scope the action needs, in the auto phase the row is
 * one the ladder applies on its own, a status change follows a landed audit
 * comment, and provenance is added by the server. Actions not approved for
 * this phase are recorded as held (or as awaiting the manager) so the ledger
 * accounts for every index the skill emitted.
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
  run: Omit<AdapterRun, 'agentName'> & { agentName?: string },
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
    const prior = options.priorLedger?.[index];
    if (prior) {
      const parsed = isSurfaceTool(action.tool) ? parseSurfaceAction(action) : undefined;
      if (parsed?.ok) parsedByIndex[index] = parsed.action;
      applied.push(prior);
      continue;
    }
    if (options.approvedIndexes && !options.approvedIndexes.has(index)) {
      const deferred = options.deferredIndexes?.has(index) === true;
      applied.push({
        tool: action.tool,
        ok: true,
        held: true,
        reason: deferred ? AWAITING_APPROVAL : options.heldReasons?.get(index) ?? HELD_NOT_APPROVED,
        ...(deferred ? { awaitingApproval: true } : {}),
        effect: describeAction(action),
        idempotencyKey,
      });
      continue;
    }
    const adapter = adapters.get(action.tool);
    if (!adapter) {
      const reason =
        mode === 'real' && (MOCK_TOOLS as readonly string[]).includes(action.tool)
          ? mockVerbRefusal(action.tool)
          : UNKNOWN_TOOL;
      applied.push(refused(action.tool, reason, idempotencyKey));
      continue;
    }
    if (!isSurfaceTool(action.tool)) {
      applied.push(await adapter.apply(ctx, run as AdapterRun, action, index, idempotencyKey));
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
      applied.push(refused(action.tool, refusal ?? UNKNOWN_SURFACE, idempotencyKey));
      continue;
    }
    const pathMismatch = pathRefusal(parsed.action, surface);
    if (pathMismatch) {
      applied.push(refused(action.tool, pathMismatch, idempotencyKey));
      continue;
    }
    const unlisted = toolRefusal(parsed.action, surface);
    if (unlisted) {
      applied.push(refused(action.tool, unlisted, idempotencyKey));
      continue;
    }
    const ungranted = grantRefusal(parsed.action, surface, options.grants ?? new Set());
    if (ungranted) {
      applied.push(refused(action.tool, ungranted, idempotencyKey));
      continue;
    }
    if (options.autoTargets && !isAutomatic(parsed.action, surface, options.autoTargets)) {
      applied.push(refused(action.tool, NOT_AUTOMATIC, idempotencyKey));
      continue;
    }
    if (statusChangeWithoutComment(parsed.action, index, parsedByIndex, applied)) {
      applied.push(refused(action.tool, STATUS_WITHOUT_COMMENT, idempotencyKey));
      continue;
    }
    const credentialKind = surface.credentialKind ?? 'value';
    if (
      sharedWriteWithoutAttribution(
        parsed.action,
        surface,
        credentialKind,
        index,
        parsedByIndex,
        applied,
      )
    ) {
      applied.push(refused(action.tool, SHARED_WRITE_WITHOUT_ATTRIBUTION, idempotencyKey));
      continue;
    }
    const provenance = applyProvenance(
      parsed.action,
      surface,
      {
        agentName: run.agentName ?? 'Day0',
        workItemId: run.workItemId,
        runId: run.runId,
      },
      credentialKind,
    );
    if (!provenance.ok) {
      applied.push(refused(action.tool, provenance.reason, idempotencyKey));
      continue;
    }
    applied.push(
      await adapter.apply(
        ctx,
        { ...run, agentName: run.agentName ?? 'Day0' },
        serialiseSurfaceAction(provenance.action),
        index,
        idempotencyKey,
      ),
    );
  }
  return applied;
}
