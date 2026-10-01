import { ConvexError, v, type Infer } from 'convex/values';
import type { UserIdentity } from 'convex/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { appendEvent } from './eventLog';
import { runsInFlight } from './transferInFlight';
import { noticeSurfaceOf } from './transferNotice';
import { isEvaluationAgent } from './metrics';
import {
  assertNamedInTransfer,
  assertOwnsAgent,
  getCaller,
  getCallerOrThrow,
  verifiedAddressOf,
  type Caller,
} from './ownership';
import {
  isEvaluationShapedAddress,
  MANAGER_ADDRESS_REFUSAL,
  normaliseManagerAddress,
} from '../src/agent/manager-address';
import {
  addressBoundRefusal,
  canMoveTransfer,
  DECLINE_REASON_TOO_LONG,
  EVALUATION_ADDRESS_TRANSFER_REFUSAL,
  EVALUATION_EMPLOYEE_TRANSFER_REFUSAL,
  isTransferDue,
  LOCAL_DEV_TRANSFER_REFUSAL,
  MANAGER_TRANSFER_STATES,
  type ManagerTransferState,
  MAX_DECLINE_REASON_LENGTH,
  MAX_OPEN_TRANSFERS_PER_ADDRESS,
  MAX_OPEN_TRANSFERS_PER_OWNER,
  MAX_TRANSFER_ASKS_PER_WINDOW,
  MAX_TRANSFER_NOTE_LENGTH,
  NOTE_TOO_LONG,
  OPEN_MANAGER_TRANSFER_STATES,
  openTransferRefusal,
  ownAddressRefusal,
  OWNER_DAILY_BOUND_REFUSAL,
  OWNER_OPEN_BOUND_REFUSAL,
  sameAddressRefusal,
  TRANSFER_ASK_WINDOW_MS,
  TRANSFER_DEPARTURES_WINDOW_MS,
  TRANSFER_EXPIRY_MS,
  TRANSFER_NOT_FOUND,
  type TransferCancelReason,
  transferExpiresAt,
  transferStateRefusal,
  UNVERIFIED_FOR_ASK,
} from '../src/agent/manager-transfer';
import { DEV_NO_AUTH_ISSUER } from '../src/lib/dev-auth-issuer';
import { log } from '../src/lib/logger';
import { resolveDeploymentProfile, SURFACE_MODE } from '../src/lib/surface-mode';
import { agentZone } from '../src/lib/zone';
import { ownerKnownValues, scrubKnownValues } from '../src/redaction/known-values';
import { redactTokenShapes } from '../src/surfaces/redact';
import { clippedEmployeeName } from '../src/agent/employee-name';
import { characterCount, withoutInvisibles } from '../src/lib/visible-text';

/*
 * A request to hand an employee to another manager, from the ask to its
 * answer (the transfer plan, sections 4 and 5; wave 9 unit 9-U2). Nothing
 * about the employee changes while a request is `asked`: the old manager keeps
 * every decision until the named manager accepts (`convex/transferAcceptance.ts`).
 * Every refusal a manager can meet is a `ConvexError` whose data is the words
 * the dialog shows (standard 6.3). Every string here is a wording draft and a
 * product call, flagged in the unit's handover.
 */

/** Bound on the requests one read of an index range returns, past every count bound it serves. */
const TRANSFER_READ_LIMIT = 50;

/** The most requests one expiry sweep expires before it schedules the next page. */
const EXPIRY_PAGE_SIZE = 100;

/** The most requests the named account's inbox reads. */
const INCOMING_READ_LIMIT = 50;

/** The most finished requests the old manager's notices list. */
const DEPARTURES_LIMIT = 50;

/** A request as the old manager's People card and header read it while it is open. */
const openTransferValidator = v.object({
  transferId: v.id('managerTransfers'),
  agentId: v.id('agents'),
  toAddress: v.string(),
  note: v.optional(v.string()),
  state: v.union(...OPEN_MANAGER_TRANSFER_STATES.map((state) => v.literal(state))),
  requestedAt: v.number(),
  expiresAt: v.number(),
  /** While `accepting`: when the runs in flight are stopped at the latest. */
  settleBy: v.optional(v.number()),
});

/** An open request as the account it names reads it, for the inbox and the acceptance dialog. */
const incomingTransferValidator = v.object({
  transferId: v.id('managerTransfers'),
  agentId: v.id('agents'),
  employeeName: v.string(),
  /** The employee's zone (N12), as every inbox entry carries it. */
  zone: v.string(),
  fromAddress: v.string(),
  note: v.optional(v.string()),
  requestedAt: v.number(),
  expiresAt: v.number(),
});

