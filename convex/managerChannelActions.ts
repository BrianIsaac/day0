'use node';

import { randomBytes } from 'node:crypto';
import { v, type Infer } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { internalAction, type ActionCtx } from './_generated/server';
import { NOTICE_TO_A_GUEST, NOTICE_TO_NOBODY, NOTICE_TO_THE_MANAGER } from './transferNotice';
import { decryptCredential } from '../src/surfaces/credentials';
import { createMastraMcpClient } from '../src/surfaces/mcp';
import {
  grantRefusal,
  isAutomatic,
  NOT_AUTOMATIC,
  parseSurfaceAction,
  pathRefusal,
  surfaceRefusal,
  toolRefusal,
  UNKNOWN_SURFACE,
  type RequestEdit,
} from '../src/surfaces/policy';
import { applySurfaceActions } from '../src/surfaces/registry';
import { isSlackApiEndpoint, slackApiUrl } from '../src/surfaces/slack-endpoint';
import { safeFailureMessage } from '../src/surfaces/redact';
import type { BeforeSurfaceTransport, SurfaceRecord } from '../src/surfaces/types';
import {
  batchRequestLines,
  decisionIdFromBytes,
  decisionRequestText,
  managerMessageAction,
  managerMessageUpdateAction,
  type DecisionKind,
} from '../src/work/manager-channel';
import type { MockAction } from '../src/work/types';
import { log } from '../src/lib/logger';

function sameAuthority(left: SurfaceRecord, right: SurfaceRecord): boolean {
  return (
    JSON.stringify({
      slug: left.slug,
      verdict: left.verdict,
      credentialLanded: left.credentialLanded,
      lastVerifiedAt: left.lastVerifiedAt,
      path: left.path,
      endpoint: left.endpoint,
      toolAllowlist: left.toolAllowlist,
      toolArguments: left.toolArguments,
      credentialId: left.credentialId,
      managerDmChannelId: left.managerDmChannelId,
      managerUserId: left.managerUserId,
    }) ===
    JSON.stringify({
      slug: right.slug,
      verdict: right.verdict,
      credentialLanded: right.credentialLanded,
      lastVerifiedAt: right.lastVerifiedAt,
      path: right.path,
      endpoint: right.endpoint,
      toolAllowlist: right.toolAllowlist,
      toolArguments: right.toolArguments,
      credentialId: right.credentialId,
      managerDmChannelId: right.managerDmChannelId,
      managerUserId: right.managerUserId,
    })
  );
}

interface ManagerDelivery {
  agentId: Id<'agents'>;
  agentName: string;
  requestRunId: Id<'events'>;
  surface: SurfaceRecord;
  surfaces: SurfaceRecord[];
  grants: string[];
}

/**
 * Deliver one message to the manager DM through the gate.
 *
 * @param options - The decision request it sends, when it is one, which the
 *   gate checks is still current; and the request it answers, whose thread it
 *   goes in.
 */
async function deliverManagerMessage(
  ctx: ActionCtx,
  workItemId: Id<'workItems'>,
  delivery: ManagerDelivery,
  text: string,
  options: { readonly decisionId?: string; readonly threadTs?: string } = {},
) {
  const { decisionId, threadTs } = options;
  return await applyManagerAction(
    ctx,
    workItemId,
    delivery,
    managerMessageAction(delivery.surface, text, threadTs ? { threadTs } : {}),
    decisionId ? { decisionId } : {},
  );
}

/**
 * Apply one manager-DM action through the gate, as Day0's own message on the
 * delivery's run.
 *
 * @throws Error with the gate's or the provider's reason when it did not land.
 */
