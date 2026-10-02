import type { ActionCtx } from '../../convex/_generated/server';
import type { Id } from '../../convex/_generated/dataModel';
import type { MockAction, MockSurfaceSnapshot } from '../work/types';
import type { PersistedSurfaceVerdict } from './verdict';

/** The deployment's surface mode: the seeded mock office, or the reader's real systems. */
export type SurfaceMode = 'mock' | 'real';

/** The three rungs a real system is reached by, in ladder order, then the escalation that ends the ladder. */
export const SURFACE_PATHS = ['mcp', 'documented-api', 'browser-driven', 'escalate'] as const;

/** One way of reaching a real system. */
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

/** How a credential can be landed on a surface. */
export const CREDENTIAL_KINDS = ['value', 'location', 'oauth'] as const;

/**
 * How a surface's credential was landed. `value` and `location` are shared
 * keys handed over to the agent, so writes through them carry the employee's
 * name; `oauth` is a dedicated app that posts as itself.
 */
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/**
 * How a write through a card is attributed to the employee: by the server's trailer, where the
 * card acts through an identity others share or a person's delegated grant, or by the vendor
 * itself, where the card acts as the employee's own identity (the access plan, section 4.2).
 */
export const ATTRIBUTIONS = ['trailer', 'identity'] as const;

/** One of {@link ATTRIBUTIONS}. */
export type Attribution = (typeof ATTRIBUTIONS)[number];

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
  pathCandidates?: Array<{ path: SurfacePath; endpoint: string }>;
  probeAttempts?: Array<{
    path: string;
    endpoint?: string;
    outcome: 'demoted' | 'ungranted' | 'listed-dead' | 'retried';
    reason: string;
    attemptedAt: number;
    retryAfterMs?: number;
  }>;
  endpoint?: string;
  toolAllowlist?: string[];
  toolArguments?: Array<{ tool: string; arguments: string[] }>;
  credentialId?: string;
  credentialKind?: CredentialKind;
  /**
   * How writes through the card are attributed, read off the identity it acts as (`actsAs`);
   * absent for a card that names no identity, whose credential's kind decides.
   */
  attribution?: Attribution;
  managerDmChannelId?: string;
  /** The probed DM counterpart; only this provider user may resolve a decision. */
  managerUserId?: string;
  /** The manager's Slack display name, read at probe time; names the DM on the card. */
  managerName?: string;
}

/** @deprecated Use `SurfaceRecord`; kept so callers that pass `[]` still type-check. */
export type SurfaceDescriptor = SurfaceRecord;

/** The run an adapter acts for: the employee, its name, the item and the run id. */
export interface AdapterRun {
  agentId: Id<'agents'>;
  /** The employee's display name, written into provenance trailers and chat identity. */
  agentName: string;
  workItemId: Id<'workItems'>;
  runId: Id<'events'>;
}

/**
 * Revalidate persisted authority at the last boundary before a provider request.
 *
 * A replayed browser call passes the authority its original row landed
 * under, and is checked under that rather than the phase's own rule.
 */
export type BeforeSurfaceTransport = (
  action: MockAction,
  surface: SurfaceRecord,
  replay?: { authority?: ActionAuthority },
) => Promise<string | undefined>;

/** What kind of change an applicable action makes, which decides its disposition and its held reason. */
export type ActionClass = 'read' | 'manager-dm' | 'public-post' | 'mutation' | 'write';

/** What happened to one action: whether it landed, its effect, and why not when it did not. */
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
   * Set when the span model was not consulted before this row was persisted,
   * so only the exact-value and structural layers protected its text.
   */
  redaction?: 'structural-only';
  /**
   * What authorised a surface row the adapter was asked to apply: the
   * manager's approval of the literal payload, the autonomous-actions
   * toggle, or the agent's standing grant (a read or the manager DM in the
   * auto phase while the toggle is off). The audit trail shows the mode.
   */
  authority?: ActionAuthority;
  /**
   * What the landed row was when it was sent (`policy.actionClass`): a read,
   * the manager DM, or a change. Recorded at the send, so a later figure
   * never reclassifies it against a surface whose manager DM has moved since
   * (review M16). Absent on rows sent before it was recorded.
   */
  actionClass?: ActionClass;
  /**
   * When the row landed, in epoch milliseconds: stamped by the apply path the
   * moment the adapter answered, so the first week's Working is dated by the
   * write itself and never by the event or the work item that later carried
   * it. Absent on a row that did not land and on rows sent before it was
   * recorded.
   */
  landedAt?: number;
  providerId?: string;
  /**
   * The elements a browser action acted on, as the page offered them when the
   * action was resolved: the driver's ref, the accessible name and the role.
   * The action's own arguments carry only what the skill called each one; a
   * page redesign can make the two differ, and the audit needs to know which
   * control was pressed. Absent on every other row, and on rows sent before it
   * was recorded.
   */
  elements?: ActedElement[];
  /**
   * The first attempt at this row, when the provider refused its arguments
   * and the executor re-authored them once. The row itself is the second
   * attempt's outcome; nothing was applied twice.
   */
  repair?: ActionRepair;
  /**
   * The browser session this invocation re-established before sending this
   * row, when it was the first action on a browser-driven surface and not a
   * navigate. Each replayed transport call is its own nested row; the
   * ledger's top-level rows stay index-aligned with the actions.
   */
  sessionRestore?: SessionRestore;
  /**
   * Set on a read taken again when a retry resumed at the closing phase, in
   * place of the carried row it re-read: that row's key and effect, and when
   * the read was taken again. The carried row itself stays on the earlier
   * run's `work.failed` record.
   */
  refreshed?: ReadRefresh;
}