/** An accepted request on its way to the caller, for the acceptor's line on the home. */
const arrivingTransferValidator = v.object({
  transferId: v.id('managerTransfers'),
  agentId: v.id('agents'),
  agentName: v.string(),
  fromAddress: v.string(),
  /** When the runs in flight are stopped at the latest. */
  settleBy: v.optional(v.number()),
  /** The runs the move waits for, counted as the move counts them. */
  runsInFlight: v.number(),
});

/** The states a finished request reaches that the old manager is told about. */
const DEPARTURE_STATES = ['accepted', 'declined', 'expired'] as const;

/** A finished request as the old manager's notices read it. */
const departureValidator = v.object({
  transferId: v.id('managerTransfers'),
  agentId: v.id('agents'),
  agentName: v.string(),
  toAddress: v.string(),
  state: v.union(...DEPARTURE_STATES.map((state) => v.literal(state))),
  decidedAt: v.number(),
  declineReason: v.optional(v.string()),
});

/** Where a departed employee went, as its old manager's link to it reads it. */
const departureOfValidator = v.union(
  v.null(),
  v.object({
    transferId: v.id('managerTransfers'),
    agentName: v.string(),
    toAddress: v.string(),
    decidedAt: v.number(),
  }),
);

/** An open request as the old manager reads it. */
export type OpenTransfer = Infer<typeof openTransferValidator>;

/** An open request as the account it names reads it. */
export type IncomingTransfer = Infer<typeof incomingTransferValidator>;

/** An issuer URL compared the way two spellings of one issuer should compare. */
function issuerKey(issuer: string): string {
  return issuer.trim().replace(/\/+$/, '');
}

/**
 * Whether no second account can exist on this deployment for this caller: it
 * signed in through the local issuer, which signs every browser in as one
 * subject, and the profile is `local-dev`. Under `customer-local` the local
 * account is one more manager beside the customer's issuer (the transfer
 * plan, section 8), and a Clerk caller on the hosted demo, whose profile is
 * unset, is its own account.
 */
function signedInAsTheOneLocalManager(identity: UserIdentity): boolean {
  return (
    issuerKey(identity.issuer) === issuerKey(DEV_NO_AUTH_ISSUER) &&
    resolveDeploymentProfile() === 'local-dev'
  );
}

/** Whether a request is open now: asked and not yet past its expiry, or accepting. */
function isOpenNow(transfer: Doc<'managerTransfers'>, now: number): boolean {
  if (transfer.state === 'accepting') return true;
  return transfer.state === 'asked' && !isTransferDue(transfer, now);
}

/** The state a request reads as now: an asked one past its expiry is expired, whether or not the sweep has written it. */
function stateNow(transfer: Doc<'managerTransfers'>, now: number): ManagerTransferState {
  return isTransferDue(transfer, now) ? 'expired' : transfer.state;
}

/** The event fields every event of a request carries. */
function requestEventOf(transfer: Doc<'managerTransfers'>): {
  readonly transferId: Id<'managerTransfers'>;
  readonly fromAddress: string;
  readonly toAddress: string;
} {
  return {
    transferId: transfer._id,
    fromAddress: transfer.fromAddress,
    toAddress: transfer.toAddress,
  };
}

/**
 * The requests in one state for one index key, bounded. A count bound reads
 * one past itself at most, so `TRANSFER_READ_LIMIT` covers every bound.
 */
async function requestsInState(
  ctx: QueryCtx,
  by:
    | { readonly agentId: Id<'agents'> }
    | { readonly fromOwnerKey: string }
    | { readonly toAddress: string },
  state: ManagerTransferState,
  createdSince?: number,
): Promise<Doc<'managerTransfers'>[]> {
  if ('agentId' in by) {
    return await ctx.db
      .query('managerTransfers')
      .withIndex('by_agent_state', (q) => q.eq('agentId', by.agentId).eq('state', state))
      .order('desc')
      .take(TRANSFER_READ_LIMIT);
  }
  if ('fromOwnerKey' in by) {
    return await ctx.db
      .query('managerTransfers')
      .withIndex('by_from_owner_state', (q) => {
        const keyed = q.eq('fromOwnerKey', by.fromOwnerKey).eq('state', state);
        return createdSince === undefined ? keyed : keyed.gte('_creationTime', createdSince);
      })
      .order('desc')
      .take(TRANSFER_READ_LIMIT);
  }
  return await ctx.db
    .query('managerTransfers')
    .withIndex('by_to_address_state', (q) => q.eq('toAddress', by.toAddress).eq('state', state))
    .order('desc')
    .take(TRANSFER_READ_LIMIT);
}

