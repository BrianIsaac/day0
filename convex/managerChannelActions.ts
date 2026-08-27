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
} from '../src/surfaces/policy';
import { applySurfaceActions } from '../src/surfaces/registry';
import { safeFailureMessage } from '../src/surfaces/redact';
import type { BeforeSurfaceTransport, SurfaceRecord } from '../src/surfaces/types';
import {
  decisionIdFromBytes,
  decisionRequestText,
  managerMessageAction,
  type DecisionKind,
} from '../src/work/manager-channel';
import type { MockAction } from '../src/work/types';

function sameAuthority(left: SurfaceRecord, right: SurfaceRecord): boolean {
  return JSON.stringify({
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
  }) === JSON.stringify({
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
  });
}

interface ManagerDelivery {
  agentId: Id<'agents'>;
  agentName: string;
  requestRunId: Id<'events'>;
  surface: SurfaceRecord;
  surfaces: SurfaceRecord[];
  grants: string[];
}

async function deliverManagerMessage(
  ctx: ActionCtx,
  workItemId: Id<'workItems'>,
  delivery: ManagerDelivery,
  text: string,
) {
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
    [managerMessageAction(delivery.surface, text)],
    {
      deps: {
        decrypt: decryptCredential,
        createMcpClient: createMastraMcpClient,
        fetch: (input: URL, init: RequestInit): Promise<Response> => fetch(input, init),
        beforeTransport: beforeManagerTransport(ctx, delivery.agentId),
      },
      grants: new Set(delivery.grants),
      approvedIndexes: new Set([0]),
      autoPhase: true,
      autonomousActions: false,
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
): BeforeSurfaceTransport {
  return async (action, claimedSurface): Promise<string | undefined> => {
    const parsed = parseSurfaceAction(action);
    if (!parsed.ok) return parsed.reason;
    const authority = await ctx.runQuery(internal.work.transportAuthority, {
      agentId,
      surfaceSlug: parsed.action.surface,
    });
    if (!authority.agentExists) return 'agent not found';
    const surface = authority.surface;
    if (!surface) return UNKNOWN_SURFACE;
    if (!sameAuthority(surface, claimedSurface)) return 'surface authority changed before transport';
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
  },
  handler: async (ctx, args): Promise<{ sent: boolean; reason?: string }> => {
    const decisionId = decisionIdFromBytes(randomBytes(32));
    const prepared = await ctx.runMutation(internal.work.prepareDecisionRequest, {
      workItemId: args.workItemId,
      kind: args.kind,
      decisionId,
    });
    if (!prepared.prepared) return { sent: false, reason: prepared.reason };

    const text = decisionRequestText({
        agentName: prepared.agentName,
        title: prepared.title,
        id: prepared.decisionId,
        kind: args.kind as DecisionKind,
        plan: prepared.plan,
        actions: ((prepared.output ?? {}) as { actions?: MockAction[] }).actions,
        heldIndexes: prepared.heldIndexes,
        surfaces: prepared.surfaces,
      });
    try {
      const result = await deliverManagerMessage(ctx, args.workItemId, prepared, text);
      await ctx.runMutation(internal.work.recordDecisionRequest, {
        workItemId: args.workItemId,
        decisionId: prepared.decisionId,
        ts: result.providerId,
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

/** Send the sole acknowledgement claimed for a late or duplicate reply. */
export const sendDecisionNotice = internalAction({
  args: { workItemId: v.id('workItems'), decisionId: v.string() },
  handler: async (ctx, args): Promise<{ sent: boolean; reason?: string }> => {
    const prepared = await ctx.runMutation(internal.work.prepareDecisionNotice, args);
    if (!prepared.prepared) return { sent: false, reason: 'notice already claimed' };
    try {
      const result = await deliverManagerMessage(
        ctx,
        args.workItemId,
        prepared,
        prepared.text,
      );
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
