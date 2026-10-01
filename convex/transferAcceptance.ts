import { ConvexError, v, type Infer } from 'convex/values';
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { assertNamedInTransfer } from './ownership';
import { clipRoleLine } from './agents';
import { charterAtHandover, discardUnapprovedCharter, renderIdentityForManager } from './charters';
import { purgeCredential } from './credentials';
import { appendEvent, eventsOfType } from './eventLog';
import { transferStateRefusal } from './managerTransfers';
import { readableDocs } from './mock';
import {
  RETIRE_PREVIEW_ROW_LIMIT,
  assertKeepable,
  boundariesOf,
  cancelJobsFor,
  employeeWorkItems,
  sortCredentials,
  wakeReleasedClaims,
  type Boundaries,
} from './reset';
import { handOverSurfaces, surfaceHandoversOf, type HandedOverSurfaces } from './surfaces';
import { failOneToOnesForHandover } from './voice';
import {
  needsYouOfEmployee,
  returnApprovalsForHandover,
  stopRunsForHandover,
  voidDecisionRequestsForHandover,
  type NeedsYouEntry,
} from './work';
import type { CharterConstraint } from '../src/agent/charter-constraints';
import {
  isTransferDue,
  transferSettleBy,
  type ManagerTransferState,
} from '../src/agent/manager-transfer';
import { log } from '../src/lib/logger';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { canonicalZone, deploymentZone } from '../src/lib/zone';
import { shownEmployeeState } from '../src/work/state-labels';

/*
 * The handover's acceptance and the move (the transfer plan, sections 6.1 to
 * 6.5). The named manager reads the preview and accepts; the move makes the
 * employee theirs. Two rules decide every row: nothing of the old owner's that
 * the employee does not need becomes readable by the new one, and nothing the
 * new owner cannot see keeps acting for the employee. The employee's own rows
 * move with the single write of `agents.userId`; what joins them to the old
 * owner is cut here, and what the old owner keeps is the request row and, in
 * real mode, a departure boundary (decision D11).
 *
 * Work in flight (section 6.4, decision D18): with no run executing, the move
 * is the acceptance's own transaction. With one, the request waits in
 * `accepting`: no new run starts (`convex/transferInFlight.ts`), each run's
 * end asks it to settle, and `settleDue` stops what outlives `settleBy` and
 * moves the employee. The move returns the approvals the old manager gave
 * that never started, closes their open requests, fails a one-to-one under
 * way, discards a charter never approved and sets their unsent notes aside.
 */

/**
 * The refusal for an employee that is gone, or no longer belongs to the manager who asked: a
 * request is a hand-over of what that manager had.
 */
export const EMPLOYEE_LEFT_ASKER =
  'The employee in this handover no longer works for the manager who asked.';

/** The refusal for a documentation source among the unticked that is not the acceptor's own. */
export const SOURCE_NOT_YOURS = 'A documentation source you unticked is not one of yours.';

/** The reason the record gives for the settings a handover returns to their defaults. */
const HANDED_OVER_REASON = 'handed over to a new manager';

/** The most of an employee's rows of one kind the preview reads, as the retire's preview does. */
const PREVIEW_ROW_LIMIT = RETIRE_PREVIEW_ROW_LIMIT;

/** The most of the acceptor's own documentation sources the preview lists for the ticks. */
const PREVIEW_SOURCE_LIMIT = 100;

/** The most `credential.superseded` events of one employee the move redacts. */
const SUPERSEDED_EVENT_LIMIT = 1_000;

/** One state of a work item. */
type WorkItemState = Doc<'workItems'>['state'];

/**
 * Whether work in each state is still open, rather than the record. Keyed over every state, so a
 * state the schema gains does not compile until it is placed.
 */
const WORK_IS_OPEN: Readonly<Record<WorkItemState, boolean>> = {
  discovered: true,
  claimed: true,
  'plan-pending': true,
  'plan-approved': true,
  executing: true,
  'actions-pending': true,
  deferred: true,
  'needs-skill': true,
  completed: false,
  cancelled: false,
  failed: false,
  skipped: false,
};

/** The states of open work, read one index range each. */
const OPEN_WORK_STATES = (Object.keys(WORK_IS_OPEN) as WorkItemState[]).filter(
  (state) => WORK_IS_OPEN[state],
);

/**
 * A request, if it can still be answered now: asked, and not past its expiry, which reads as
 * expired before the sweep marks it (`isTransferDue`). An `accepting` request may still move to
 * `accepted`, but only its settle moves it, never a second answer.
 *
 * @throws ConvexError with 9-U2's words for the state the request reads as now
 *   ({@link transferStateRefusal}).
 */
function assertAnswerable(transfer: Doc<'managerTransfers'>, now: number): void {
  const state: ManagerTransferState = isTransferDue(transfer, now) ? 'expired' : transfer.state;
  if (state !== 'asked') throw new ConvexError(transferStateRefusal(state));
}

/**
 * The employee a request hands over, while it still belongs to the manager who asked.
 *
 * @throws ConvexError with {@link EMPLOYEE_LEFT_ASKER} otherwise.
 */
async function departingEmployee(
  db: QueryCtx['db'],
  transfer: Doc<'managerTransfers'>,
): Promise<Doc<'agents'>> {
  const agent = await db.get(transfer.agentId);
  if (agent === null || agent.userId !== transfer.fromOwnerKey) {
    throw new ConvexError(EMPLOYEE_LEFT_ASKER);
  }
  return agent;
}

/**
 * How many of the employee's runs are in flight: the items executing, an apply that has started
 * among them (the transfer plan, section 6.4). The move waits for these. An approved set whose
 * apply has not started is not one: once the request is accepting the apply does not start, and
 * the move returns the set to held (D13).
 *
 * @param db - Any reader.
 * @param agentId - The employee.
 */