/** The open requests for one index key, a request past its expiry left out. */
async function openRequests(
  ctx: QueryCtx,
  by:
    | { readonly agentId: Id<'agents'> }
    | { readonly fromOwnerKey: string }
    | { readonly toAddress: string },
  now: number,
): Promise<Doc<'managerTransfers'>[]> {
  const perState = await Promise.all(
    OPEN_MANAGER_TRANSFER_STATES.map(async (state) => await requestsInState(ctx, by, state)),
  );
  return perState.flat().filter((transfer) => isOpenNow(transfer, now));
}

/**
 * End an asked request past its expiry, as the sweep does: `expired`, dated
 * at its expiry, and the event on the employee's record, written now. An
 * employee retired since has no record left, and an event written for it
 * would be a row no reset reaches (U2-m6), so the request alone says it.
 */
async function expireInTransaction(
  ctx: MutationCtx,
  transfer: Doc<'managerTransfers'>,
  now: number,
): Promise<void> {
  // It left `asked` at its expiry, whenever the sweep or an ask meets it.
  await ctx.db.patch(transfer._id, { state: 'expired', decidedAt: transfer.expiresAt });
  if ((await ctx.db.get(transfer.agentId)) === null) return;
  await appendEvent(ctx, {
    agentId: transfer.agentId,
    type: 'manager.transfer-expired',
    payload: requestEventOf(transfer),
    createdAt: now,
  });
}

/**
 * Refuse a move the request's state does not allow (`canMoveTransfer`), an
 * asked request past its expiry reading as expired, in the words of the state
 * it reads as now.
 *
 * @throws ConvexError with {@link transferStateRefusal}.
 */
function assertCanMove(
  transfer: Doc<'managerTransfers'>,
  to: ManagerTransferState,
  now: number,
): void {
  const state = stateNow(transfer, now);
  if (!canMoveTransfer(state, to)) throw new ConvexError(transferStateRefusal(state));
}

/**
 * Cancel an asked request in the caller's transaction, with its reason and
 * the event on the employee's record. The one cancel every path shares: the
 * owner's cancel, a change of address, and the employee's retire
 * (`convex/reset.ts`, reason `retired`).
 *
 * @param ctx - The mutation's context.
 * @param transfer - The request, read in this transaction.
 * @param reason - Why it ends.
 * @param now - When.
 * @throws ConvexError with {@link transferStateRefusal} when it is no longer asked, or past its expiry.
 */
export async function cancelTransferInTransaction(
  ctx: MutationCtx,
  transfer: Doc<'managerTransfers'>,
  reason: TransferCancelReason,
  now: number,
): Promise<void> {
  assertCanMove(transfer, 'cancelled', now);
  await ctx.db.patch(transfer._id, { state: 'cancelled', decidedAt: now, cancelReason: reason });
  await appendEvent(ctx, {
    agentId: transfer.agentId,
    type: 'manager.transfer-cancelled',
    payload: { ...requestEventOf(transfer), reason },
    createdAt: now,
  });
}

/**
 * The note as it is stored: trimmed, empty as none, bounded, and with every
 * recognisable secret shape replaced (the synchronous floor; real mode adds the
 * owner-wide exact layer after the ask, {@link scrubNote}).
 *
 * @throws ConvexError with {@link NOTE_TOO_LONG}.
 */
function storedNote(note: string | undefined): string | undefined {
  const stored = storedText(note);
  if (stored !== undefined && characterCount(stored) > MAX_TRANSFER_NOTE_LENGTH) {
    throw new ConvexError(NOTE_TOO_LONG);
  }
  return stored;
}

/**
 * A note or a reason as it is stored, before its bound is checked: invisible characters removed,
 * trimmed, empty as none, every recognisable secret shape replaced. The bound is measured on this
 * text, by character, so what is stored is what was measured (a redacted password is longer than
 * the password).
 */
function storedText(text: string | undefined): string | undefined {
  const visible = text === undefined ? '' : withoutInvisibles(text).trim();
  return visible === '' ? undefined : redactTokenShapes(visible);
}