async function applyManagerAction(
  ctx: ActionCtx,
  workItemId: Id<'workItems'>,
  delivery: ManagerDelivery,
  action: MockAction,
  options: { readonly decisionId?: string; readonly requestEdit?: RequestEdit } = {},
) {
  const { decisionId, requestEdit } = options;
  const applied = await applySurfaceActions(
    ctx,
    'real',
    delivery.surfaces,
    {
      agentId: delivery.agentId,
      agentName: delivery.agentName,
      workItemId,
      runId: delivery.requestRunId,
    },
    [action],
    {
      deps: {
        decrypt: decryptCredential,
        createMcpClient: createMastraMcpClient,
        browserMcpUrl: process.env.DAY0_BROWSER_MCP_URL,
        fetch: (input: URL, init: RequestInit): Promise<Response> => fetch(input, init),
        beforeTransport: beforeManagerTransport(ctx, delivery.agentId, workItemId, decisionId),
      },
      grants: new Set(delivery.grants),
      approvedIndexes: new Set([0]),
      autoPhase: true,
      autonomousActions: false,
      ...(requestEdit ? { requestEdit } : {}),
    },
  );
  const result = applied[0];
  if (!result?.ok) throw new Error(result?.reason ?? 'manager message did not land');
  return result;
}

/** Re-read boss:message authority at the last boundary before a decision DM. */
function beforeManagerTransport(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
  workItemId: Id<'workItems'>,
  decisionId?: string,
): BeforeSurfaceTransport {
  return async (action, claimedSurface): Promise<string | undefined> => {
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok) return parsed.reason;
    const authority = await ctx.runQuery(internal.work.transportAuthority, {
      agentId,
      surfaceSlug: parsed.action.surface,
    });
    if (decisionId) {
      const item = await ctx.runQuery(internal.work.getInternal, { workItemId });
      const decision = item?.decision;
      const pendingState = decision?.kind === 'plan' ? 'plan-pending' : 'actions-pending';
      if (
        !decision ||
        decision.id !== decisionId ||
        decision.decidedAt ||
        decision.requestFailedAt ||
        decision.ts ||
        item?.state !== pendingState
      )
        return 'decision request is no longer current';
    }
    if (!authority.agentExists) return 'agent not found';
    const surface = authority.surface;
    if (!surface) return UNKNOWN_SURFACE;
    if (authority.accessEnded) return authority.accessEnded;
    if (!sameAuthority(surface, claimedSurface))
      return 'surface authority changed before transport';
    const refusal =
      surfaceRefusal(surface, Date.now()) ??
      pathRefusal(parsed.action, surface) ??
      toolRefusal(parsed.action, surface);
    if (refusal) return refusal;
    if (!isAutomatic(parsed.action, surface, false)) return NOT_AUTOMATIC;
    return grantRefusal(parsed.action, surface, new Set(authority.grants), false);
  };
}

/** Post the one decision request claimed by `work.prepareDecisionRequest`. */
export const requestDecision = internalAction({
  args: {
    workItemId: v.id('workItems'),
    kind: v.union(v.literal('plan'), v.literal('actions')),
    /** The undelivered request this send replaces, when it is a resend. */
    supersedes: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ sent: boolean; reason?: string }> => {
    const decisionId = decisionIdFromBytes(randomBytes(32));
    const prepared = await ctx.runMutation(internal.work.prepareDecisionRequest, {
      workItemId: args.workItemId,
      kind: args.kind,
      decisionId,
      supersedes: args.supersedes,
    });
    if (!prepared.prepared) return { sent: false, reason: prepared.reason };

    let text = decisionRequestText({
      agentName: prepared.agentName,
      title: prepared.title,
      id: prepared.decisionId,
      kind: args.kind as DecisionKind,
      plan: prepared.plan,
      ...(prepared.draftedWithout ? { draftedWithout: prepared.draftedWithout } : {}),
      actions: ((prepared.output ?? {}) as { actions?: MockAction[] }).actions,
      heldIndexes: prepared.heldIndexes,
      refused: prepared.refused,
      item: prepared.item,
      surfaces: prepared.surfaces,
      closingPhase: ((prepared.output ?? {}) as { phase?: unknown }).phase === 'dependent',
      slackMarkup:
        prepared.surface.path === 'documented-api' && isSlackApiEndpoint(prepared.surface.endpoint),
    });
    // Other held action sets are already waiting on this channel: offer one
    // code that decides them all, each named with its own.
    if (
      args.kind === 'actions' &&
      prepared.openActionDecisions.length > 0 &&
      prepared.pendingRunId
    ) {
      const batchId = decisionIdFromBytes(randomBytes(32));
      const members = [
        {
          workItemId: args.workItemId,
          decisionId: prepared.decisionId,
          pendingRunId: prepared.pendingRunId,
          title: prepared.title,
        },
        ...prepared.openActionDecisions,
      ];
      const batch = await ctx.runMutation(internal.work.prepareDecisionBatch, {
        agentId: prepared.agentId,
        batchId,
        surfaceSlug: prepared.surface.slug,
        channel: prepared.surface.managerDmChannelId ?? '',
        members: members.map(({ workItemId, decisionId, pendingRunId }) => ({
          workItemId,
          decisionId,
          pendingRunId,
        })),
      });
      if (batch.prepared) {
        text = [text, ...batchRequestLines({ id: batchId, members })].join('\n');
      }
    }
    try {
      const result = await deliverManagerMessage(ctx, args.workItemId, prepared, text, {
        decisionId: prepared.decisionId,
      });
      await ctx.runMutation(internal.work.recordDecisionRequest, {
        workItemId: args.workItemId,
        decisionId: prepared.decisionId,
        ts: result.providerId,
        text,
      });
      return { sent: true };
    } catch (error) {
      const reason = safeFailureMessage(error, '', 'Manager decision request failed.');
      await ctx.runMutation(internal.work.recordDecisionRequest, {
        workItemId: args.workItemId,
        decisionId: prepared.decisionId,
        failure: reason,
      });
      return { sent: false, reason };
    }
  },
});