async function runsInFlight(db: QueryCtx['db'], agentId: Id<'agents'>): Promise<number> {
  const executing = await db
    .query('workItems')
    .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', 'executing'))
    .take(PREVIEW_ROW_LIMIT);
  return executing.length;
}

/** The employee's newest approved charter, the one in force, or null before one is approved. */
async function approvedCharterOf(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
): Promise<Doc<'charters'> | null> {
  const charters = db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc');
  for await (const charter of charters) if (charter.approved) return charter;
  return null;
}

/** The role line the roster would show from an approved charter, or null when it states none. */
function roleLineOf(charter: Doc<'charters'> | null): string | null {
  const proposed = (charter?.body as { proposedFunction?: unknown } | null | undefined)
    ?.proposedFunction;
  return typeof proposed === 'string' && proposed.trim() !== '' ? clipRoleLine(proposed) : null;
}

/**
 * The charter's reporting-line rules the manager has not struck, quoted: the old manager's own
 * words about whom the employee reports to, for the new manager to confirm or amend.
 */
function reportingLinesOf(charter: Doc<'charters'> | null): string[] {
  const constraints = (charter?.body as { constraints?: unknown } | null | undefined)?.constraints;
  if (!Array.isArray(constraints)) return [];
  return (constraints as Partial<CharterConstraint>[])
    .filter((rule) => rule.kind === 'reporting-line' && rule.struck !== true)
    .flatMap((rule) => (typeof rule.quote === 'string' ? [rule.quote] : []));
}

/** One connection the handover cuts, by the name the Surfaces tab gives it. */
const previewSurface = v.object({ slug: v.string(), displayName: v.string() });

/** One permission scope the employee holds, with the path that granted it. */
const previewScope = v.object({
  scope: v.string(),
  source: v.optional(
    v.union(v.literal('deploy'), v.literal('manager'), v.literal('skill'), v.literal('surface')),
  ),
});

/** What `transferPreview` answers. */
export const transferPreviewValidator = v.object({
  transferId: v.id('managerTransfers'),
  mode: v.union(v.literal('mock'), v.literal('real')),
  /** Who the employee is: never a charter clause or a work item's content. */
  employee: v.object({
    agentId: v.id('agents'),
    name: v.string(),
    avatarId: v.optional(v.string()),
    state: v.union(
      v.literal('deployed'),
      v.literal('day-one-in-progress'),
      v.literal('charter-pending'),
      v.literal('active'),
    ),
    /** The approved charter's role line, clipped as the roster shows it; null before one. */
    roleLine: v.union(v.string(), v.null()),
  }),
  fromAddress: v.string(),
  note: v.optional(v.string()),
  requestedAt: v.number(),
  expiresAt: v.number(),
  /** What the new manager takes on, as counts and names. */
  takesOn: v.object({
    /** The decisions waiting on the manager now, by the inbox's kinds, as counts. */
    waiting: v.object({
      'one-to-one': v.number(),
      charter: v.number(),
      plan: v.number(),
      held: v.number(),
      skill: v.number(),
      parked: v.number(),
      stopped: v.number(),
      surface: v.number(),
    }),
    /** Work items not yet closed (completed, cancelled, skipped or failed). */
    openWork: v.number(),
    openWorkAtLeast: v.boolean(),
    registeredSkills: v.number(),
    /** The newest charter's version and whether it is approved; null before one is drafted. */
    charter: v.union(v.null(), v.object({ version: v.string(), approved: v.boolean() })),
    /** The scopes that move (D9), the ones the cut revokes left out. */
    scopes: v.array(previewScope),
    recordLength: v.number(),
    recordAtLeast: v.boolean(),
  }),
  /** What does not come with the employee. */
  leavesBehind: v.object({
    /** The connections cut, which the new manager approves and connects again. */
    surfaces: v.array(previewSurface),
    /** The read scopes those connections had granted. */
    scopesRevoked: v.array(v.string()),
    /** Pages mirrored from the old manager's documentation that the employee stops reading. */
    mirroredPages: v.number(),
    mirroredPagesAtLeast: v.boolean(),
    /** Whether the autonomy switch is on now; it is off after the move. */
    autonomousActions: v.boolean(),
  }),
  /** The charter's reporting-line rules, quoted, for the new manager to check. */
  reportingLines: v.array(v.string()),
  /** The acceptor's own documentation sources, which the employee inherits unless unticked. */
  documentation: v.array(v.object({ sourceId: v.id('docSources'), label: v.string() })),
  /** Runs executing or applying now. */
  runsInFlight: v.number(),
});

/** The preview's answer. */
export type TransferPreview = Infer<typeof transferPreviewValidator>;

/**
 * The decisions waiting on the manager, by the inbox's kinds: `needsYouOfEmployee`'s entries,
 * the same rows the home and the employee's tab list, counted.
 */
function waitingByKind(entries: readonly NeedsYouEntry[]): TransferPreview['takesOn']['waiting'] {
  const count = (kind: NeedsYouEntry['kind']): number =>
    entries.filter((entry) => entry.kind === kind).length;
  return {
    'one-to-one': count('one-to-one'),
    charter: count('charter'),
    plan: count('plan'),
    held: count('held'),
    skill: count('skill'),
    parked: count('parked'),
    stopped: count('stopped'),
    surface: count('surface'),
  };
}

/**
 * What the employee takes to the new manager, as counts: its open work, its registered skills,
 * its charter, its scopes and its record, each read by index and bounded.
 */
