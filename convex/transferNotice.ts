import { v, type Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import { appendEvent } from './eventLog';
import { isTransferDue } from '../src/agent/manager-transfer';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { surfaceRefusal } from '../src/surfaces/policy';
import { toSurfaceRecord } from '../src/surfaces/records';
import { channelAllowlist } from '../src/surfaces/slack-own-channel';
import { isSlackApiEndpoint } from '../src/surfaces/slack-endpoint';
import { autonomousActionsOn } from '../src/work/autonomy';
import { accessEnded } from '../src/work/surface-access';
import { slackEscaped } from '../src/surfaces/slack-markup';

/*
 * The one DM notice a real-mode handover request sends the named person (decision D7; the
 * transfer plan, section 5.2): which card can carry it under the manager's standing authority,
 * its words, and its claim and record, which `managerChannelActions.sendTransferNotice` calls
 * around the send. The ask (`convex/managerTransfers.ts`) schedules it.
 */

/** The Slack methods the notice needs on its card's allowlist: who the bot is, who the address is, the DM and the post. */
const NOTICE_SLACK_METHODS = [
  'auth.test',
  'users.lookupByEmail',
  'conversations.open',
  'chat.postMessage',
] as const;

/** Bound on an employee's surfaces read for the one the notice goes through. */
const NOTICE_SURFACE_READ_LIMIT = 50;

/** Bound on an employee's grants read for the notice's authority, past any one employee's. */
const NOTICE_GRANT_READ_LIMIT = 500;

/** Why no notice was sent: the employee has no Slack card at all (m10). */
export const NOTICE_WITHOUT_SLACK = 'the employee has no Slack card to send it from';

/** Why no notice was sent: the Slack card's credential is not landed, or its access has ended. */
export const NOTICE_CARD_NOT_CONNECTED = "the employee's Slack card is not connected";

/** Why no notice was sent: the card's approved tools lack a method the notice calls. */
export const NOTICE_CARD_NOT_APPROVED =
  "the employee's Slack card is not approved to look up an address and send a direct message";

/** Why no notice was sent: the manager's authority does not cover reading Slack. */
export const NOTICE_WITHOUT_READ =
  'the employee may not read Slack, so it cannot find the named manager there';

/**
 * Why no notice was sent: the manager's authority does not cover a message to someone else
 * without an approval (no write grant, autonomous actions off or the write scope revoked); the
 * notice is never held for one. The real-Linear walk's Juno (m10).
 */
export const NOTICE_WITHOUT_WRITE = 'the employee may not message anyone in Slack without approval';

/** The card the notice goes through, or why none can carry it. */
export type NoticeCarrier =
  | { readonly kind: 'carried'; readonly surface: Doc<'surfaces'> }
  | { readonly kind: 'withheld'; readonly reason: string };

/**
 * The surface the D7 notice goes through, or why the employee has none: a connected Slack card on
 * the documented API, its credential landed, its access not ended, whose allowlist names every
 * method the notice calls, under the manager's standing authority to read and write on it. Slack
 * is the one provider whose card resolves an address to a person (`users.lookupByEmail`), so
 * another chat surface carries no notice. The reason is the first of those the employee's Slack
 * cards all fail, in that order.
 */
export async function noticeCarrierOf(
  ctx: QueryCtx,
  agent: Doc<'agents'>,
  now: number,
): Promise<NoticeCarrier> {
  const [surfaces, grants] = await Promise.all([
    ctx.db
      .query('surfaces')
      .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
      .take(NOTICE_SURFACE_READ_LIMIT),
    ctx.db
      .query('permissionGrants')
      .withIndex('by_agent_scope', (q) => q.eq('agentId', agent._id))
      .take(NOTICE_GRANT_READ_LIMIT),
  ]);
  const active = new Set(grants.filter((grant) => !grant.revokedAt).map((grant) => grant.scope));
  const revoked = new Set(
    grants.filter((grant) => grant.revokedAt !== undefined).map((grant) => grant.scope),
  );
  const slack = surfaces.filter(
    (surface) =>
      surface.class === 'chat' &&
      surface.path === 'documented-api' &&
      isSlackApiEndpoint(surface.endpoint),
  );
  if (slack.length === 0) return withheld(NOTICE_WITHOUT_SLACK);
  const connected = slack.filter(
    (surface) =>
      surface.credentialLanded &&
      surface.credentialId !== undefined &&
      !accessEnded(surface, now) &&
      surfaceRefusal(toSurfaceRecord(surface), now) === undefined,
  );
  if (connected.length === 0) return withheld(NOTICE_CARD_NOT_CONNECTED);
  // Day0's own notice: on an app Day0 created its channel's methods are allowed whatever the page
  // names (13-FS's design 1 (b)); a shared token's page must name every one.
  const approved = connected.filter((surface) => {
    const allowed = channelAllowlist(toSurfaceRecord(surface));
    return NOTICE_SLACK_METHODS.every((method) => allowed.includes(method));
  });
  if (approved.length === 0) return withheld(NOTICE_CARD_NOT_APPROVED);
  const readable = approved.filter((surface) => active.has(`${surface.slug}:read`));
  if (readable.length === 0) return withheld(NOTICE_WITHOUT_READ);
  const surface = readable.find((card) =>
    mayWriteUnasked(card.slug, active, revoked, autonomousActionsOn(agent)),
  );
  return surface === undefined ? withheld(NOTICE_WITHOUT_WRITE) : { kind: 'carried', surface };
}

/** No card carries the notice, for this reason. */
function withheld(reason: string): NoticeCarrier {
  return { kind: 'withheld', reason };
}

/**
 * Whether the manager's standing authority covers the notice's DM on a card, by the gate's own
 * rule (`grantRefusal`, `src/surfaces/policy.ts`): a DM to a person who is not the manager is a
 * write, which needs the write scope, or autonomous actions with that scope never revoked since.
 * The address lookup is a read, which needs the read scope whatever else is true; the caller
 * asks that first.
 */
function mayWriteUnasked(
  slug: string,
  active: ReadonlySet<string>,
  revoked: ReadonlySet<string>,
  autonomous: boolean,
): boolean {
  const write = `${slug}:write`;
  return active.has(write) || (autonomous && !revoked.has(write));
}

/**
 * The D7 notice, in the named person's words (the transfer plan, section
 * 5.2): who asks, for whom, where to answer, and that nothing changes until
 * they do. It links to the request on the home, where the inbox entry opens
 * the same dialog, and carries no decision code, so no reply to it is read as
 * one. What a manager typed is escaped, so a name cannot become a mention.
 *
 * @param input - The request, the employee's name, who asks, and the app's public origin when the deployment has one.
 */
export function transferNoticeText(input: {
  readonly transferId: string;
  readonly employeeName: string;
  readonly fromAddress: string;
  readonly publicUrl?: string;
}): string {
  const name = slackEscaped(input.employeeName);
  const origin = input.publicUrl?.trim().replace(/\/+$/, '');
  const where = origin
    ? `Day0: ${origin}/?transfer=${encodeURIComponent(input.transferId)}`
    : 'Day0';
  return `${name}'s manager, ${slackEscaped(input.fromAddress)}, has asked you to take ${name} on. Accept or decline in ${where}. Nothing changes until you do.`;
}

/** Why the notice reached nobody: the address names no person the bot may DM. */
export const NOTICE_TO_NOBODY = 'the named address is no person in the workspace';

/** Why the notice reached nobody: the address is the manager the card already DMs (U2-m8). */
export const NOTICE_TO_THE_MANAGER =
  "the named address is the employee's own manager in this workspace";

/**
 * Why the notice reached nobody: the address is a guest's, a single- or multi-channel member
 * from outside the company, who is not someone a handover is for (U2-m8).
 */
export const NOTICE_TO_A_GUEST = 'the named address is a guest in the workspace';

/** What the notice action sends through, once claimed. */
const claimedNoticeValidator = v.union(
  v.object({ claimed: v.literal(false), reason: v.string() }),
  v.object({
    claimed: v.literal(true),
    credentialId: v.string(),
    toAddress: v.string(),
    /** The Slack member the card DMs as the manager, never the person to tell. */
    managerUserId: v.optional(v.string()),
    text: v.string(),
  }),
);

/**
 * Internal, for `managerChannelActions.sendTransferNotice`: claim the one D7
 * notice of an asked request, once. Refused when the request is no longer
 * asked, its employee is gone or no longer the asker's, the notice was already
 * claimed, or the deployment is in mock mode. Writes `noticeSentAt` at the
 * claim, so a failed send is never tried again (D7: once, never re-sent); when
 * the employee has lost, since the ask, the Slack card that could carry it
 * under the manager's authority, the claim is refused with why, and that
 * reason goes on the employee's record (`manager.transfer-notice`; m10).
 */
export const claimTransferNotice = internalMutation({
  args: { transferId: v.id('managerTransfers') },
  returns: claimedNoticeValidator,
  handler: async (ctx, args): Promise<Infer<typeof claimedNoticeValidator>> => {
    if (SURFACE_MODE !== 'real') {
      return { claimed: false, reason: 'the notice is sent in real mode only' };
    }
    const transfer = await ctx.db.get(args.transferId);
    if (!transfer) return { claimed: false, reason: 'the handover no longer exists' };
    const now = Date.now();
    if (transfer.state !== 'asked' || isTransferDue(transfer, now)) {
      return { claimed: false, reason: 'the handover is no longer waiting for an answer' };
    }
    if (transfer.noticeSentAt !== undefined) {
      return { claimed: false, reason: 'the notice was already sent' };
    }
    const agent = await ctx.db.get(transfer.agentId);
    if (!agent || agent.userId !== transfer.fromOwnerKey) {
      return { claimed: false, reason: "the employee is no longer the asking manager's" };
    }
    const carrier = await noticeCarrierOf(ctx, agent, now);
    const surface = carrier.kind === 'carried' ? carrier.surface : undefined;
    // The card the ask found can be lost before this claim: the notice is claimed all the same,
    // so it is never tried again, and the record says why it went to nobody (m10).
    await ctx.db.patch(transfer._id, { noticeSentAt: now });
    if (surface?.credentialId === undefined) {
      const reason = carrier.kind === 'withheld' ? carrier.reason : NOTICE_CARD_NOT_CONNECTED;
      await recordNoticeOutcome(ctx, transfer, { delivered: false, reason });
      return { claimed: false, reason };
    }
    return {
      claimed: true,
      credentialId: surface.credentialId,
      toAddress: transfer.toAddress,
      ...(surface.managerUserId === undefined ? {} : { managerUserId: surface.managerUserId }),
      text: transferNoticeText({
        transferId: transfer._id,
        // The name as the ask stored it, clipped to a name's bound (the wave 9 review's B2).
        employeeName: transfer.agentName,
        fromAddress: transfer.fromAddress,
        publicUrl: process.env.DAY0_PUBLIC_URL,
      }),
    };
  },
});

/**
 * Append the notice's outcome to the employee's record, once per claimed notice (U2-m8), or once
 * at the ask when no card could carry it (m10). An employee retired since has no record left, and
 * an event written for it would be a row no reset reaches (U2-m6), so the request alone says it.
 */
export async function recordNoticeOutcome(
  ctx: MutationCtx,
  transfer: Pick<Doc<'managerTransfers'>, '_id' | 'agentId' | 'fromAddress' | 'toAddress'>,
  outcome: { readonly delivered: true } | { readonly delivered: false; readonly reason: string },
): Promise<void> {
  if ((await ctx.db.get(transfer.agentId)) === null) return;
  await appendEvent(ctx, {
    agentId: transfer.agentId,
    type: 'manager.transfer-notice',
    payload: {
      transferId: transfer._id,
      fromAddress: transfer.fromAddress,
      toAddress: transfer.toAddress,
      ...outcome,
    },
    createdAt: Date.now(),
  });
}

/**
 * Internal, for `managerChannelActions.sendTransferNotice`: the provider's timestamp of the
 * delivered notice, and `manager.transfer-notice` on the employee's record.
 */
export const recordTransferNotice = internalMutation({
  args: { transferId: v.id('managerTransfers'), providerTs: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const transfer = await ctx.db.get(args.transferId);
    if (!transfer) return null;
    await ctx.db.patch(args.transferId, { noticeProviderTs: args.providerTs });
    await recordNoticeOutcome(ctx, transfer, { delivered: true });
    return null;
  },
});

/**
 * Internal, for `managerChannelActions.sendTransferNotice`: a claimed notice that reached nobody
 * or failed, with why, as `manager.transfer-notice` on the employee's record. It is not tried
 * again (D7).
 */
export const recordTransferNoticeUndelivered = internalMutation({
  args: { transferId: v.id('managerTransfers'), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const transfer = await ctx.db.get(args.transferId);
    if (!transfer) return null;
    await recordNoticeOutcome(ctx, transfer, { delivered: false, reason: args.reason });
    return null;
  },
});