/**
 * The named address, normalised, once it is shaped like an address, is not
 * reserved for evaluations and is not the caller's own.
 *
 * @throws ConvexError with the words of the first rule it breaks.
 */
function namedAddress(input: string, fromAddress: string, employeeName: string): string {
  const toAddress = normaliseManagerAddress(input);
  if (toAddress === undefined) throw new ConvexError(MANAGER_ADDRESS_REFUSAL);
  if (isEvaluationShapedAddress(toAddress)) {
    throw new ConvexError(EVALUATION_ADDRESS_TRANSFER_REFUSAL);
  }
  if (toAddress === fromAddress) throw new ConvexError(ownAddressRefusal(employeeName));
  return toAddress;
}

/**
 * Hold an ask to the bounds of D16 (the transfer plan, section 10.3): open
 * requests per owner, asks per owner in a rolling day (every request asked,
 * whatever became of it), and open requests per address from all owners.
 *
 * @throws ConvexError with the bound's words.
 */
async function assertWithinBounds(
  ctx: QueryCtx,
  ownerKey: string,
  toAddress: string,
  now: number,
): Promise<void> {
  const [ownerOpen, askedToday, addressOpen] = await Promise.all([
    openRequests(ctx, { fromOwnerKey: ownerKey }, now),
    Promise.all(
      MANAGER_TRANSFER_STATES.map(
        async (state) =>
          await requestsInState(
            ctx,
            { fromOwnerKey: ownerKey },
            state,
            now - TRANSFER_ASK_WINDOW_MS + 1,
          ),
      ),
    ),
    openRequests(ctx, { toAddress }, now),
  ]);
  if (ownerOpen.length >= MAX_OPEN_TRANSFERS_PER_OWNER) {
    throw new ConvexError(OWNER_OPEN_BOUND_REFUSAL);
  }
  if (askedToday.flat().length >= MAX_TRANSFER_ASKS_PER_WINDOW) {
    throw new ConvexError(OWNER_DAILY_BOUND_REFUSAL);
  }
  if (addressOpen.length >= MAX_OPEN_TRANSFERS_PER_ADDRESS) {
    throw new ConvexError(addressBoundRefusal(toAddress));
  }
}

/** What an ask writes from: who asks, for which employee, to whom, with what note, when. */
interface AskInput {
  readonly caller: Caller;
  readonly agent: Doc<'agents'>;
  readonly toAddress: string;
  readonly note: string | undefined;
  readonly now: number;
}

/**
 * Ask in the caller's transaction, after every refusal and bound: the row, its
 * event, and in real mode the owner-wide scrub of the note and the D7 notice.
 * An asked request of the employee's that is past its expiry is expired here
 * first, so it neither holds the one-open rule nor counts toward a bound.
 *
 * @returns The new request's id.
 * @throws ConvexError with the words of the first refusal or bound it meets.
 */
async function askInTransaction(
  ctx: MutationCtx,
  input: AskInput,
): Promise<Id<'managerTransfers'>> {
  const { caller, agent, now } = input;
  if (signedInAsTheOneLocalManager(caller)) throw new ConvexError(LOCAL_DEV_TRANSFER_REFUSAL);
  if (isEvaluationAgent(agent)) throw new ConvexError(EVALUATION_EMPLOYEE_TRANSFER_REFUSAL);
  const fromAddress = verifiedAddressOf(caller);
  if (fromAddress === undefined) throw new ConvexError(UNVERIFIED_FOR_ASK);
  // A name stored before the deploy bounded it is clipped here: the request copies it into the
  // named account's inbox, which another account's long names must not fill.
  const agentName = clippedEmployeeName(agent.name);
  const toAddress = namedAddress(input.toAddress, fromAddress, agentName);
  const note = storedNote(input.note);

  for (const transfer of await requestsInState(ctx, { agentId: agent._id }, 'asked')) {
    if (isTransferDue(transfer, now)) await expireInTransaction(ctx, transfer, now);
  }
  const [open] = await openRequests(ctx, { agentId: agent._id }, now);
  if (open) {
    throw new ConvexError(
      openTransferRefusal(
        agentName,
        open.toAddress,
        open.state === 'accepting' ? 'accepting' : 'asked',
      ),
    );
  }
  await assertWithinBounds(ctx, caller.ownerKey, toAddress, now);

  const transferId = await ctx.db.insert('managerTransfers', {
    agentId: agent._id,
    agentName,
    fromOwnerKey: caller.ownerKey,
    fromAddress,
    toAddress,
    ...(note !== undefined ? { note } : {}),
    state: 'asked',
    requestedAt: now,
    expiresAt: transferExpiresAt(now),
  });
  await appendEvent(ctx, {
    agentId: agent._id,
    type: 'manager.transfer-asked',
    payload: { transferId, fromAddress, toAddress, hasNote: note !== undefined },
    createdAt: now,
  });
  if (SURFACE_MODE === 'real') {
    if (note !== undefined) {
      await ctx.scheduler.runAfter(0, internal.managerTransfers.scrubNote, { transferId });
    }
    if ((await noticeSurfaceOf(ctx, agent, now)) !== undefined) {
      await ctx.scheduler.runAfter(0, internal.managerChannelActions.sendTransferNotice, {
        transferId,
      });
    }
  }
  return transferId;
}