async function takenOn(
  ctx: QueryCtx,
  agent: Doc<'agents'>,
  revokedScopes: ReadonlySet<string>,
): Promise<TransferPreview['takesOn']> {
  const agentId = agent._id;
  const [waiting, open, skills, newest, grants, events] = await Promise.all([
    needsYouOfEmployee(ctx, agent, Date.now()),
    Promise.all(
      OPEN_WORK_STATES.map(
        async (state) =>
          await ctx.db
            .query('workItems')
            .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
            .take(PREVIEW_ROW_LIMIT),
      ),
    ),
    ctx.db
      .query('skills')
      .withIndex('by_agent_name', (q) => q.eq('agentId', agentId))
      .take(PREVIEW_ROW_LIMIT),
    ctx.db
      .query('charters')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .order('desc')
      .first(),
    ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (q) => q.eq('agentId', agentId))
      .take(PREVIEW_ROW_LIMIT),
    ctx.db
      .query('events')
      .withIndex('by_agent', (q) => q.eq('agentId', agentId))
      .take(PREVIEW_ROW_LIMIT),
  ]);
  return {
    waiting: waitingByKind(waiting),
    openWork: open.reduce((total, rows) => total + rows.length, 0),
    openWorkAtLeast: open.some((rows) => rows.length >= PREVIEW_ROW_LIMIT),
    registeredSkills: skills.filter((skill) => skill.state === 'registered').length,
    charter: newest && { version: newest.version, approved: newest.approved },
    scopes: grants
      .filter((grant) => grant.revokedAt === undefined && !revokedScopes.has(grant.scope))
      .map((grant) => ({
        scope: grant.scope,
        ...(grant.source === undefined ? {} : { source: grant.source }),
      })),
    recordLength: events.length,
    recordAtLeast: events.length >= PREVIEW_ROW_LIMIT,
  };
}

/**
 * The read scopes the cut would revoke: each cut connection's `<slug>:read` that a connection
 * granted, as `handOverSurfaces` revokes them.
 */
async function scopesTheCutRevokes(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
  cutSlugs: readonly string[],
): Promise<string[]> {
  const revoked = await Promise.all(
    cutSlugs.map(async (slug) => {
      const scope = `${slug}:read`;
      const grants = await db
        .query('permissionGrants')
        .withIndex('by_agent_scope', (q) => q.eq('agentId', agentId).eq('scope', scope))
        .collect();
      const active = grants.some(
        (grant) =>
          grant.revokedAt === undefined &&
          (grant.source === 'surface' || grant.source === undefined),
      );
      return active ? [scope] : [];
    }),
  );
  return revoked.flat();
}

/**
 * The mirrored pages the employee stops reading: one paged read at the mirrors' own bound, so a
 * long-lived employee's pages are counted as "at least" rather than read in full.
 */
async function departingMirrors(
  ctx: QueryCtx,
  agent: Doc<'agents'>,
  toOwnerKey: string,
): Promise<{ count: number; atLeast: boolean }> {
  const page = await ctx.db
    .query('mockDocs')
    .withIndex('by_agent_slug', (q) => q.eq('agentId', agent._id))
    .paginate({ numItems: PREVIEW_ROW_LIMIT, maximumBytesRead: 4 * 1024 * 1024, cursor: null });
  const readable = new Set(
    (await readableDocs(ctx.db, { ...agent, userId: toOwnerKey }, page.page)).map((doc) => doc._id),
  );
  return {
    count: page.page.filter((doc) => !readable.has(doc._id)).length,
    atLeast: !page.isDone,
  };
}

/**
 * What accepting an asked handover would bring and leave (the transfer plan, section 6.1), for
 * the account it names: bounded reads by index, at most `RETIRE_PREVIEW_ROW_LIMIT` rows of each
 * kind, counts and names only, never the content of a work item, a charter or a record. Reads
 * the employee's mirrors with one paged read, so one query builds one preview.
 *
 * @param ctx - Any query context; the caller has already checked the account is the one named.
 * @param transfer - The request, `asked`.
 * @param acceptorKey - The named account's owner key, whose documentation the ticks list.
 * @throws ConvexError with {@link EMPLOYEE_LEFT_ASKER} when the employee is no longer the asker's.
 */
export async function transferPreviewOf(
  ctx: QueryCtx,
  transfer: Doc<'managerTransfers'>,
  acceptorKey: string,
): Promise<TransferPreview> {
  const agent = await departingEmployee(ctx.db, transfer);
  const planned = await surfaceHandoversOf(ctx.db, agent._id);
  const cut = planned.filter(({ handover }) => handover === 'cut').map(({ surface }) => surface);
  const scopesRevoked = await scopesTheCutRevokes(
    ctx.db,
    agent._id,
    cut.map((surface) => surface.slug),
  );
  const [charter, takesOn, mirrors, sources, inFlight] = await Promise.all([
    approvedCharterOf(ctx.db, agent._id),
    takenOn(ctx, agent, new Set(scopesRevoked)),
    departingMirrors(ctx, agent, acceptorKey),
    ctx.db
      .query('docSources')
      .withIndex('by_user', (q) => q.eq('userId', acceptorKey))
      .take(PREVIEW_SOURCE_LIMIT),
    runsInFlight(ctx.db, agent._id),
  ]);
  return {
    transferId: transfer._id,
    mode: SURFACE_MODE,
    employee: {
      agentId: agent._id,
      name: agent.name,
      ...(agent.avatarId === undefined ? {} : { avatarId: agent.avatarId }),
      state: shownEmployeeState(agent.state, takesOn.charter),
      roleLine: roleLineOf(charter),
    },
    fromAddress: transfer.fromAddress,
    ...(transfer.note === undefined ? {} : { note: transfer.note }),
    requestedAt: transfer.requestedAt,
    expiresAt: transfer.expiresAt,
    takesOn,
    leavesBehind: {
      surfaces: cut.map((surface) => ({ slug: surface.slug, displayName: surface.displayName })),
      scopesRevoked,
      mirroredPages: mirrors.count,
      mirroredPagesAtLeast: mirrors.atLeast,
      autonomousActions: agent.autonomousActions === true,
    },
    reportingLines: reportingLinesOf(charter),
    documentation: sources.map((source) => ({ sourceId: source._id, label: source.label })),
    runsInFlight: inFlight,
  };
}

