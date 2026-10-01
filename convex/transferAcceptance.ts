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
import { renderIdentityForManager } from './charters';
import { purgeCredential } from './credentials';
import { appendEvent, eventsOfType } from './eventLog';
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
import { canMoveTransfer } from '../src/agent/manager-transfer';
import type { CharterConstraint } from '../src/agent/charter-constraints';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { canonicalZone, deploymentZone } from '../src/lib/zone';
import { shownEmployeeState } from '../src/work/state-labels';

/*
 * The handover's acceptance and the move (the transfer plan, sections 6.1 to
 * 6.3 and 6.5). The named manager reads the preview and accepts; the move
 * makes the employee theirs in the acceptance's own transaction. Two rules
 * decide every row: nothing of the old owner's that the employee does not
 * need becomes readable by the new one, and nothing the new owner cannot see
 * keeps acting for the employee. The employee's own rows move with the single
 * write of `agents.userId`; what joins them to the old owner is cut here, and
 * what the old owner keeps is the request row and, in real mode, a departure
 * boundary (decision D11).
 *
 * Work in flight at acceptance (section 6.4) is the next unit's: `accept`
 * refuses while a run is in flight, and the move leaves the work items as
 * they are.
 */

/** The refusal for a request no longer waiting for an answer. A `ConvexError`'s data. */
export const TRANSFER_NOT_OPEN = 'This handover is no longer waiting for an answer.';

/** The refusal for a request whose answer came after it expired, before the sweep marked it. */
export const TRANSFER_EXPIRED_UNANSWERED = 'This handover expired before it was accepted.';

/**
 * The refusal for an employee that is gone, or no longer belongs to the manager who asked: a
 * request is a hand-over of what that manager had.
 */
export const EMPLOYEE_LEFT_ASKER =
  'The employee in this handover no longer works for the manager who asked.';

/** The refusal for a documentation source among the unticked that is not the acceptor's own. */
export const SOURCE_NOT_YOURS = 'A documentation source you unticked is not one of yours.';

/**
 * The refusal while the employee has runs in flight. The move waits for them (decision D18);
 * until the `accepting` state lands, the acceptance is asked again once they end.
 *
 * @param name - The employee's name.
 * @param runs - How many runs are executing or applying.
 */
export function runsInFlightRefusal(name: string, runs: number): string {
  const what = runs === 1 ? 'a run' : `${runs} runs`;
  return `${name} is in the middle of ${what}. Accept again once ${runs === 1 ? 'it ends' : 'they end'}.`;
}

/** The reason the record gives for the settings a handover returns to their defaults. */
const HANDED_OVER_REASON = 'handed over to a new manager';

/** The most of an employee's rows of one kind the preview reads, as the retire's preview does. */
const PREVIEW_ROW_LIMIT = RETIRE_PREVIEW_ROW_LIMIT;

/** The most of the acceptor's own documentation sources the preview lists for the ticks. */
const PREVIEW_SOURCE_LIMIT = 100;

/** The most `credential.superseded` events of one employee the move redacts. */
const SUPERSEDED_EVENT_LIMIT = 1_000;

/** The work item states that are the record rather than open work. */
const CLOSED_WORK_STATES: ReadonlySet<Doc<'workItems'>['state']> = new Set([
  'completed',
  'cancelled',
  'skipped',
  'failed',
]);

