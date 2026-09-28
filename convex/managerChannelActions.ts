'use node';

import { randomBytes } from 'node:crypto';
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { internalAction, type ActionCtx } from './_generated/server';
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
import { isSlackApiEndpoint } from '../src/surfaces/slack-endpoint';
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