/** What happened to the employee's live claims at the move. */
interface MovedClaims {
  readonly moved: number;
  readonly released: number;
  readonly conflictingKeys: string[];
}

/** The most work items one name of an item matches, as the claim guard reads them. */
const ALIAS_HOLDER_LIMIT = 20;

/**
 * Whether the new owner already holds a live claim on any of a claim's names: a claim keyed by
 * one of them, or a claim on a work item whose other name is one of them (the guard's own
 * `by_claim_alias` read).
 *
 * @param db - The move's reader.
 * @param toOwnerKey - The new owner.
 * @param claim - The moving claim.
 */
async function newOwnerHolds(
  db: QueryCtx['db'],
  toOwnerKey: string,
  claim: Doc<'externalClaims'>,
): Promise<boolean> {
  for (const name of [claim.key, ...(claim.aliases ?? [])]) {
    const keyed = await db
      .query('externalClaims')
      .withIndex('by_user_key', (q) => q.eq('userId', toOwnerKey).eq('key', name))
      .filter((q) => q.eq(q.field('releasedAt'), undefined))
      .first();
    if (keyed !== null) return true;
    const aliased = await db
      .query('workItems')
      .withIndex('by_claim_alias', (q) => q.eq('externalClaimAlias', name))
      .take(ALIAS_HOLDER_LIMIT);
    for (const item of aliased) {
      const live = await db
        .query('externalClaims')
        .withIndex('by_work_item', (q) => q.eq('workItemId', item._id))
        .filter((q) => q.eq(q.field('releasedAt'), undefined))
        .first();
      if (live?.userId === toOwnerKey) return true;
    }
  }
  return false;
}

/**
 * Decide each live claim of the employee (the transfer plan, section 6.3). A claim stays with
 * its item under the new owner (`userId` rewritten) while the item is open or may have written,
 * so the new owner's other employees meet it at once: no later step retakes a claim for an open
 * item. A claim the new owner already holds under any name is released and named instead, and
 * the new owner's holder works the item. A closed item that wrote nothing lets its claim go.
 * Either way a claim on work that wrote nothing no longer binds the old owner, whose employees
 * the caller wakes; the old owner's copy of every written claim is the departure's.
 *
 * @param ctx - The move's mutation context.
 * @param items - Every work item of the employee.
 * @param boundaries - The live claims, and which of them wrote nothing.
 * @param toOwnerKey - The new owner.
 * @param now - The move's time.
 */
async function moveClaims(
  ctx: MutationCtx,
  items: readonly Doc<'workItems'>[],
  boundaries: Boundaries,
  toOwnerKey: string,
  now: number,
): Promise<MovedClaims> {
  const unwritten = new Set<string>(boundaries.released);
  const stateOf = new Map(items.map((item) => [item._id, item.state]));
  let moved = 0;
  let released = 0;
  const conflictingKeys: string[] = [];
  for (const claim of boundaries.live) {
    const state = stateOf.get(claim.workItemId);
    const closed = state === undefined || !WORK_IS_OPEN[state];
    if (unwritten.has(claim._id) && closed) {
      await ctx.db.patch(claim._id, { releasedAt: now });
      released += 1;
    } else if (await newOwnerHolds(ctx.db, toOwnerKey, claim)) {
      await ctx.db.patch(claim._id, { releasedAt: now });
      conflictingKeys.push(claim.key);
    } else {
      await ctx.db.patch(claim._id, { userId: toOwnerKey });
      moved += 1;
    }
  }
  return { moved, released, conflictingKeys };
}

/**
 * The employee's `credential.superseded` events the move redacts, or the refusal when there are
 * more than one move redacts.
 */
async function supersededCredentialEvents(
  ctx: Pick<QueryCtx, 'db'>,
  agentId: Id<'agents'>,
): Promise<{ readonly events: Doc<'events'>[] } | { readonly refusal: string }> {
  const events = await eventsOfType(ctx, agentId, 'credential.superseded').take(
    SUPERSEDED_EVENT_LIMIT + 1,
  );
  if (events.length > SUPERSEDED_EVENT_LIMIT) {
    return {
      refusal: `This employee's record names more than ${SUPERSEDED_EVENT_LIMIT} superseded credentials, more than one handover can move.`,
    };
  }
  return { events };
}

/**
 * Strip the old owner's credential names from the employee's record: a `credential.superseded`
 * event names the credential and the page the old owner's documentation held it on. The record
 * moves whole (D10); the line stays, saying a credential left the documentation, without naming
 * either.
 *
 * @throws ConvexError, in words the dialog shows, when the employee has more such events than one
 *   move redacts.
 */
async function redactSupersededCredentials(ctx: MutationCtx, agentId: Id<'agents'>): Promise<void> {
  const found = await supersededCredentialEvents(ctx, agentId);
  if ('refusal' in found) throw new ConvexError(found.refusal);
  for (const event of found.events) {
    const payload = event.payload as Record<string, unknown>;
    await ctx.db.patch(event._id, { payload: { ...payload, label: '', page: '' } });
  }
}

