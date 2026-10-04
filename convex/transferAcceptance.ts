import { ConvexError, v, type Infer } from 'convex/values';
import {
  internalAction,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { assertNamedInTransfer } from './ownership';
import { charterAtHandover, discardUnapprovedCharter, renderIdentityForManager } from './charters';
import { appendEvent, eventsOfType } from './eventLog';
import {
  assertKeepable,
  boundariesOf,
  cancelJobsFor,
  employeeWorkItems,
  revokeUnbound,
  wakeReleasedClaims,
  type Boundaries,
} from './reset';
import { closeDeparturesOnReturn } from './retirements';
import { handOverSurfaces, type HandedOverSurfaces } from './surfaces';
import { copyVersionsForMove } from './skillVersions';
import { runsInFlight } from './transferInFlight';
import {
  departingEmployee,
  EMPLOYEE_LEFT_ASKER,
  transferPreviewOf,
  transferPreviewValidator,
  WORK_IS_OPEN,
  type TransferPreview,
} from './transferPreview';
import { endOneToOnesForHandover, oneToOnesAtHandoverRefusal } from './voice';
import { returnApprovalsForHandover, voidDecisionRequestsForHandover } from './work';
import { stopRunsForHandover } from './workRuns';
import {
  HANDOVER_ENDED_CANCEL_REASON,
  HANDOVER_SETTINGS_REASON,
  isTransferDue,
  transferSettleBy,
  transferStateRefusal,
  type ManagerTransferState,
} from '../src/agent/manager-transfer';
import type { TransferEndReason } from '../src/events/contract';
import { log } from '../src/lib/logger';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { canonicalZone, deploymentZone } from '../src/lib/zone';

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

/** The refusal for a documentation source among the unticked that is not the acceptor's own. */
export const SOURCE_NOT_YOURS = 'A documentation source you unticked is not one of yours.';

/** The most `credential.superseded` events of one employee the move redacts. */
const SUPERSEDED_EVENT_LIMIT = 1_000;

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
      payload: { from: true, to: false, reason: HANDOVER_SETTINGS_REASON },
      createdAt: now,
    });
  }
  if (agent.managerNotifications === 'digest') {
    await appendEvent(ctx, {
      agentId: agent._id,
      type: 'agent.notifications-changed',
      payload: { from: 'digest', to: 'per-run', reason: HANDOVER_SETTINGS_REASON },
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
 * Cut the employee's connections (D5 (a)): the surfaces through `handOverSurfaces`, every pending
 * job naming a cut or re-approved surface cancelled, then each credential the cut ones bound
 * sorted by the retire's rule, revoked with its ciphertext deleted when nothing else of the old
 * owner's binds it and kept for them otherwise. What Day0 obtained for a cut card is revoked at
 * the vendor as a Disconnect revokes it (the wave 11 review's M1, decision 2 (a)), its attempt
 * scheduled after the cancel so the cancel never takes it; a card that kept the employee's own
 * identity keeps its credential and calls nothing at the vendor (A25).
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
  await cancelJobsFor(ctx, {
    ids: new Set([...surfaces.cut, ...surfaces.reapproved].map((surface) => surface.surfaceId)),
    employees: new Set([agent._id]),
  });
  const { revoked, kept } = await revokeUnbound(
    ctx,
    transfer.fromOwnerKey,
    [
      {
        agentId: agent._id,
        cards: surfaces.cut.map((surface) => ({
          surfaceId: surface.surfaceId,
          displayName: surface.displayName,
          bound: new Set(surface.boundCredentials),
        })),
      },
    ],
    'transfer',
    now,
    new Set([agent._id]),
  );
  return { surfaces, revoked: revoked.size, kept: kept.size };
}

/**
 * Leave the old owner a departure row (decision D11): the boundary the employee's claims and
 * rejections keep for the old owner's other employees, read by every reader of a retirement
 * unchanged. Real mode only, as a single retire keeps one; mock mode keeps nothing. An employee
 * handed back to an owner it left closes the boundary that owner kept for it
 * (`closeDeparturesOnReturn`, U3-m6).
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
  await closeDeparturesOnReturn(ctx, transfer.toOwnerKey, agent._id);
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
 * (D13), a charter never approved is discarded and the employee returned to `deployed` (D8),
 * its one-to-ones ended (deleted with the employee's return to `deployed`, a session under way
 * failed otherwise), and the notes kept for their digest are set aside. Work in every other
 * state moves as it is.
 */
async function settleWorkInFlight(
  ctx: MutationCtx,
  agent: Doc<'agents'>,
  now: number,
): Promise<SettledWork> {
  const decisionRequestsVoided = await voidDecisionRequestsForHandover(ctx, agent._id, now);
  const plansReturned = await returnApprovalsForHandover(ctx, agent._id, now);
  const charter = await discardUnapprovedCharter(ctx, agent);
  const sessionsFailed = await endOneToOnesForHandover(ctx, agent._id, {
    returnsToDeployed: charter.returnedToDeployed,
  });
  const notesDiscarded = await discardUnsentNotes(ctx, agent._id, now);
  return {
    decisionRequestsVoided,
    plansReturned,
    charterDiscarded: charter.discarded,
    sessionsFailed,
    notesDiscarded,
  };
}

/**
 * Why the move would refuse, read before anything is written: the employee gone or no longer
 * the asker's, a departure boundary larger than one row keeps (real mode), more superseded
 * credentials than one move redacts, or more draft charters or one-to-one sessions than one move
 * ends. The
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
  if (charter.kind === 'refused') return charter.refusal;
  return await oneToOnesAtHandoverRefusal(ctx.db, agent._id);
}

/**
 * Move the employee to the manager who accepted its handover, in one transaction (the transfer
 * plan, sections 6.2 to 6.5). In order: the departure boundary is read before anything changes;
 * the connections are cut ({@link cutConnections}); the skill versions the employee holds are
 * copied into the new owner's library, and its skills on a cut surface are due a re-check
 * (`copyVersionsForMove`, K2); the live claims are moved or released; the
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
  await copyVersionsForMove(ctx, {
    agentId: agent._id,
    toOwnerKey: transfer.toOwnerKey,
    cutSlugs: cut.surfaces.cut.map((surface) => surface.slug),
    now,
  });
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
      const settleBy = transferSettleBy(now);
      await ctx.db.patch(transfer._id, { state: 'accepting', settleBy, ...acceptance });
      // The deadline holds by itself: a paused cron sweep cannot keep a handover waiting (U3-m5).
      await ctx.scheduler.runAt(settleBy, internal.transferAcceptance.attemptSettle, {
        transferId: transfer._id,
      });
      return { agentId: agent._id, state: 'accepting' };
    }
    await ctx.db.patch(transfer._id, acceptance);
    await moveEmployeeInTransaction(ctx, { ...transfer, ...acceptance }, { now, runsStopped: 0 });
    return { agentId: agent._id, state: 'accepted' };
  },
});

/** How an accepted handover that cannot move ends: why, and the words or failure behind it. */
interface HandoverEnding {
  readonly reason: TransferEndReason;
  readonly detail: string;
}

/**
 * End an `accepting` request whose move cannot be made, rather than retry it at every sweep: the
 * employee stays its old manager's, and the request is `cancelled`, the one final state that says
 * so. Its acceptance's stamp is kept as it was written (nothing writes `decidedAt` again), and
 * since the company figures cut only at an accepting or accepted request, the old manager's
 * figures run on unbroken. `TRANSFER_MOVES` (`src/agent/manager-transfer.ts`) keeps `accepting`
 * to `accepted` alone, so no caller can cancel an acceptance (the owner's cancel and the retire
 * both read it); this one write, the settle's own and never a caller's, steps outside the table
 * on purpose. The ending is logged and, while the employee exists, appended to its record as
 * `manager.transfer-ended` (decision 4): the old manager reads there why the handover ended. The
 * request's `cancelReason` is {@link HANDOVER_ENDED_CANCEL_REASON}, which `endedForMe` reads as an
 * ending rather than an ask's cancel; a settle's last failure is counted in `settleFailures` by
 * its caller in the same patch.
 */
async function endUnmovable(
  ctx: MutationCtx,
  transfer: Doc<'managerTransfers'>,
  ending: HandoverEnding,
  settleFailures?: number,
): Promise<void> {
  await ctx.db.patch(transfer._id, {
    state: 'cancelled',
    cancelReason: HANDOVER_ENDED_CANCEL_REASON,
    ...(settleFailures !== undefined ? { settleFailures } : {}),
  });
  log.error('accepted handover could not move; ended', {
    transferId: transfer._id,
    agentId: transfer.agentId,
    reason: ending.reason,
    detail: ending.detail,
  });
  if ((await ctx.db.get(transfer.agentId)) === null) return;
  await appendEvent(ctx, {
    agentId: transfer.agentId,
    type: 'manager.transfer-ended',
    payload: {
      transferId: transfer._id,
      fromAddress: transfer.fromAddress,
      toAddress: transfer.toAddress,
      reason: ending.reason,
      detail: ending.detail,
    },
    createdAt: Date.now(),
  });
}

/**
 * Internal, operator-run only (`npx convex run transferAcceptance:endStuckHandover`, named in the
 * cockpit's redeploy runbook): end an `accepting` request at once. The request ends itself once
 * its settle has failed {@link SETTLE_FAILURES_BEFORE_END} times ({@link recordSettleFailure});
 * this is the operator's verb for the case that should not wait for that (the wave 9 review's M3;
 * decision 4). Ends it exactly as the settle ends an unmovable request ({@link endUnmovable}):
 * the employee stays its old manager's, the request `cancelled`, its stamp kept, and
 * `manager.transfer-ended` with the operator's reason. A request in any other state is left as
 * it is.
 */
export const endStuckHandover = internalMutation({
  args: { transferId: v.id('managerTransfers'), reason: v.string() },
  returns: v.union(v.literal('ended'), v.literal('not-accepting')),
  handler: async (ctx, args): Promise<'ended' | 'not-accepting'> => {
    const transfer = await ctx.db.get(args.transferId);
    if (transfer?.state !== 'accepting') return 'not-accepting';
    await endUnmovable(ctx, transfer, { reason: 'operator', detail: args.reason });
    return 'ended';
  },
});

/** What a settle did with its request. */
const settleOutcomeValidator = v.union(
  v.literal('moved'),
  v.literal('waiting'),
  v.literal('ended'),
  v.literal('not-accepting'),
);

/**
 * Settle a finishing handover in the caller's transaction (the transfer plan, section 6.4; D18):
 * once no run of the employee is executing, or once `settleBy` has passed, the runs that remain
 * are stopped (`stopRunsForHandover`, "the employee was handed over to a new manager") and the
 * employee is moved with the acceptor's choices kept on the row. Before that, it waits. A request
 * no longer `accepting` is left as it is, so a second settle does nothing; one whose move would
 * be refused is ended ({@link endUnmovable}).
 */
async function settleInTransaction(
  ctx: MutationCtx,
  transferId: Id<'managerTransfers'>,
  now: number,
): Promise<Infer<typeof settleOutcomeValidator>> {
  const transfer = await ctx.db.get(transferId);
  if (transfer === null || transfer.state !== 'accepting') return 'not-accepting';
  const { toOwnerKey } = transfer;
  if (toOwnerKey === undefined) {
    await endUnmovable(ctx, transfer, {
      reason: 'unmovable',
      detail: 'the accepted handover names no acceptor',
    });
    return 'ended';
  }
  const refusal = await moveRefusal(ctx, transfer, now);
  if (refusal !== null) {
    await endUnmovable(ctx, transfer, { reason: 'unmovable', detail: refusal });
    return 'ended';
  }
  const due = transfer.settleBy === undefined || transfer.settleBy <= now;
  if (!due && (await runsInFlight(ctx.db, transfer.agentId)) > 0) return 'waiting';
  const runsStopped = await stopRunsForHandover(ctx, transfer.agentId);
  await moveEmployeeInTransaction(ctx, { ...transfer, toOwnerKey }, { now, runsStopped });
  return 'moved';
}

/**
 * Settle a finishing handover ({@link settleInTransaction}).
 *
 * Internal; scheduled by every path out of a run (`convex/transferInFlight.ts`) and by
 * {@link settleDue}. Writes what the stop and the move write.
 *
 * @returns `moved`, `waiting`, `ended`, or `not-accepting`.
 */
export const settle = internalMutation({
  args: { transferId: v.id('managerTransfers') },
  returns: settleOutcomeValidator,
  handler: async (ctx, args): Promise<Infer<typeof settleOutcomeValidator>> =>
    await settleInTransaction(ctx, args.transferId, Date.now()),
});

/**
 * How many settles of one accepting request may fail before it ends itself (decision 4): the
 * deadline's own attempt and the sweep's, one a minute, so within about five minutes of the
 * deadline or of the last run's end.
 */
export const SETTLE_FAILURES_BEFORE_END = 5;

/** The longest failure a settle-failed event keeps, past any refusal's words. */
const SETTLE_FAILURE_CHARS = 500;

/** What one attempt at a settle did: a settle's outcome, or a failure counted toward the end. */
const attemptOutcomeValidator = v.union(settleOutcomeValidator, v.literal('failed'));

/**
 * How many settles of an accepting request have failed: its own count, or, for a request whose
 * failures an older release counted only on the employee's record, the record's.
 */
async function settleFailuresSoFar(
  ctx: MutationCtx,
  transfer: Doc<'managerTransfers'>,
): Promise<number> {
  if (transfer.settleFailures !== undefined) return transfer.settleFailures;
  const earlier = await eventsOfType(ctx, transfer.agentId, 'manager.transfer-settle-failed', {
    from: transfer.decidedAt ?? transfer.requestedAt,
  }).take(SETTLE_FAILURES_BEFORE_END);
  return earlier.filter(
    (event) => (event.payload as { transferId?: unknown }).transferId === transfer._id,
  ).length;
}

/**
 * Count one failed settle of an accepting request, and end the request once
 * {@link SETTLE_FAILURES_BEFORE_END} have failed (decision 4). The count is the request's own
 * `settleFailures`, written in the same patch as each failure's `manager.transfer-settle-failed`
 * event, in a transaction of its own, so it survives the throw that rolled the settle back; a
 * request whose failures an older release counted only on the record starts from that record.
 *
 * Internal, for {@link attemptSettle}. Writes the failure's event, or the ending.
 *
 * @returns `failed` while the request waits for the next sweep, `ended`, or `not-accepting`.
 */
export const recordSettleFailure = internalMutation({
  args: { transferId: v.id('managerTransfers'), reason: v.string() },
  returns: attemptOutcomeValidator,
  handler: async (ctx, args): Promise<Infer<typeof attemptOutcomeValidator>> => {
    const transfer = await ctx.db.get(args.transferId);
    if (transfer === null || transfer.state !== 'accepting') return 'not-accepting';
    const reason = args.reason.slice(0, SETTLE_FAILURE_CHARS);
    if ((await ctx.db.get(transfer.agentId)) === null) {
      await endUnmovable(
        ctx,
        transfer,
        { reason: 'settle-failed', detail: reason },
        (transfer.settleFailures ?? 0) + 1,
      );
      return 'ended';
    }
    const attempt = (await settleFailuresSoFar(ctx, transfer)) + 1;
    if (attempt >= SETTLE_FAILURES_BEFORE_END) {
      await endUnmovable(ctx, transfer, { reason: 'settle-failed', detail: reason }, attempt);
      return 'ended';
    }
    await ctx.db.patch(transfer._id, { settleFailures: attempt });
    await appendEvent(ctx, {
      agentId: transfer.agentId,
      type: 'manager.transfer-settle-failed',
      payload: {
        transferId: transfer._id,
        fromAddress: transfer.fromAddress,
        toAddress: transfer.toAddress,
        attempt,
        reason,
      },
      createdAt: Date.now(),
    });
    return 'failed';
  },
});

/**
 * What the record says of a failed settle that is not a refusal: the server's own message (a
 * request id, a function path) is for the operator's log, not the manager's record.
 */
export const SETTLE_FAILED_ON_THE_SERVER = 'the move failed on the server';

/**
 * The words a failed settle carries on the record: a refusal's own, or
 * {@link SETTLE_FAILED_ON_THE_SERVER} for any other failure.
 *
 * @param error - What the settle threw.
 */
export function settleFailureReason(error: unknown): string {
  if (error instanceof ConvexError && typeof error.data === 'string') return error.data;
  return SETTLE_FAILED_ON_THE_SERVER;
}

/**
 * One attempt at a settle ({@link settle}), whose failure is counted rather than lost: a settle
 * that throws rolls its own transaction back, so the count is written in a transaction of its
 * own ({@link recordSettleFailure}), and the request ends itself after
 * {@link SETTLE_FAILURES_BEFORE_END}.
 *
 * Internal; scheduled by the acceptance at the deadline and by {@link settleDue}. Writes what the
 * settle or the count writes.
 *
 * @returns The settle's outcome, or `failed` / `ended` for a settle that threw.
 */
export const attemptSettle = internalAction({
  args: { transferId: v.id('managerTransfers') },
  returns: attemptOutcomeValidator,
  handler: async (ctx, args): Promise<Infer<typeof attemptOutcomeValidator>> => {
    let failure: unknown;
    try {
      return await ctx.runMutation(internal.transferAcceptance.settle, args);
    } catch (error) {
      failure = error;
    }
    const reason = settleFailureReason(failure);
    log.warn('handover settle failed; counted toward its end', {
      transferId: args.transferId,
      reason,
      error: failure instanceof Error ? failure.message : String(failure),
    });
    return await ctx.runMutation(internal.transferAcceptance.recordSettleFailure, {
      transferId: args.transferId,
      reason,
    });
  },
});

/** The most finishing requests one sweep reads, the soonest deadline first. */
const SETTLE_SWEEP_LIMIT = 50;

/**
 * The finishing requests a sweep settles: each past its `settleBy`, and each whose runs have all
 * ended. Read soonest deadline first, so a request past its deadline is never behind one that is
 * not; the second case is the backstop for a run that ended while the settle it asked for could
 * not run (a crons pause holds the sweep, not the settle), so a request whose runs are over waits
 * at most until the sweep reaches it, and never past its own deadline.
 */
async function finishingToSettle(
  db: QueryCtx['db'],
  now: number,
): Promise<Doc<'managerTransfers'>[]> {
  const finishing = await db
    .query('managerTransfers')
    .withIndex('by_state_settle', (q) => q.eq('state', 'accepting'))
    .take(SETTLE_SWEEP_LIMIT);
  const settling = await Promise.all(
    finishing.map(
      async (transfer) =>
        transfer.settleBy === undefined ||
        transfer.settleBy <= now ||
        (await runsInFlight(db, transfer.agentId)) === 0,
    ),
  );
  return finishing.filter((_, index) => settling[index]);
}

/**
 * The settle's sweep (the cron's, every minute): each request {@link finishingToSettle} finds is
 * settled in a transaction of its own, through {@link attemptSettle}, so a failure counts toward
 * the request's end.
 *
 * Internal; the cron's. Writes nothing itself; schedules {@link attemptSettle}.
 *
 * @returns How many settles were scheduled.
 */
export const settleDue = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx): Promise<{ scheduled: number }> => {
    const finishing = await finishingToSettle(ctx.db, Date.now());
    for (const transfer of finishing) {
      await ctx.scheduler.runAfter(0, internal.transferAcceptance.attemptSettle, {
        transferId: transfer._id,
      });
    }
    return { scheduled: finishing.length };
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
  // A string, not an id: the dialog reads it from the address, and the guard reads one that names
  // no request as not found rather than letting the validator's text reach the dialog (U4-m1).
  args: { transferId: v.string() },
  returns: v.union(v.null(), transferPreviewValidator),
  handler: async (ctx, args): Promise<TransferPreview | null> => {
    const { transfer, caller } = await assertNamedInTransfer(ctx, args.transferId);
    if (transfer.state !== 'asked' || transfer.expiresAt <= Date.now()) return null;
    return await transferPreviewOf(ctx, transfer, caller.ownerKey);
  },
});