/**
 * The request, if the caller asked it: the old manager's own. Another
 * account's request reads as one that does not exist, so its existence is not
 * told to a caller it does not concern.
 *
 * @throws ConvexError with {@link TRANSFER_NOT_FOUND}.
 */
async function ownRequest(
  ctx: QueryCtx,
  caller: Caller,
  transferId: Id<'managerTransfers'>,
): Promise<Doc<'managerTransfers'>> {
  const transfer = await ctx.db.get(transferId);
  if (!transfer || transfer.fromOwnerKey !== caller.ownerKey) {
    throw new ConvexError(TRANSFER_NOT_FOUND);
  }
  return transfer;
}

/**
 * Public, owner-guarded (`assertOwnsAgent`): ask the manager signed in with
 * `toAddress` to take the employee on (the transfer plan, section 4.3).
 * Nothing about the employee changes until they accept (section 4.4). Refused
 * on an installation that signs everyone in as one manager, for an evaluation
 * employee, without a verified address of the caller's, for a malformed,
 * evaluation-shaped or own address, while the employee has a request open, and
 * past the bounds of D16, each with the words the dialog shows.
 *
 * Writes the `asked` row and `manager.transfer-asked`; in real mode schedules
 * the owner-wide scrub of the note and, when the employee has a Slack card
 * that can carry it, the one DM notice to the named person (D7).
 *
 * @returns The new request's id.
 */
export const ask = mutation({
  args: { agentId: v.id('agents'), toAddress: v.string(), note: v.optional(v.string()) },
  returns: v.id('managerTransfers'),
  handler: async (ctx, args): Promise<Id<'managerTransfers'>> => {
    const caller = await getCallerOrThrow(ctx);
    const agent = await assertOwnsAgent(ctx, args.agentId);
    return await askInTransaction(ctx, {
      caller,
      agent,
      toAddress: args.toAddress,
      note: args.note,
      now: Date.now(),
    });
  },
});

/**
 * Public, for the old manager only (the account that asked, while it still
 * owns the employee): cancel an asked request. Writes `cancelled` with reason
 * `owner` and `manager.transfer-cancelled`; the entry leaves the named
 * account's inbox.
 *
 * @throws ConvexError with {@link TRANSFER_NOT_FOUND} for another account's request, or the
 *   state's words once it is no longer asked.
 */
export const cancel = mutation({
  args: { transferId: v.id('managerTransfers') },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const caller = await getCallerOrThrow(ctx);
    const transfer = await ownRequest(ctx, caller, args.transferId);
    const now = Date.now();
    assertCanMove(transfer, 'cancelled', now);
    await assertOwnsAgent(ctx, transfer.agentId);
    await cancelTransferInTransaction(ctx, transfer, 'owner', now);
    return null;
  },
});

/**
 * Public, for the old manager only: name another address. Cancels the asked
 * request (`address-changed`) and asks again in one transaction, so the
 * one-open rule has no gap to race through; the new request is held to every
 * rule and bound an ask is, and counts as an ask. An omitted note keeps the
 * request's note; an empty one removes it.
 *
 * @returns The new request's id.
 * @throws ConvexError with {@link TRANSFER_NOT_FOUND}, the state's words, {@link sameAddressRefusal},
 *   or any refusal of {@link ask}; a refusal leaves the old request as it was.
 */