/**
 * Return the employee's own settings to the new manager's: the zone their browser gave, autonomy
 * off (the old manager's standing authority, section 10.4), run notes per run, and the
 * documentation they ticked. Each change the record can show is recorded.
 */
async function settleEmployeeRow(
  ctx: MutationCtx,
  agent: Doc<'agents'>,
  transfer: AcceptedTransfer,
  now: number,
): Promise<void> {
  const zone = transfer.toZone ?? agent.zone ?? deploymentZone();
  const excluded = transfer.toExcludedDocSourceIds ?? [];
  await ctx.db.patch(agent._id, {
    userId: transfer.toOwnerKey,
    bossEmail: transfer.toAddress,
    zone,
    autonomousActions: undefined,
    managerNotifications: undefined,
    excludedDocSourceIds: excluded.length > 0 ? excluded : undefined,
  });
  if (agent.zone !== undefined && agent.zone !== zone) {
    await appendEvent(ctx, {
      agentId: agent._id,
      type: 'agent.zone-changed',
      payload: { from: agent.zone, to: zone },
      createdAt: now,
    });
  }
  if (agent.autonomousActions === true) {
    await appendEvent(ctx, {
      agentId: agent._id,
      type: 'agent.autonomy-changed',
      payload: { from: true, to: false, reason: HANDED_OVER_REASON },
      createdAt: now,
    });
  }
  if (agent.managerNotifications === 'digest') {
    await appendEvent(ctx, {
      agentId: agent._id,
      type: 'agent.notifications-changed',
      payload: { from: 'digest', to: 'per-run', reason: HANDED_OVER_REASON },
      createdAt: now,
    });
  }
}

/** What the move did, as the request row keeps it. */
type TransferOutcome = NonNullable<Doc<'managerTransfers'>['outcome']>;

/** A request with the acceptor's owner key written: the move's input. */
type AcceptedTransfer = Doc<'managerTransfers'> & { readonly toOwnerKey: string };

/** What cutting the employee's connections did. */
interface Cut {
  readonly surfaces: HandedOverSurfaces;
  readonly revoked: number;
  readonly kept: number;
}

/**
 * Cut the employee's connections (D5 (a)): the surfaces through `handOverSurfaces`, then each
 * credential they bound sorted by the retire's rule, revoked with its ciphertext deleted when
 * nothing else of the old owner's binds it and kept for them otherwise, and every pending job
 * naming a cut surface cancelled.
 */
async function cutConnections(
  ctx: MutationCtx,
  agent: Doc<'agents'>,
  transfer: AcceptedTransfer,
  now: number,
): Promise<Cut> {
  const surfaces = await handOverSurfaces(ctx, {
    agentId: agent._id,
    toOwnerKey: transfer.toOwnerKey,
    now,
  });
  const bound = new Set(surfaces.cut.flatMap((surface) => surface.boundCredentials));
  const { revoke, kept } = await sortCredentials(
    ctx.db,
    transfer.fromOwnerKey,
    bound,
    new Set([agent._id]),
  );
  for (const credential of revoke) await purgeCredential(ctx, credential, now);
  await cancelJobsFor(ctx, {
    ids: new Set(surfaces.cut.map((surface) => surface.surfaceId)),
    employees: new Set([agent._id]),
  });
  return { surfaces, revoked: revoke.length, kept: kept.size };
}

/**
 * Leave the old owner a departure row (decision D11): the boundary the employee's claims and
 * rejections keep for the old owner's other employees, read by every reader of a retirement
 * unchanged. Real mode only, as a single retire keeps one; mock mode keeps nothing.
 */
async function leaveDeparture(
  ctx: MutationCtx,
  agent: Doc<'agents'>,
  transfer: AcceptedTransfer,
  boundaries: Boundaries,
  cut: Cut,
  now: number,
): Promise<void> {
  if (SURFACE_MODE !== 'real') return;
  await ctx.db.insert('retirements', {
    userId: transfer.fromOwnerKey,
    kind: 'transferred',
    transferId: transfer._id,
    agentId: agent._id,
    agentName: agent.name,
    retiredAt: now,
    rowCounts: {},
    revokedCredentials: cut.revoked,
    keptCredentials: cut.kept,
    claims: boundaries.claims,
    rejections: boundaries.rejections,
  });
}

/**
 * Mark the request accepted with what the move did, and append one `manager.transferred` event
 * to the employee's record (the transfer plan, section 7.6). `decidedAt` and `toOwnerKey` are
 * the acceptance's, written when the request left `asked`, and the company figures read them as
 * the moment the employee changed hands (9-U5, D12): the move never writes them again, so a
 * request settled minutes after its acceptance keeps the acceptance's time.
 */
async function recordMove(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  transfer: AcceptedTransfer,
  outcome: TransferOutcome,
  cut: Cut,
  now: number,
): Promise<void> {
  await ctx.db.patch(transfer._id, { state: 'accepted', outcome });
  await appendEvent(ctx, {
    agentId,
    type: 'manager.transferred',
    payload: {
      transferId: transfer._id,
      fromAddress: transfer.fromAddress,
      toAddress: transfer.toAddress,
      surfacesCut: cut.surfaces.cut.map((surface) => surface.slug),
      scopesRevoked: [...cut.surfaces.scopesRevoked],
      credentialsRevoked: outcome.credentialsRevoked,
      credentialsKept: outcome.credentialsKept,
      claimsMoved: outcome.claimsMoved,
      claimsReleased: outcome.claimsReleased,
      conflictingClaimKeys: outcome.conflictingClaimKeys,
      decisionRequestsVoided: outcome.decisionRequestsVoided,
      plansReturned: outcome.plansReturned,
      runsStopped: outcome.runsStopped,
      charterDiscarded: outcome.charterDiscarded,
    },
    createdAt: now,
  });
}

