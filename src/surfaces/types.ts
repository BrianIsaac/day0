import type { ActionCtx } from '../../convex/_generated/server';
import type { Id } from '../../convex/_generated/dataModel';
import type { MockAction, MockSurfaceSnapshot } from '../work/types';

export type SurfaceMode = 'mock' | 'real';

export const SURFACE_PATHS = ['mcp', 'documented-api', 'browser-driven', 'escalate'] as const;

export type SurfacePath = (typeof SURFACE_PATHS)[number];

/**
 * Check whether an untrusted value names a supported surface path.
 *
 * Args:
 *   value: Value read from persisted or model-produced input.
 *
 * Returns:
 *   True when the value is a supported surface path.
 */
export function isSurfacePath(value: unknown): value is SurfacePath {
  return typeof value === 'string' && SURFACE_PATHS.includes(value as SurfacePath);
}

export interface SurfaceDescriptor {
  slug: string;
  path?: SurfacePath;
}

export interface AdapterRun {
  agentId: Id<'agents'>;
  workItemId: Id<'workItems'>;
  runId: Id<'events'>;
}

export interface ActionOutcome {
  ok: boolean;
  effect?: string;
  reason?: string;
  held?: boolean;
  providerId?: string;
}

export interface AppliedAction extends ActionOutcome {
  tool: string;
  idempotencyKey: string;
}

export interface SurfaceAdapter {
  readonly tools: readonly MockAction['tool'][];
  read(ctx: ActionCtx, agentId: Id<'agents'>): Promise<Partial<MockSurfaceSnapshot>>;
  apply(
    ctx: ActionCtx,
    run: AdapterRun,
    action: MockAction,
    index: number,
    idempotencyKey: string,
  ): Promise<AppliedAction>;
}

export interface ConnectRequest {
  target: {
    system: string;
    class: string;
    chosenPath: SurfacePath;
    fallbackPath: SurfacePath;
    confidence: number;
    reasoning: string;
  };
  evidence: Array<{ sourceId: string; ref: string; quote: string }>;
  scopeRequested: string[];
  credential: {
    owner?: string;
    method: 'api-key' | 'bot-token' | 'oauth' | 'unknown';
    envName: string;
  };
  blastRadius: string;
  costBand: 'none' | 'low' | 'medium';
  expiresInDays: number;
  rollback: string;
  openQuestions: string[];
}