export const changeAddress = mutation({
  args: {
    transferId: v.id('managerTransfers'),
    toAddress: v.string(),
    note: v.optional(v.string()),
  },
  returns: v.id('managerTransfers'),
  handler: async (ctx, args): Promise<Id<'managerTransfers'>> => {
    const caller = await getCallerOrThrow(ctx);
    const transfer = await ownRequest(ctx, caller, args.transferId);
    const now = Date.now();
    assertCanMove(transfer, 'cancelled', now);
    const agent = await assertOwnsAgent(ctx, transfer.agentId);
    if (normaliseManagerAddress(args.toAddress) === transfer.toAddress) {
      throw new ConvexError(sameAddressRefusal(transfer.toAddress));
    }
    await cancelTransferInTransaction(ctx, transfer, 'address-changed', now);
    return await askInTransaction(ctx, {
      caller,
      agent,
      toAddress: args.toAddress,
      note: args.note ?? transfer.note,
      now,
    });
  },
});

/**
 * Public, for the named account only (`assertNamedInTransfer`): decline an
 * asked request, with an optional reason for the old manager. Writes
 * `declined`, the bounded reason and `manager.transfer-declined`. Nothing about
 * the employee changes.
 *
 * @throws ConvexError with the guard's words, the state's words once it is no longer asked,
 *   or {@link DECLINE_REASON_TOO_LONG}.
 */
export const decline = mutation({
  args: { transferId: v.id('managerTransfers'), reason: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { transfer } = await assertNamedInTransfer(ctx, args.transferId);
    const now = Date.now();
    assertCanMove(transfer, 'declined', now);
    const declineReason = storedText(args.reason);
    if (declineReason !== undefined && characterCount(declineReason) > MAX_DECLINE_REASON_LENGTH) {
      throw new ConvexError(DECLINE_REASON_TOO_LONG);
    }
    await ctx.db.patch(transfer._id, {
      state: 'declined',
      decidedAt: now,
      ...(declineReason !== undefined ? { declineReason } : {}),
    });
    await appendEvent(ctx, {
      agentId: transfer.agentId,
      type: 'manager.transfer-declined',
      payload: { ...requestEventOf(transfer), hasReason: declineReason !== undefined },
      createdAt: now,
    });
    return null;
  },
});

/**
 * Internal, from the quarter-hourly cron through `runScheduledJob`: expire
 * every asked request past its expiry (D4, 14 days), paged over
 * `by_state_expires`, and schedule the next page when this one was full. An
 * accepting request is past its answer and never expires. Writes `expired` and
 * `manager.transfer-expired` for each; nothing is sent to anybody.
 *
 * @returns How many it expired in this page.
 */
export const expireDue = internalMutation({
  args: {},
  returns: v.object({ expired: v.number() }),
  handler: async (ctx): Promise<{ expired: number }> => {
    const now = Date.now();
    const due = await ctx.db
      .query('managerTransfers')
      .withIndex('by_state_expires', (q) => q.eq('state', 'asked').lte('expiresAt', now))
      .take(EXPIRY_PAGE_SIZE);
    for (const transfer of due) await expireInTransaction(ctx, transfer, now);
    if (due.length === EXPIRY_PAGE_SIZE) {
      await ctx.scheduler.runAfter(0, internal.managerTransfers.expireDue, {});
    }
    return { expired: due.length };
  },
});

/**
 * Public, owner-guarded (`assertOwnsAgent`): the employee's open request, or
 * null, for the People card and the header. An asked request past its expiry
 * is not open, whether or not the sweep has written it. Writes nothing.
 */
export const openForAgent = query({
  args: { agentId: v.id('agents') },
  returns: v.union(v.null(), openTransferValidator),
  handler: async (ctx, args): Promise<OpenTransfer | null> => {
    await assertOwnsAgent(ctx, args.agentId);
    const [open] = await openRequests(ctx, { agentId: args.agentId }, Date.now());
    if (!open) return null;
    return {
      transferId: open._id,
      agentId: open.agentId,
      toAddress: open.toAddress,
      ...(open.note !== undefined ? { note: open.note } : {}),
      state: open.state === 'accepting' ? 'accepting' : 'asked',
      requestedAt: open.requestedAt,
      expiresAt: open.expiresAt,
      ...(open.settleBy !== undefined ? { settleBy: open.settleBy } : {}),
    };
  },
});

/**
 * The asked requests that name the caller's verified address, oldest first,
 * each with the employee's name and zone: the reader `incoming` answers with
 * and `work.needsYou` merges into the inbox as its ninth kind (the transfer
 * plan, section 5.1). A caller with no verified address is named by nothing;
 * a request the caller asked itself, a request past its expiry and one whose
 * employee is gone are left out. Reads the named address's rows and their
 * employees only; writes nothing.
 *
 * @param ctx - A query's context.
 * @param caller - The signed-in caller.
 * @param now - The instant expiry is judged against.
 */