/**
 * Mark a decided request so in its own message in the manager DM, once, by
 * editing it to end with how it was decided (M finding 3). Internal; the
 * decide paths schedule it. A card that does not allow `chat.update` leaves
 * the request as it was sent; a failed edit is logged and not tried again,
 * since the decision itself already stands.
 */
export const closeDecisionRequest = internalAction({
  args: { workItemId: v.id('workItems'), decisionId: v.string() },
  handler: async (ctx, args): Promise<{ closed: boolean }> => {
    const prepared = await ctx.runMutation(internal.work.prepareRequestClose, args);
    if (!prepared.prepared) return { closed: false };
    const action = managerMessageUpdateAction(prepared.surface, prepared.ts, prepared.text);
    if (!action) return { closed: false };
    try {
      await applyManagerAction(ctx, args.workItemId, prepared, action, {
        requestEdit: { channel: prepared.channel, ts: prepared.ts },
      });
      return { closed: true };
    } catch (error) {
      log.warn('the decided request could not be marked in the manager DM; the decision stands', {
        workItemId: args.workItemId,
        decisionId: args.decisionId,
        reason: safeFailureMessage(error, '', 'the edit did not land'),
      });
      return { closed: false };
    }
  },
});

/** Send the sole acknowledgement claimed for a late or duplicate reply. */
export const sendDecisionNotice = internalAction({
  args: { workItemId: v.id('workItems'), decisionId: v.string() },
  handler: async (ctx, args): Promise<{ sent: boolean; reason?: string }> => {
    const prepared = await ctx.runMutation(internal.work.prepareDecisionNotice, args);
    if (!prepared.prepared) return { sent: false, reason: 'notice already claimed' };
    try {
      const result = await deliverManagerMessage(ctx, args.workItemId, prepared, prepared.text, {
        threadTs: prepared.threadTs,
      });
      await ctx.runMutation(internal.work.recordDecisionNotice, {
        ...args,
        ts: result.providerId,
      });
      return { sent: true };
    } catch (error) {
      const reason = safeFailureMessage(error, '', 'Decision notice failed.');
      await ctx.runMutation(internal.work.recordDecisionNotice, { ...args, failure: reason });
      return { sent: false, reason };
    }
  },
});