/** The most unsent manager notes of one employee a move sets aside. */
const UNSENT_NOTE_LIMIT = 1_000;

/**
 * Set aside the notes kept for the old manager and not sent (the transfer plan, section 6.4): a
 * digest note, or a per-run note whose send has not claimed it. Each is marked `discardedAt` and
 * claimed with it, so neither the digest (`by_agent_unsent`) nor a per-run send
 * (`prepareManagerNote`) takes it; the events the notes summarise stay in the record. The note
 * lives beside the move rather than in `convex/managerChannelActions.ts`, whose Node runtime
 * holds actions only (standard 1.5).
 *
 * @returns How many notes were set aside.
 */
async function discardUnsentNotes(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  now: number,
): Promise<number> {
  const unsent = await ctx.db
    .query('managerNotes')
    .withIndex('by_agent_unsent', (q) =>
      q.eq('agentId', agentId).eq('claimedAt', undefined).eq('providerTs', undefined),
    )
    .take(UNSENT_NOTE_LIMIT);
  if (unsent.length === UNSENT_NOTE_LIMIT) {
    // An hour of digest notes is far below the bound; reaching it means a stuck digest, whose
    // remainder waits for a channel the cut has removed.
    log.warn('handover set aside the most unsent notes one move takes', { agentId, now });
  }
  for (const note of unsent) await ctx.db.patch(note._id, { discardedAt: now, claimedAt: now });
  return unsent.length;
}

/** What the move did with the employee's work in flight (the transfer plan, section 6.4). */
interface SettledWork {
  readonly decisionRequestsVoided: number;
  readonly plansReturned: number;
  readonly charterDiscarded: boolean;
  readonly sessionsFailed: number;
  readonly notesDiscarded: number;
}

/**
 * The move's section 6.4 steps, after the claims and before the owner write: the old manager's
 * open decision requests are closed (D6), the approvals they gave that never started are returned
 * (D13), a charter never approved is discarded and the employee returned to `deployed` (D8), a
 * one-to-one under way is failed, and the notes kept for their digest are set aside. Work in
 * every other state moves as it is.
 */
async function settleWorkInFlight(
  ctx: MutationCtx,
  agent: Doc<'agents'>,
  now: number,
): Promise<SettledWork> {
  const decisionRequestsVoided = await voidDecisionRequestsForHandover(ctx, agent._id, now);
  const plansReturned = await returnApprovalsForHandover(ctx, agent._id, now);
  const charterDiscarded = await discardUnapprovedCharter(ctx, agent);
  const sessionsFailed = await failOneToOnesForHandover(ctx, agent._id, {
    draftDiscarded: charterDiscarded,
  });
  const notesDiscarded = await discardUnsentNotes(ctx, agent._id, now);
  return {
    decisionRequestsVoided,
    plansReturned,
    charterDiscarded,
    sessionsFailed,
    notesDiscarded,
  };
}

/**
 * Why the move would refuse, read before anything is written: the employee gone or no longer
 * the asker's, a departure boundary larger than one row keeps (real mode), more superseded
 * credentials than one move redacts, or more draft charters than one move discards. The
 * acceptance refuses with these words before it enters `accepting`; a settle that meets one ends
 * the request rather than retrying it.
 *
 * @returns The refusal's words, or null when the move can be made.
 */
async function moveRefusal(
  ctx: Pick<QueryCtx, 'db'>,
  transfer: Doc<'managerTransfers'>,
  now: number,
): Promise<string | null> {
  const agent = await ctx.db.get(transfer.agentId);
  if (agent === null || agent.userId !== transfer.fromOwnerKey) return EMPLOYEE_LEFT_ASKER;
  if (SURFACE_MODE === 'real') {
    const boundaries = await boundariesOf(ctx.db, await employeeWorkItems(ctx.db, agent._id), now);
    try {
      assertKeepable(boundaries);
    } catch (err) {
      if (err instanceof ConvexError && typeof err.data === 'string') return err.data;
      throw err;
    }
  }
  const superseded = await supersededCredentialEvents(ctx, agent._id);
  if ('refusal' in superseded) return superseded.refusal;
  const charter = await charterAtHandover(ctx.db, agent);
  return charter.kind === 'refused' ? charter.refusal : null;
}

/**
 * Move the employee to the manager who accepted its handover, in one transaction (the transfer
 * plan, sections 6.2 to 6.5). In order: the departure boundary is read before anything changes;
 * the connections are cut ({@link cutConnections}); the live claims are moved or released; the
 * work in flight is settled ({@link settleWorkInFlight}); the old owner's credential names leave
 * the record; the employee row is written for the new owner and the identity file rendered for
 * them; the old owner keeps a departure row in real mode, and their employees a released claim
 * refused are woken; the old mirrors are deleted in pages and the new owner's documentation
 * mirrored; and the request is marked accepted with what the move did, beside one
 * `manager.transferred` event.
 *
 * @param ctx - The acceptance's or the settle's mutation context.
 * @param transfer - The request, with the acceptor's owner key written.
 * @param move - The move's time, and how many runs the settle stopped before it.
 * @returns What the move did.
 * @throws ConvexError with {@link EMPLOYEE_LEFT_ASKER} when the employee is no longer the asker's;
 *   ConvexError with {@link moveRefusal}'s other words when it is more than one move takes.
 */