export async function incomingTransfersOf(
  ctx: QueryCtx,
  caller: Caller,
  now: number,
): Promise<IncomingTransfer[]> {
  const address = verifiedAddressOf(caller);
  if (address === undefined) return [];
  const asked = await ctx.db
    .query('managerTransfers')
    .withIndex('by_to_address_state', (q) => q.eq('toAddress', address).eq('state', 'asked'))
    .take(INCOMING_READ_LIMIT);
  const named = asked.filter(
    (transfer) => transfer.fromOwnerKey !== caller.ownerKey && !isTransferDue(transfer, now),
  );
  const employees = await Promise.all(
    named.map(async (transfer) => await ctx.db.get(transfer.agentId)),
  );
  return named
    .flatMap((transfer, index): IncomingTransfer[] => {
      const employee = employees[index];
      if (!employee) return [];
      return [
        {
          transferId: transfer._id,
          agentId: transfer.agentId,
          employeeName: clippedEmployeeName(employee.name),
          zone: agentZone(employee),
          fromAddress: transfer.fromAddress,
          ...(transfer.note !== undefined ? { note: transfer.note } : {}),
          requestedAt: transfer.requestedAt,
          expiresAt: transfer.expiresAt,
        },
      ];
    })
    .sort((left, right) => left.requestedAt - right.requestedAt);
}

/**
 * Public, by verified address: the asked requests naming the caller, oldest
 * first, for the inbox and the acceptance dialog; what the employee brings is
 * `transferAcceptance.transferPreview`'s. An anonymous caller, or one without a
 * verified address, is named by none. Writes nothing.
 */
export const incoming = query({
  args: {},
  returns: v.array(incomingTransferValidator),
  handler: async (ctx): Promise<IncomingTransfer[]> => {
    const caller = await getCaller(ctx);
    if (!caller) return [];
    return await incomingTransfersOf(ctx, caller, Date.now());
  },
});

/**
 * Public, by verified address and owner key: the requests the caller accepted that still wait
 * for the employee's runs (`accepting`), each with the runs the move waits for, so the home says
 * an employee is on its way until it arrives, across reloads (the transfer plan, section 4.2:
 * `accepting` "is shown to both managers as accepted, handing over"). An anonymous caller, or
 * one without a verified address, has none. Writes nothing.
 */
export const arriving = query({
  args: {},
  returns: v.array(arrivingTransferValidator),
  handler: async (ctx): Promise<Infer<typeof arrivingTransferValidator>[]> => {
    const caller = await getCaller(ctx);
    const address = caller ? verifiedAddressOf(caller) : undefined;
    if (!caller || address === undefined) return [];
    // An accepting request is open, so the per-address bound bounds this read too.
    const accepting = await ctx.db
      .query('managerTransfers')
      .withIndex('by_to_address_state', (q) => q.eq('toAddress', address).eq('state', 'accepting'))
      .take(MAX_OPEN_TRANSFERS_PER_ADDRESS);
    const accepted = accepting.filter((transfer) => transfer.toOwnerKey === caller.ownerKey);
    return await Promise.all(
      accepted.map(async (transfer) => ({
        transferId: transfer._id,
        agentId: transfer.agentId,
        agentName: transfer.agentName,
        fromAddress: transfer.fromAddress,
        ...(transfer.settleBy !== undefined ? { settleBy: transfer.settleBy } : {}),
        runsInFlight: await runsInFlight(ctx.db, transfer.agentId),
      })),
    );
  },
});

/**
 * Public, for the account that asked: its requests that ended accepted,
 * declined or expired in the last 30 days, newest answer first, for the old
 * manager's notices (the transfer plan, section 7.4) and the People card's
 * last answer (section 7.1). An asked request past its expiry reads as
 * expired at its expiry. An anonymous caller has none. Writes nothing.
 */