/** Send the sole acknowledgement claimed for one parsed manager reply. */
export const sendManagerReplyNotice = internalAction({
  args: { noticeId: v.id('managerDecisionNotices') },
  handler: async (ctx, args): Promise<{ sent: boolean; reason?: string }> => {
    const prepared = await ctx.runMutation(internal.work.prepareManagerReplyNotice, args);
    if (!prepared.prepared) return { sent: false, reason: 'notice already claimed' };
    try {
      const result = await deliverManagerMessage(
        ctx,
        prepared.workItemId,
        prepared,
        prepared.text,
        { threadTs: prepared.threadTs },
      );
      await ctx.runMutation(internal.work.recordManagerReplyNotice, {
        ...args,
        providerTs: result.providerId,
      });
      return { sent: true };
    } catch (error) {
      const reason = safeFailureMessage(error, '', 'Decision acknowledgement failed.');
      await ctx.runMutation(internal.work.recordManagerReplyNotice, { ...args, failure: reason });
      return { sent: false, reason };
    }
  },
});

/** Send one per-run note the gate kept for the manager. */
export const sendManagerNote = internalAction({
  args: { noteId: v.id('managerNotes') },
  handler: async (ctx, args): Promise<{ sent: boolean; reason?: string }> => {
    const prepared = await ctx.runMutation(internal.work.prepareManagerNote, args);
    if (!prepared.prepared) return { sent: false, reason: 'note already claimed' };
    try {
      const result = await deliverManagerMessage(ctx, prepared.workItemId, prepared, prepared.text);
      await ctx.runMutation(internal.work.recordManagerNote, { ...args, ts: result.providerId });
      return { sent: true };
    } catch (error) {
      const reason = safeFailureMessage(error, '', 'Manager note failed.');
      await ctx.runMutation(internal.work.recordManagerNote, { ...args, failure: reason });
      return { sent: false, reason };
    }
  },
});

/** Send every agent's kept notes as one digest; the cron's hourly job. */
export const sendManagerDigests = internalAction({
  args: {},
  handler: async (ctx): Promise<{ sent: number; failed: number }> => {
    const agents: Id<'agents'>[] = [];
    let cursor: string | null = null;
    do {
      const page: { agentIds: Id<'agents'>[]; cursor: string | null } = await ctx.runQuery(
        internal.work.digestCandidates,
        { cursor },
      );
      agents.push(...page.agentIds);
      cursor = page.cursor;
    } while (cursor !== null);
    let sent = 0;
    let failed = 0;
    for (const agentId of agents) {
      const prepared = await ctx.runMutation(internal.work.prepareManagerDigest, { agentId });
      if (!prepared.prepared) continue;
      try {
        const result = await deliverManagerMessage(
          ctx,
          prepared.workItemId,
          prepared,
          prepared.text,
        );
        await ctx.runMutation(internal.work.recordManagerDigest, {
          agentId,
          noteIds: prepared.noteIds,
          ts: result.providerId,
        });
        sent += 1;
      } catch (error) {
        await ctx.runMutation(internal.work.recordManagerDigest, {
          agentId,
          noteIds: prepared.noteIds,
          failure: safeFailureMessage(error, '', 'Manager digest failed.'),
        });
        failed += 1;
      }
    }
    return { sent, failed };
  },
});

/** How long one Slack call of the notice may take before it is abandoned. */
const NOTICE_SLACK_TIMEOUT_MS = 30_000;

/** One Slack call of the notice: a read sends its values as the query, a write as a JSON body. */
type NoticeSlackCall =
  | { readonly query: Readonly<Record<string, string>> }
  | { readonly body: Readonly<Record<string, string>> };

/**
 * Call one Slack Web API method for the transfer notice and hold it to Slack's
 * in-band success contract, in the shapes the card's probe calls them. The
 * notice is Day0's own message to a person who is not the employee's manager,
 * so it does not go through the work gate, whose automatic path is the
 * manager DM; it calls only methods the card's allowlist names
 * (`claimTransferNotice` checks them).
 *
 * @throws Error with the method and Slack's error, or the HTTP status.
 */