/** A request, if it can still be answered now: asked, and not past its expiry. */
function assertAnswerable(transfer: Doc<'managerTransfers'>, now: number): void {
  if (!canMoveTransfer(transfer.state, 'accepted')) throw new ConvexError(TRANSFER_NOT_OPEN);
  if (transfer.expiresAt <= now) throw new ConvexError(TRANSFER_EXPIRED_UNANSWERED);
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
 * How many of the employee's runs are in flight: items executing, and items whose held actions
 * were approved and whose apply is scheduled or running (the transfer plan, section 6.4).
 *
 * @param db - Any reader.
 * @param agentId - The employee.
 */
async function runsInFlight(db: QueryCtx['db'], agentId: Id<'agents'>): Promise<number> {
  const inState = async (state: Doc<'workItems'>['state']): Promise<Doc<'workItems'>[]> =>
    await db
      .query('workItems')
      .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
      .take(PREVIEW_ROW_LIMIT);
  const [executing, pending] = await Promise.all([
    inState('executing'),
    inState('actions-pending'),
  ]);
  return executing.length + pending.filter((row) => row.approvedIndexes !== undefined).length;
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
 * What the employee takes to the new manager, as counts: its open work, its registered skills,
 * its charter, its scopes and its record, each read by index and bounded.
 */
async function takenOn(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
  revokedScopes: ReadonlySet<string>,
): Promise<TransferPreview['takesOn']> {
  const [items, skills, newest, grants, events] = await Promise.all([
    employeeWorkItems(ctx.db, agentId, PREVIEW_ROW_LIMIT),
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
    openWork: items.filter((item) => !CLOSED_WORK_STATES.has(item.state)).length,
    openWorkAtLeast: items.length >= PREVIEW_ROW_LIMIT,
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
    takenOn(ctx, agent._id, new Set(scopesRevoked)),
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

/**
 * What accepting a handover would bring and leave, for the acceptance dialog
 * ({@link transferPreviewOf}). A request is not a grant of read access (section 4.4).
 *
 * Public, for the account the request names only (`assertNamedInTransfer`); writes nothing.
 *
 * @returns The preview, or null when the request is no longer waiting for an answer.
 * @throws ConvexError with the guard's words for any other caller.
 */
export const transferPreview = query({
  args: { transferId: v.id('managerTransfers') },
  returns: v.union(v.null(), transferPreviewValidator),
  handler: async (ctx, args): Promise<TransferPreview | null> => {
    const { transfer, caller } = await assertNamedInTransfer(ctx, args.transferId);
    if (transfer.state !== 'asked') return null;
    return await transferPreviewOf(ctx, transfer, caller.ownerKey);
  },
});

/** What happened to the employee's live claims at the move. */
interface MovedClaims {
  readonly moved: number;
  readonly released: Id<'externalClaims'>[];
  readonly conflictingKeys: string[];
}

/**
 * Whether the new owner already holds a live claim on any of a claim's names.
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
  for (const key of [claim.key, ...(claim.aliases ?? [])]) {
    const held = await db
      .query('externalClaims')
      .withIndex('by_user_key', (q) => q.eq('userId', toOwnerKey).eq('key', key))
      .filter((q) => q.eq(q.field('releasedAt'), undefined))
      .first();
    if (held !== null) return true;
  }
  return false;
}

/**
 * Decide each live claim of the employee as the retire decides it (the transfer plan, section
 * 6.3): a claim on work that cannot have written anything is released; one on work that may have
 * written moves to the new owner, unless the new owner already holds the item, in which case it
 * is released and the conflict named. The old owner's copy of every written claim is the
 * departure boundary's, not this.
 *
 * @param ctx - The move's mutation context.
 * @param items - Every work item of the employee.
 * @param boundaries - What the departure keeps, with the claims to release.
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
  const toRelease = new Set<string>(boundaries.released);
  let moved = 0;
  const released: Id<'externalClaims'>[] = [];
  const conflictingKeys: string[] = [];
  for (const item of items) {
    const live = await ctx.db
      .query('externalClaims')
      .withIndex('by_work_item', (q) => q.eq('workItemId', item._id))
      .filter((q) => q.eq(q.field('releasedAt'), undefined))
      .collect();
    for (const claim of live) {
      if (toRelease.has(claim._id)) {
        await ctx.db.patch(claim._id, { releasedAt: now });
        released.push(claim._id);
      } else if (await newOwnerHolds(ctx.db, toOwnerKey, claim)) {
        await ctx.db.patch(claim._id, { releasedAt: now });
        conflictingKeys.push(claim.key);
      } else {
        await ctx.db.patch(claim._id, { userId: toOwnerKey });
        moved += 1;
      }
    }
  }
  return { moved, released, conflictingKeys };
}

/**
 * Strip the old owner's credential names from the employee's record: a `credential.superseded`
 * event names the credential and the page the old owner's documentation held it on. The record
 * moves whole (D10); the line stays, saying a credential left the documentation, without naming
 * either.
 *
 * @throws Error when the employee has more such events than one move redacts.
 */
async function redactSupersededCredentials(ctx: MutationCtx, agentId: Id<'agents'>): Promise<void> {
  const events = await eventsOfType(ctx, agentId, 'credential.superseded').take(
    SUPERSEDED_EVENT_LIMIT + 1,
  );
  if (events.length > SUPERSEDED_EVENT_LIMIT) {
    throw new Error(`the employee has more than ${SUPERSEDED_EVENT_LIMIT} superseded credentials`);
  }
  for (const event of events) {
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
 * to the employee's record (the transfer plan, section 7.6).
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

/**
 * Move the employee to the manager who accepted its handover, in one transaction (the transfer
 * plan, sections 6.2, 6.3 and 6.5). In order: the departure boundary is read before anything
 * changes; the connections are cut ({@link cutConnections}); the live claims are moved or
 * released; the old owner's credential names leave the record; the employee row is written for
 * the new owner and the identity file rendered for them; the old owner keeps a departure row in
 * real mode, and their employees a released claim refused are woken; the old mirrors are deleted
 * in pages and the new owner's documentation mirrored; and the request is marked accepted with
 * what the move did, beside one `manager.transferred` event.
 *
 * Work in flight is the next unit's (section 6.4): its steps go between the claims and the owner
 * write, and fill the outcome's counts of requests voided, plans returned, sessions failed, notes
 * discarded, runs stopped and a discarded charter, which are zero here.
 *
 * @param ctx - The acceptance's or the settle's mutation context.
 * @param transfer - The request, with the acceptor's owner key written.
 * @param now - The move's time.
 * @returns What the move did.
 * @throws ConvexError with {@link EMPLOYEE_LEFT_ASKER} when the employee is no longer the asker's;
 *   ConvexError when its boundary is more than one departure row keeps.
 */
async function moveEmployeeInTransaction(
  ctx: MutationCtx,
  transfer: AcceptedTransfer,
  now: number,
): Promise<TransferOutcome> {
  const agent = await departingEmployee(ctx.db, transfer);
  const items = await employeeWorkItems(ctx.db, agent._id);
  const boundaries = await boundariesOf(ctx.db, items, now);
  if (SURFACE_MODE === 'real') assertKeepable(boundaries);

  const cut = await cutConnections(ctx, agent, transfer, now);
  const claims = await moveClaims(ctx, items, boundaries, transfer.toOwnerKey, now);
  await redactSupersededCredentials(ctx, agent._id);
  await settleEmployeeRow(ctx, agent, transfer, now);
  await renderIdentityForManager(ctx, agent._id);
  await leaveDeparture(ctx, agent, transfer, boundaries, cut, now);
  await wakeReleasedClaims(ctx, transfer.fromOwnerKey, claims.released);
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
    claimsReleased: claims.released.length,
    conflictingClaimKeys: claims.conflictingKeys,
    decisionRequestsVoided: 0,
    plansReturned: 0,
    sessionsFailed: 0,
    notesDiscarded: 0,
    // Counted page by page as `pruneDepartedMirrors` deletes them.
    mirroredPagesHidden: 0,
    runsStopped: 0,
    charterDiscarded: false,
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

/**
 * Accept a handover: the employee becomes the caller's, in this transaction, when it has no run
 * in flight (the transfer plan, sections 5.1 and 6).
 *
 * Public, for the account the request names only (`assertNamedInTransfer`, which also refuses
 * the account that asked). The request must be `asked` and unexpired, and the employee still the
 * asker's. `zone` is the acceptor's browser zone, as `deploy` takes it (N12); one the backend
 * does not know reads as the deployment's. `excludedDocSourceIds` are the acceptor's own sources
 * the employee should not read, as the deploy form's ticks. Writes the request's acceptance and
 * the acceptor's choices, then the move (`moveEmployeeInTransaction`).
 *
 * While a run is in flight it refuses, naming the runs: the move waits for them (D18), which is
 * the `accepting` path the next unit adds here in place of the refusal.
 *
 * @returns The employee, now the caller's.
 * @throws ConvexError with words the dialog shows for every refusal.
 */
export const accept = mutation({
  args: {
    transferId: v.id('managerTransfers'),
    zone: v.optional(v.string()),
    excludedDocSourceIds: v.optional(v.array(v.id('docSources'))),
  },
  returns: v.object({ agentId: v.id('agents') }),
  handler: async (ctx, args): Promise<{ agentId: Id<'agents'> }> => {
    const { transfer, caller } = await assertNamedInTransfer(ctx, args.transferId);
    const now = Date.now();
    assertAnswerable(transfer, now);
    const agent = await departingEmployee(ctx.db, transfer);
    const excluded = args.excludedDocSourceIds ?? [];
    await assertOwnSources(ctx.db, caller.ownerKey, excluded);
    const inFlight = await runsInFlight(ctx.db, agent._id);
    if (inFlight > 0) throw new ConvexError(runsInFlightRefusal(agent.name, inFlight));
    const accepted = {
      ...transfer,
      decidedAt: now,
      toOwnerKey: caller.ownerKey,
      toZone: canonicalZone(args.zone) ?? deploymentZone(),
      toExcludedDocSourceIds: excluded,
    };
    await ctx.db.patch(transfer._id, {
      decidedAt: accepted.decidedAt,
      toOwnerKey: accepted.toOwnerKey,
      toZone: accepted.toZone,
      toExcludedDocSourceIds: accepted.toExcludedDocSourceIds,
    });
    await moveEmployeeInTransaction(ctx, accepted, now);
    return { agentId: agent._id };
  },
});

/**
 * Move the employee of an `accepting` request whose runs in flight have ended: the settle's
 * move, with the acceptor's choices kept on the row at acceptance. A request in any other state
 * is left as it is, so a second settle of one request does nothing.
 *
 * Internal; scheduled by the settle (the transfer plan, section 6.4). Writes what
 * `moveEmployeeInTransaction` writes.
 *
 * @returns What the move did, or null when the request was not `accepting`.
 */
export const moveEmployee = internalMutation({
  args: { transferId: v.id('managerTransfers') },
  handler: async (ctx, args): Promise<TransferOutcome | null> => {
    const transfer = await ctx.db.get(args.transferId);
    if (transfer === null || transfer.state !== 'accepting') return null;
    const { toOwnerKey } = transfer;
    if (toOwnerKey === undefined) {
      throw new Error(`accepting handover ${transfer._id} has no acceptor`);
    }
    return await moveEmployeeInTransaction(ctx, { ...transfer, toOwnerKey }, Date.now());
  },
});
