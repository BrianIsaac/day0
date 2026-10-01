import { v, type Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation, type QueryCtx } from './_generated/server';
import { isTransferDue } from '../src/agent/manager-transfer';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { surfaceRefusal } from '../src/surfaces/policy';
import { toSurfaceRecord } from '../src/surfaces/records';
import { isSlackApiEndpoint } from '../src/surfaces/slack-endpoint';
import { autonomousActionsOn } from '../src/work/autonomy';
import { accessEnded } from '../src/work/surface-access';

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

/**
 * The surface the D7 notice goes through, if the employee has one: a connected
 * Slack card on the documented API, its credential landed, its access not
 * ended, whose allowlist names every method the notice calls, under the
 * manager's standing authority to read and write on it. Slack is the one
 * provider whose card resolves an address to a person (`users.lookupByEmail`),
 * so another chat surface carries no notice.
 */
export async function noticeSurfaceOf(
  ctx: QueryCtx,
  agent: Doc<'agents'>,
  now: number,
): Promise<Doc<'surfaces'> | undefined> {
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
  return surfaces.find(
    (surface) =>
      noticeAuthorised(surface.slug, active, revoked, autonomousActionsOn(agent)) &&
      surface.class === 'chat' &&
      surface.credentialLanded &&
      surface.credentialId !== undefined &&
      surface.path === 'documented-api' &&
      isSlackApiEndpoint(surface.endpoint) &&
      NOTICE_SLACK_METHODS.every((method) => surface.toolAllowlist?.includes(method)) &&
      !accessEnded(surface, now) &&
      surfaceRefusal(toSurfaceRecord(surface), now) === undefined,
  );
}

/**
 * Whether the manager's standing authority covers the notice on a card, by
 * the gate's own rule for each call (`grantRefusal`, `src/surfaces/policy.ts`):
 * the address lookup is a read, which needs its read scope whatever else is
 * true; the DM to a person who is not the manager is a write, which needs the
 * write scope, or autonomous actions with that scope never revoked since.
 */
function noticeAuthorised(
  slug: string,
  active: ReadonlySet<string>,
  revoked: ReadonlySet<string>,
  autonomous: boolean,
): boolean {
  const write = `${slug}:write`;
  if (!active.has(`${slug}:read`)) return false;
  return active.has(write) || (autonomous && !revoked.has(write));
}

/** The three characters Slack reads as markup in a message's text, escaped as Slack asks. */
function slackEscaped(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

/** What the notice action sends through, once claimed. */
const claimedNoticeValidator = v.union(
  v.object({ claimed: v.literal(false), reason: v.string() }),
  v.object({
    claimed: v.literal(true),
    credentialId: v.string(),
    toAddress: v.string(),
    text: v.string(),
  }),
);

/**
 * Internal, for `managerChannelActions.sendTransferNotice`: claim the one D7
 * notice of an asked request, once. Refused when the request is no longer
 * asked, its employee is gone or no longer the asker's, the notice was already
 * claimed, the deployment is in mock mode, or the employee has no Slack card
 * that can carry it under the manager's authority. Writes
 * `noticeSentAt` at the claim, so a failed send is never tried again (D7: once,
 * never re-sent).
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
    const surface = await noticeSurfaceOf(ctx, agent, now);
    if (surface?.credentialId === undefined) {
      return { claimed: false, reason: 'the employee has no chat connection that can carry it' };
    }
    await ctx.db.patch(transfer._id, { noticeSentAt: now });
    return {
      claimed: true,
      credentialId: surface.credentialId,
      toAddress: transfer.toAddress,
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

/** Internal, for `managerChannelActions.sendTransferNotice`: the provider's timestamp of the delivered notice. */
export const recordTransferNotice = internalMutation({
  args: { transferId: v.id('managerTransfers'), providerTs: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    if (!(await ctx.db.get(args.transferId))) return null;
    await ctx.db.patch(args.transferId, { noticeProviderTs: args.providerTs });
    return null;
  },
});