async function callSlackForNotice(
  credential: string,
  method: string,
  call: NoticeSlackCall,
): Promise<Record<string, unknown>> {
  const url = slackApiUrl(method);
  if ('query' in call) {
    for (const [name, value] of Object.entries(call.query)) url.searchParams.set(name, value);
  }
  const response = await fetch(url, {
    method: 'body' in call ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${credential}`,
      ...('body' in call ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    },
    ...('body' in call ? { body: JSON.stringify(call.body) } : {}),
    signal: AbortSignal.timeout(NOTICE_SLACK_TIMEOUT_MS),
  });
  // A gateway answering for Slack sends HTML; the status is then the reason.
  const payload: unknown = await response.json().catch((): unknown => ({}));
  const record =
    payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  if (!response.ok || record.ok !== true) {
    throw new Error(
      typeof record.error === 'string'
        ? `Slack ${method} failed: ${record.error}`
        : `Slack ${method} returned HTTP ${response.status}.`,
    );
  }
  return record;
}

/** Who an address names for the notice: a person to DM, or why nobody is. */
type NoticeRecipient = { readonly person: string } | { readonly nobody: string };

/**
 * The Slack user an address names, when it is a person the bot may DM: not a
 * bot or an app, not deactivated, not the bot itself, not the manager the card
 * already DMs, and not a guest (U2-m8). Otherwise why nobody is, the
 * workspace having no member with the address included.
 *
 * @param credential - The card's token.
 * @param address - The address the request names.
 * @param managerUserId - The member the card DMs as the employee's manager, when it has one.
 */
async function recipientNamedBy(
  credential: string,
  address: string,
  managerUserId: string | undefined,
): Promise<NoticeRecipient> {
  const auth = await callSlackForNotice(credential, 'auth.test', { query: {} });
  let lookup: Record<string, unknown>;
  try {
    lookup = await callSlackForNotice(credential, 'users.lookupByEmail', {
      query: { email: address },
    });
  } catch (error) {
    // Not a member of this workspace: the address names nobody the notice can reach.
    if (error instanceof Error && /users_not_found/.test(error.message)) {
      return { nobody: NOTICE_TO_NOBODY };
    }
    throw error;
  }
  const user =
    lookup.user !== null && typeof lookup.user === 'object'
      ? (lookup.user as Record<string, unknown>)
      : undefined;
  if (typeof user?.id !== 'string') return { nobody: NOTICE_TO_NOBODY };
  if (user.is_bot === true || user.is_app_user === true || user.deleted === true) {
    return { nobody: NOTICE_TO_NOBODY };
  }
  if (user.id === auth.user_id) return { nobody: NOTICE_TO_NOBODY };
  if (user.id === managerUserId) return { nobody: NOTICE_TO_THE_MANAGER };
  if (user.is_restricted === true || user.is_ultra_restricted === true) {
    return { nobody: NOTICE_TO_A_GUEST };
  }
  return { person: user.id };
}

/** What one attempt to deliver the notice did: delivered with the provider's timestamp, or why not. */
type NoticeDelivery =
  | { readonly delivered: true; readonly providerTs: string }
  | { readonly delivered: false; readonly reason: string };

/**
 * Deliver the claimed notice through the card's Slack token: find the person the address names
 * ({@link recipientNamedBy}), open their DM and post the words. Every provider failure is the
 * delivery's own answer, its message redacted of the token; nothing is recorded here, so a
 * failure to record a delivered notice is never mistaken for one that was not sent.
 *
 * @param ctx - The notice action's context, for the credential's decrypt.
 * @param claimed - The claimed notice: the credential, the address, the manager the card DMs and
 *   the words.
 */
async function deliverTransferNotice(
  ctx: ActionCtx,
  claimed: {
    readonly credentialId: string;
    readonly toAddress: string;
    readonly managerUserId?: string;
    readonly text: string;
  },
): Promise<NoticeDelivery> {
  let credential = '';
  try {
    credential = await decryptCredential(ctx, claimed.credentialId);
    const recipient = await recipientNamedBy(credential, claimed.toAddress, claimed.managerUserId);
    if ('nobody' in recipient) return { delivered: false, reason: recipient.nobody };
    const opened = await callSlackForNotice(credential, 'conversations.open', {
      body: { users: recipient.person },
    });
    const channel = (opened.channel as { id?: unknown } | undefined)?.id;
    if (typeof channel !== 'string') throw new Error('Slack conversations.open returned no DM.');
    const posted = await callSlackForNotice(credential, 'chat.postMessage', {
      body: { channel, text: claimed.text },
    });
    if (typeof posted.ts !== 'string') throw new Error('Slack chat.postMessage returned no ts.');
    return { delivered: true, providerTs: posted.ts };
  } catch (error) {
    return {
      delivered: false,
      reason: safeFailureMessage(error, credential, 'Handover notice failed.'),
    };
  }
}

/** What the notice action answers: sent, or why not. */
const transferNoticeOutcomeValidator = v.object({
  sent: v.boolean(),
  reason: v.optional(v.string()),
});

/**
 * Internal, scheduled by a real-mode `managerTransfers.ask`: the one DM notice
 * to the person a handover names (D7, the transfer plan section 5.2), from the
 * employee's Slack card, when the named address is a person in that
 * workspace. Claimed once by `transferNotice.claimTransferNotice` before
 * anything is sent, so it is never re-sent, a failure included; the provider's
 * timestamp is recorded as the evidence it landed. The notice decides nothing:
 * it carries no decision code, goes to a DM the decision poll never reads, and
 * a transfer is answered only in the dashboard (D6).
 */
export const sendTransferNotice = internalAction({
  args: { transferId: v.id('managerTransfers') },
  returns: transferNoticeOutcomeValidator,
  handler: async (ctx, args): Promise<Infer<typeof transferNoticeOutcomeValidator>> => {
    const claimed = await ctx.runMutation(internal.transferNotice.claimTransferNotice, args);
    if (!claimed.claimed) return { sent: false, reason: claimed.reason };
    const outcome = await deliverTransferNotice(ctx, claimed);
    if (outcome.delivered) {
      await ctx.runMutation(internal.transferNotice.recordTransferNotice, {
        transferId: args.transferId,
        providerTs: outcome.providerTs,
      });
      return { sent: true };
    }
    log.warn('handover notice not sent; it is not tried again', {
      transferId: args.transferId,
      reason: outcome.reason,
    });
    await ctx.runMutation(internal.transferNotice.recordTransferNoticeUndelivered, {
      transferId: args.transferId,
      reason: outcome.reason,
    });
    return { sent: false, reason: outcome.reason };
  },
});

/** What the access request's DM action answers: sent, or why not. */
const accessRequestOutcomeValidator = v.object({
  sent: v.boolean(),
  reason: v.optional(v.string()),
});

/**
 * Internal, scheduled by a real-mode `accessRequests.draft`: the access request as a message in
 * the manager's own DM (the access plan, section 4.5; A24), through the employee's Slack card, so
 * the manager can forward it however their IT works. Claimed by `accessRequests.claimMessage`
 * for the draft it was scheduled for, posted with `chat.postMessage` (the card's allowlist names
 * it), and recorded with Slack's timestamp once Slack has it. The words are the card's and the
 * export's. A failed post is logged and not tried again: the card still offers Copy and Email.
 */
export const sendAccessRequest = internalAction({
  args: { surfaceId: v.id('surfaces'), draftedAt: v.number() },
  returns: accessRequestOutcomeValidator,
  handler: async (ctx, args): Promise<Infer<typeof accessRequestOutcomeValidator>> => {
    const claimed = await ctx.runMutation(internal.accessRequests.claimMessage, args);
    if (!claimed.claimed) return { sent: false, reason: claimed.reason };
    let credential = '';
    let providerTs: string;
    try {
      credential = await decryptCredential(ctx, claimed.credentialId);
      const posted = await callSlackForNotice(credential, 'chat.postMessage', {
        body: { channel: claimed.channel, text: claimed.text },
      });
      if (typeof posted.ts !== 'string') throw new Error('Slack chat.postMessage returned no ts.');
      providerTs = posted.ts;
    } catch (error) {
      const reason = safeFailureMessage(error, credential, 'Access request DM failed.');
      log.warn('the access request was not sent to the manager; it is not tried again', {
        surfaceId: args.surfaceId,
        reason,
      });
      return { sent: false, reason };
    }
    await ctx.runMutation(internal.accessRequests.recordMessage, { ...args, providerTs });
    return { sent: true };
  },
});