async function moveEmployeeInTransaction(
  ctx: MutationCtx,
  transfer: AcceptedTransfer,
  move: { readonly now: number; readonly runsStopped: number },
): Promise<TransferOutcome> {
  const { now } = move;
  const agent = await departingEmployee(ctx.db, transfer);
  const items = await employeeWorkItems(ctx.db, agent._id);
  const boundaries = await boundariesOf(ctx.db, items, now);
  if (SURFACE_MODE === 'real') assertKeepable(boundaries);

  const cut = await cutConnections(ctx, agent, transfer, now);
  const claims = await moveClaims(ctx, items, boundaries, transfer.toOwnerKey, now);
  const work = await settleWorkInFlight(ctx, agent, now);
  await redactSupersededCredentials(ctx, agent._id);
  await settleEmployeeRow(ctx, agent, transfer, now);
  await renderIdentityForManager(ctx, agent._id);
  await leaveDeparture(ctx, agent, transfer, boundaries, cut, now);
  await wakeReleasedClaims(ctx, transfer.fromOwnerKey, boundaries.released);
  await ctx.scheduler.runAfter(0, internal.docSources.pruneDepartedMirrors, {
    agentId: agent._id,
    transferId: transfer._id,
  });
  await ctx.scheduler.runAfter(0, internal.docSyncActions.mirrorForAgent, { agentId: agent._id });

  const outcome: TransferOutcome = {
    workItemsMoved: items.length,
    surfacesCut: cut.surfaces.cut.length,
    credentialsRevoked: cut.revoked,
    credentialsKept: cut.kept,
    scopesRevoked: cut.surfaces.scopesRevoked.length,
    claimsMoved: claims.moved,
    claimsReleased: claims.released,
    conflictingClaimKeys: claims.conflictingKeys,
    decisionRequestsVoided: work.decisionRequestsVoided,
    plansReturned: work.plansReturned,
    sessionsFailed: work.sessionsFailed,
    notesDiscarded: work.notesDiscarded,
    // Counted page by page as `pruneDepartedMirrors` deletes them.
    mirroredPagesHidden: 0,
    runsStopped: move.runsStopped,
    charterDiscarded: work.charterDiscarded,
  };
  await recordMove(ctx, agent._id, transfer, outcome, cut, now);
  return outcome;
}

/**
 * The acceptor's documentation ticks, each checked to be one of their own sources, as `deploy`
 * checks them.
 *
 * @throws ConvexError with {@link SOURCE_NOT_YOURS} for a source that is not the acceptor's.
 */
async function assertOwnSources(
  db: QueryCtx['db'],
  ownerKey: string,
  sourceIds: readonly Id<'docSources'>[],
): Promise<void> {
  for (const sourceId of sourceIds) {
    const source = await db.get(sourceId);
    if (source === null || source.userId !== ownerKey) throw new ConvexError(SOURCE_NOT_YOURS);
  }
}

/** What `accept` answers: the employee, and whether it moved or waits for its runs. */
const acceptedValidator = v.object({
  agentId: v.id('agents'),
  state: v.union(v.literal('accepted'), v.literal('accepting')),
});

/**
 * Accept a handover (the transfer plan, sections 5.1 and 6; decision D18). With no run executing
 * the employee becomes the caller's in this transaction (`accepted`). With runs executing the
 * request enters `accepting`: the acceptance is given and irrevocable, no new run starts, and the
 * move waits for the runs to end, or for `settleBy` (`transferSettleBy`, fifteen minutes), when
 * {@link settleDue} stops what remains and moves the employee.
 *
 * Public, for the account the request names only (`assertNamedInTransfer`, which also refuses
 * the account that asked). The request must be `asked` and unexpired, and the employee still the
 * asker's. `zone` is the acceptor's browser zone, as `deploy` takes it (N12); one the backend
 * does not know reads as the deployment's. `excludedDocSourceIds` are the acceptor's own sources
 * the employee should not read, as the deploy form's ticks. Writes the acceptance's stamp
 * (`decidedAt`, `toOwnerKey`) and the acceptor's choices in the one patch that takes the request
 * out of `asked`; the company figures read the stamp and nothing writes it again. Then the move
 * (`moveEmployeeInTransaction`), or `accepting` with its `settleBy`.
 *
 * @returns The employee, and `accepted` when it is now the caller's or `accepting` when it moves
 *   once its runs end.
 * @throws ConvexError with words the dialog shows for every refusal, the move's own included
 *   before the request enters `accepting`.
 */
export const accept = mutation({
  args: {
    transferId: v.id('managerTransfers'),
    zone: v.optional(v.string()),
    excludedDocSourceIds: v.optional(v.array(v.id('docSources'))),
  },
  returns: acceptedValidator,
  handler: async (ctx, args): Promise<Infer<typeof acceptedValidator>> => {
    const { transfer, caller } = await assertNamedInTransfer(ctx, args.transferId);
    const now = Date.now();
    assertAnswerable(transfer, now);
    const agent = await departingEmployee(ctx.db, transfer);
    const excluded = args.excludedDocSourceIds ?? [];
    await assertOwnSources(ctx.db, caller.ownerKey, excluded);
    // The acceptance's stamp, written as the request leaves `asked`, whichever state it enters:
    // the company figures read `decidedAt` and `toOwnerKey` on accepting and accepted rows.
    const acceptance = {
      decidedAt: now,
      toOwnerKey: caller.ownerKey,
      toZone: canonicalZone(args.zone) ?? deploymentZone(),
      toExcludedDocSourceIds: excluded,
    };
    if ((await runsInFlight(ctx.db, agent._id)) > 0) {
      const refusal = await moveRefusal(ctx, transfer, now);
      if (refusal !== null) throw new ConvexError(refusal);
      await ctx.db.patch(transfer._id, {
        state: 'accepting',
        settleBy: transferSettleBy(now),
        ...acceptance,
      });
      return { agentId: agent._id, state: 'accepting' };
    }
    await ctx.db.patch(transfer._id, acceptance);
    await moveEmployeeInTransaction(ctx, { ...transfer, ...acceptance }, { now, runsStopped: 0 });
    return { agentId: agent._id, state: 'accepted' };
  },
});

