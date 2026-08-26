import type { ActionCtx } from '../../convex/_generated/server';
import type { Id } from '../../convex/_generated/dataModel';
import type { MockAction, MockSurfaceSnapshot } from '../work/types';
import type { PersistedSurfaceVerdict } from './verdict';

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

export const CREDENTIAL_KINDS = ['value', 'location', 'oauth'] as const;

/**
 * How a surface's credential was landed. `value` and `location` are shared
 * keys handed over to the agent, so writes through them carry the employee's
 * name; `oauth` is a dedicated app that posts as itself.
 */
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/**
 * The surface fields the executors read. A structural subset of the
 * `surfaces` row: the adapters never depend on the whole document, so a row
 * from any lane's schema revision can be narrowed to this shape.
 */
export interface SurfaceRecord {
  slug: string;
  displayName: string;
  class: string;
  verdict: PersistedSurfaceVerdict;
  credentialLanded: boolean;
  lastVerifiedAt?: number;
  path?: SurfacePath;
  endpoint?: string;
  toolAllowlist?: string[];
  toolArguments?: Array<{ tool: string; arguments: string[] }>;
  credentialId?: string;
  credentialKind?: CredentialKind;
  managerDmChannelId?: string;
  /** The probed DM counterpart; only this provider user may resolve a decision. */
  managerUserId?: string;
  /** The manager's Slack display name, read at probe time; names the DM on the card. */
  managerName?: string;
}

/** @deprecated Use `SurfaceRecord`; kept so callers that pass `[]` still type-check. */
export type SurfaceDescriptor = SurfaceRecord;

export interface AdapterRun {
  agentId: Id<'agents'>;
  /** The employee's display name, written into provenance trailers and chat identity. */
  agentName: string;
  workItemId: Id<'workItems'>;
  runId: Id<'events'>;
}

/** Revalidate persisted authority at the last boundary before a provider request. */
export type BeforeSurfaceTransport = (
  action: MockAction,
  surface: SurfaceRecord,
) => Promise<string | undefined>;

export interface ActionOutcome {
  ok: boolean;
  effect?: string;
  reason?: string;
  held?: boolean;
  /** The provider received the request but no authoritative outcome came back. */
  outcomeUnknown?: boolean;
  /** A placeholder written by the auto phase for a row the manager has not decided. */
  awaitingApproval?: boolean;
  /**
   * What authorised a surface row the adapter was asked to apply: the
   * manager's approval of the literal payload, the autonomous-actions
   * toggle, or the agent's standing grant (a read or the manager DM in the
   * auto phase while the toggle is off). The audit trail shows the mode.
   */
  authority?: ActionAuthority;
  providerId?: string;
}

/** Who or what authorised an applied surface action. */
export type ActionAuthority = 'manager' | 'autonomous' | 'standing';

export interface AppliedAction extends ActionOutcome {
  tool: string;
  idempotencyKey: string;
}

export interface SurfaceAdapter {
  readonly tools: readonly MockAction['tool'][];
  /**
   * Apply one action. The adapter receives the action after the registry has
   * parsed its arguments, checked the grant, and decided whether it is held.
   */
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