export const departures = query({
  args: {},
  returns: v.array(departureValidator),
  handler: async (ctx): Promise<Infer<typeof departureValidator>[]> => {
    const caller = await getCaller(ctx);
    if (!caller) return [];
    const now = Date.now();
    const since = now - TRANSFER_DEPARTURES_WINDOW_MS;
    // A request is answered at most its expiry after it was asked.
    const createdSince = since - TRANSFER_EXPIRY_MS;
    const perState = await Promise.all(
      (['asked', ...DEPARTURE_STATES] as const).map(
        async (state) =>
          await requestsInState(ctx, { fromOwnerKey: caller.ownerKey }, state, createdSince),
      ),
    );
    return perState
      .flat()
      .flatMap((transfer): Infer<typeof departureValidator>[] => {
        const state = stateNow(transfer, now);
        if (state !== 'accepted' && state !== 'declined' && state !== 'expired') return [];
        const decidedAt =
          transfer.state === 'asked'
            ? transfer.expiresAt
            : (transfer.decidedAt ?? transfer.expiresAt);
        if (decidedAt < since) return [];
        return [
          {
            transferId: transfer._id,
            agentId: transfer.agentId,
            agentName: transfer.agentName,
            toAddress: transfer.toAddress,
            state,
            decidedAt,
            ...(transfer.declineReason !== undefined
              ? { declineReason: transfer.declineReason }
              : {}),
          },
        ];
      })
      .sort((left, right) => right.decidedAt - left.decidedAt)
      .slice(0, DEPARTURES_LIMIT);
  },
});

/**
 * Public, for the account that asked: where an employee it handed over went,
 * for the old link to its page, which the account no longer owns (the
 * transfer plan, section 7.4). Answers only the caller's own accepted
 * requests, the newest; null for an anonymous caller or an employee it never
 * handed over. Writes nothing.
 */
export const departureOf = query({
  args: { agentId: v.id('agents') },
  returns: departureOfValidator,
  handler: async (ctx, args): Promise<Infer<typeof departureOfValidator>> => {
    const caller = await getCaller(ctx);
    if (!caller) return null;
    const accepted = await requestsInState(ctx, { agentId: args.agentId }, 'accepted');
    const own = accepted.find((transfer) => transfer.fromOwnerKey === caller.ownerKey);
    if (!own) return null;
    return {
      transferId: own._id,
      agentName: own.agentName,
      toAddress: own.toAddress,
      decidedAt: own.decidedAt ?? own.requestedAt,
    };
  },
});

/** Internal, for {@link scrubNote}: the stored note and whose credentials it is scrubbed against. */
export const noteOf = internalQuery({
  args: { transferId: v.id('managerTransfers') },
  returns: v.union(v.null(), v.object({ note: v.string(), fromOwnerKey: v.string() })),
  handler: async (ctx, args): Promise<{ note: string; fromOwnerKey: string } | null> => {
    const transfer = await ctx.db.get(args.transferId);
    if (transfer?.note === undefined) return null;
    return { note: transfer.note, fromOwnerKey: transfer.fromOwnerKey };
  },
});

/**
 * Internal, for {@link scrubNote}: replace the stored note with its scrubbed
 * form, or withhold it, but only while it is still the note that was scrubbed.
 */
export const replaceNote = internalMutation({
  args: {
    transferId: v.id('managerTransfers'),
    scrubbedFrom: v.string(),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const transfer = await ctx.db.get(args.transferId);
    if (transfer?.note !== args.scrubbedFrom) return null;
    await ctx.db.patch(args.transferId, { note: args.note });
    return null;
  },
});

/**
 * Internal, scheduled by a real-mode ask with a note: the owner-wide exact
 * layer over the stored note (the transfer plan, section 4.1), which needs the
 * owner's credential values and so cannot run in the ask's transaction. Reads
 * the note from the row, never from its arguments, so nothing it scrubs is
 * scheduled. Fails closed: when the values cannot be read, the note is
 * withheld rather than kept unchecked.
 */
export const scrubNote = internalAction({
  args: { transferId: v.id('managerTransfers') },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const stored = await ctx.runQuery(internal.managerTransfers.noteOf, args);
    if (stored === null) return null;
    try {
      const scrubbed = scrubKnownValues(
        stored.note,
        await ownerKnownValues(ctx, stored.fromOwnerKey),
      );
      if (scrubbed !== stored.note) {
        await ctx.runMutation(internal.managerTransfers.replaceNote, {
          transferId: args.transferId,
          scrubbedFrom: stored.note,
          note: scrubbed,
        });
      }
    } catch (error) {
      log.warn('handover note withheld: the owner-wide exact layer could not be applied', {
        transferId: args.transferId,
        reason: error instanceof Error ? error.message : String(error),
      });
      await ctx.runMutation(internal.managerTransfers.replaceNote, {
        transferId: args.transferId,
        scrubbedFrom: stored.note,
      });
    }
    return null;
  },
});