/**
 * End an `accepting` request whose move cannot be made, rather than retry it at every sweep: the
 * employee stays its old manager's, and the request is `cancelled`, the one final state that says
 * so. Its acceptance's stamp is kept as it was written (nothing writes `decidedAt` again), and
 * since the company figures cut only at an accepting or accepted request, the old manager's
 * figures run on unbroken. `TRANSFER_MOVES` (`src/agent/manager-transfer.ts`) names no way out of
 * `accepting` but the move, so this one write steps outside it; the cockpit has the patch that
 * names it there.
 */
async function endUnmovable(
  ctx: MutationCtx,
  transfer: Doc<'managerTransfers'>,
  refusal: string,
): Promise<void> {
  await ctx.db.patch(transfer._id, { state: 'cancelled' });
  log.error('accepted handover could not move; ended', {
    transferId: transfer._id,
    agentId: transfer.agentId,
    reason: refusal,
  });
}

/** What a settle did with its request. */
const settleOutcomeValidator = v.union(
  v.literal('moved'),
  v.literal('waiting'),
  v.literal('ended'),
  v.literal('not-accepting'),
);

/**
 * Settle a finishing handover (the transfer plan, section 6.4; D18): once no run of the employee
 * is executing, or once `settleBy` has passed, the runs that remain are stopped
 * (`stopRunsForHandover`, "the employee was handed over to a new manager") and the employee is
 * moved with the acceptor's choices kept on the row. Before that, it waits. A request no longer
 * `accepting` is left as it is, so a second settle does nothing; one whose move would be refused
 * is ended ({@link endUnmovable}).
 *
 * Internal; scheduled by every path out of a run (`convex/transferInFlight.ts`) and by
 * {@link settleDue}. Writes what the stop and the move write.
 *
 * @returns `moved`, `waiting`, `ended`, or `not-accepting`.
 */
export const settle = internalMutation({
  args: { transferId: v.id('managerTransfers') },
  returns: settleOutcomeValidator,
  handler: async (ctx, args): Promise<Infer<typeof settleOutcomeValidator>> => {
    const transfer = await ctx.db.get(args.transferId);
    if (transfer === null || transfer.state !== 'accepting') return 'not-accepting';
    const now = Date.now();
    const { toOwnerKey } = transfer;
    if (toOwnerKey === undefined) {
      await endUnmovable(ctx, transfer, 'the accepted handover names no acceptor');
      return 'ended';
    }
    const refusal = await moveRefusal(ctx, transfer, now);
    if (refusal !== null) {
      await endUnmovable(ctx, transfer, refusal);
      return 'ended';
    }
    const due = transfer.settleBy === undefined || transfer.settleBy <= now;
    if (!due && (await runsInFlight(ctx.db, transfer.agentId)) > 0) return 'waiting';
    const runsStopped = await stopRunsForHandover(ctx, transfer.agentId);
    await moveEmployeeInTransaction(ctx, { ...transfer, toOwnerKey }, { now, runsStopped });
    return 'moved';
  },
});

/** The most finishing requests one sweep reads, the soonest deadline first. */
const SETTLE_SWEEP_LIMIT = 50;

/**
 * The settle's sweep (the cron's, every minute): each `accepting` request past its `settleBy`, or
 * with no run left executing, is settled in a transaction of its own. The second case is the
 * backstop for a run that ended by a path that asked for no settle (a resumed run returned to its
 * approved plan, an interrupted apply), so no request waits past a minute once its runs are over.
 *
 * Internal; the cron's. Writes nothing itself; schedules {@link settle}.
 *
 * @returns How many settles were scheduled.
 */
export const settleDue = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const now = Date.now();
    const finishing = await ctx.db
      .query('managerTransfers')
      .withIndex('by_state_settle', (q) => q.eq('state', 'accepting'))
      .take(SETTLE_SWEEP_LIMIT);
    let scheduled = 0;
    for (const transfer of finishing) {
      const due = transfer.settleBy === undefined || transfer.settleBy <= now;
      if (!due && (await runsInFlight(ctx.db, transfer.agentId)) > 0) continue;
      await ctx.scheduler.runAfter(0, internal.transferAcceptance.settle, {
        transferId: transfer._id,
      });
      scheduled += 1;
    }
    return { scheduled };
  },
});

// The module's last definition: the decryption-reach scan reads a public query's source up to
// the next export (tests/convex/credentialCryptoActions.test.ts), and the move above revokes.
/**
 * What accepting a handover would bring and leave, for the acceptance dialog
 * ({@link transferPreviewOf}). A request is not a grant of read access (section 4.4).
 *
 * Public, for the account the request names only (`assertNamedInTransfer`); writes nothing.
 *
 * @returns The preview, or null when the request is no longer waiting for an answer, or is past
 *   its expiry and so would be refused, before the expiry sweep marks it.
 * @throws ConvexError with the guard's words for any other caller.
 */
export const transferPreview = query({
  args: { transferId: v.id('managerTransfers') },
  returns: v.union(v.null(), transferPreviewValidator),
  handler: async (ctx, args): Promise<TransferPreview | null> => {
    const { transfer, caller } = await assertNamedInTransfer(ctx, args.transferId);
    if (transfer.state !== 'asked' || transfer.expiresAt <= Date.now()) return null;
    return await transferPreviewOf(ctx, transfer, caller.ownerKey);
  },
});