/** One element a browser action acted on, as the page's snapshot named it. */
export interface ActedElement {
  /** The driver's reference, valid only for the snapshot it was read from. */
  readonly ref: string;
  /** The accessible name, with the credential and stored values removed. */
  readonly name: string;
  readonly role: string;
}

/** The carried read a re-read on resume replaced, and when it was read again. */
export interface ReadRefresh {
  previous: { effect?: string; idempotencyKey: string };
  at: number;
}

/** What the provider refused before the one bounded argument repair. */
export interface ActionRepair {
  reason: string;
  toolArgsJson: string;
}

/** The replayed calls that signed a new browser in again before a row was sent. */
export interface SessionRestore {
  steps: SessionRestoreStep[];
}

/**
 * One replayed transport call. Its key is the triggering row's key with
 * `.session-<n>` appended, so it keeps the three colon-separated parts of a
 * run key; its authority is the replayed row's own, checked again at
 * transport.
 */
export interface SessionRestoreStep extends AppliedAction {
  /** The key of the landed row this step replays; absent for the endpoint navigate added when the run never navigated. */
  replayOf?: string;
  /** The browser call replayed, as the run recorded it: a credential stays a `{{secret}}` placeholder. */
  action: MockAction;
}

/** One call a session replay makes, with the landed row it repeats. */
export interface SessionRecipeStep {
  /** The browser call as the run recorded it; a credential stays a `{{secret}}` placeholder. */
  action: MockAction;
  /** The key of the landed row this step replays; absent for the endpoint navigate. */
  replayOf?: string;
  /** The authority the replayed row landed under, re-checked at transport. */
  authority?: ActionAuthority;
}

/** What a session replay did: every step it attempted, and why it stopped if it did. */
export type SessionRestoreResult =
  | { ok: true; steps: SessionRestoreStep[] }
  | { ok: false; steps: SessionRestoreStep[]; reason: string };

/** Who or what authorised an applied surface action. */
export type ActionAuthority = 'manager' | 'autonomous' | 'standing';

/**
 * Whether a ledger row landed on its system: it succeeded and is neither held
 * for the manager nor waiting on an approval. Every gate, resume and re-read
 * reads landing through this one predicate.
 */
export function landedEntry(row: AppliedAction | undefined): row is AppliedAction {
  return row?.ok === true && row.held !== true && row.awaitingApproval !== true;
}

/** One ledger row: the outcome of an action with the tool and the idempotency key it ran under. */
export interface AppliedAction extends ActionOutcome {
  tool: string;
  idempotencyKey: string;
}

/** What every surface adapter provides: its tools, a read of its state and an apply of one action. */
export interface SurfaceAdapter {
  readonly tools: readonly MockAction['tool'][];
  /**
   * Release anything the adapter held open for the run.
   *
   * Only the browser floor needs this: it keeps one live browser per run so a
   * sign-in survives to the action that presses Save, and that browser has to
   * be closed when the run's actions are done rather than left holding a
   * signed-in page. Every other adapter is stateless between actions.
   */
  close?(): Promise<void>;
  /**
   * Sign the run's browser for a surface in again, in this invocation's
   * session, by replaying the run's own landed rows before the first action
   * that needs the page. Only the browser floor implements it.
   */
  restoreSession?(
    ctx: ActionCtx,
    run: AdapterRun,
    surface: SurfaceRecord,
    recipe: readonly SessionRecipeStep[],
    baseKey: string,
  ): Promise<SessionRestoreResult>;
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
    transportAuthority?: ActionAuthority,
  ): Promise<AppliedAction>;
}

/** What orientation files for a system it wants connected: the target, the evidence and the scope it asks for. */
export interface ConnectRequest {
  target: {
    system: string;
    class: string;
    chosenPath: SurfacePath;
    fallbackPath: SurfacePath;
    ladder?: Array<{ path: Exclude<SurfacePath, 'escalate'>; endpoint: string }>;
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
  rollback: string;
  openQuestions: string[];
}
