'use node';

import { v } from 'convex/values';
import { action, type ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgentAction } from './ownership';
import { applySurfaceActions } from '../src/surfaces/registry';
import { decryptCredential } from '../src/surfaces/credentials';
import { createMastraMcpClient } from '../src/surfaces/mcp';
import { toSurfaceRecord } from '../src/surfaces/records';
import type { BeforeSurfaceTransport, SurfaceRecord } from '../src/surfaces/types';
import type { MockAction } from '../src/work/types';
import {
  grantRefusal,
  isAutomatic,
  mcpEndpointRefusal,
  NOT_AUTOMATIC,
  parseSurfaceAction,
  pathRefusal,
  requiredScope,
  surfaceRefusal,
  toolRefusal,
  UNKNOWN_SURFACE,
} from '../src/surfaces/policy';

const checkpoint = v.union(
  v.literal('none'),
  v.literal('scope-revoked'),
  v.literal('autonomy-off'),
);

type Checkpoint = 'none' | 'scope-revoked' | 'autonomy-off';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function surfaceAuthorityShape(surface: SurfaceRecord): string {
  return JSON.stringify({
    slug: surface.slug,
    verdict: surface.verdict,
    credentialLanded: surface.credentialLanded,
    lastVerifiedAt: surface.lastVerifiedAt,
    path: surface.path,
    endpoint: surface.endpoint,
    toolAllowlist: [...(surface.toolAllowlist ?? [])].sort(),
    toolArguments: surface.toolArguments,
    credentialId: surface.credentialId,
    credentialKind: surface.credentialKind,
    managerDmChannelId: surface.managerDmChannelId,
    managerUserId: surface.managerUserId,
  });
}

function finalAuthority(ctx: ActionCtx, agentId: Id<'agents'>): BeforeSurfaceTransport {
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
    if (surfaceAuthorityShape(surface) !== surfaceAuthorityShape(claimedSurface)) {
      return 'surface authority changed before transport';
    }
    const refusal =
      surfaceRefusal(surface, Date.now()) ??
      pathRefusal(parsed.action, surface) ??
      mcpEndpointRefusal(surface) ??
      toolRefusal(parsed.action, surface);
    if (refusal) return refusal;
    if (!isAutomatic(parsed.action, surface, authority.autonomousActions)) return NOT_AUTOMATIC;
    const grant = grantRefusal(
      parsed.action,
      surface,
      new Set(authority.grants),
      authority.autonomousActions,
      new Set(authority.revokedScopes ?? []),
    );
    if (grant) return grant;
    return undefined;
  };
}

async function waitForContainment(
  ctx: ActionCtx,
  workItemId: Id<'workItems'>,
  expected: Exclude<Checkpoint, 'none'>,
  scope: string,
): Promise<void> {
  await ctx.runMutation(internal.revocationEvaluation.markTransportReady, {
    workItemId,
    checkpoint: expected,
    scope,
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (
      await ctx.runQuery(internal.revocationEvaluation.containmentReached, {
        workItemId,
        checkpoint: expected,
        scope,
      })
    ) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`evaluation driver did not reach ${expected} within 15 seconds`);
}

/** Store the fake provider token and create the two cards the driver approves normally. */
export const setupSurfaceCards = action({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ slack: Id<'surfaces'>; tile: Id<'surfaces'> }> => {
    const agent = await assertOwnsAgentAction(ctx, args.agentId);
    if (!agent.bossEmail.startsWith('eval-revocation-') || !agent.userId) {
      throw new Error('revocation evaluation accepts only its isolated evaluation agent');
    }
    const slackCredentialId: Id<'credentials'> = await ctx.runAction(internal.credentials.store, {
      userId: agent.userId,
      kind: 'oauth',
      label: 'Fake Slack dedicated evaluation token',
      plaintext: 'xoxb-day0-fake-dedicated-token',
      source: 'oauth',
      appId: 'A_DAY0_FAKE',
    });
    return await ctx.runMutation(internal.revocationEvaluation.installSurfaceCards, {
      agentId: args.agentId,
      slackCredentialId,
    });
  },
});

/** Run one deterministic action through the shipped real registry and HTTP adapter. */
export const runTrialAction = action({
  args: { workItemId: v.id('workItems'), checkpoint },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const context: {
      row: Doc<'workItems'>;
      agent: Doc<'agents'>;
      surface: Doc<'surfaces'>;
      grants: string[];
    } = await ctx.runQuery(internal.revocationEvaluation.actionContext, {
      workItemId: args.workItemId,
    });
    await assertOwnsAgentAction(ctx, context.agent._id);
    const output = context.row.output as {
      actions?: MockAction[];
      actionIndexOffset?: number;
    };
    if (!context.row.pendingRunId || !output.actions?.length) {
      throw new Error('evaluation work item has no staged action');
    }
    const parsed = parseSurfaceAction(output.actions[0]);
    if (!parsed.ok) throw new Error(parsed.reason);
    const scope = requiredScope(parsed.action);
    let paused = false;
    const applied = await applySurfaceActions(
      ctx,
      'real',
      [toSurfaceRecord(context.surface)],
      {
        agentId: context.agent._id,
        agentName: context.agent.name,
        workItemId: context.row._id,
        runId: context.row.pendingRunId,
      },
      output.actions,
      {
        deps: {
          decrypt: async (actionCtx, credentialId): Promise<string> => {
            const secret = await decryptCredential(actionCtx, credentialId);
            if (args.checkpoint !== 'none' && !paused) {
              paused = true;
              await waitForContainment(actionCtx, context.row._id, args.checkpoint, scope);
            }
            return secret;
          },
          createMcpClient: createMastraMcpClient,
          fetch: (input, init): Promise<Response> => fetch(input, init),
          beforeTransport: finalAuthority(ctx, context.agent._id),
        },
        grants: new Set(context.grants),
        approvedIndexes: new Set([0]),
        idempotencyIndexOffset: output.actionIndexOffset ?? 0,
        autoPhase: true,
        autonomousActions: context.agent.autonomousActions === true,
      },
    );
    await ctx.runMutation(internal.revocationEvaluation.recordOutcome, {
      workItemId: context.row._id,
      applied,
    });
    const failure = applied.find((entry) => !entry.ok && !entry.held);
    return failure ? { ok: false, reason: failure.reason } : { ok: true };
  },
});
