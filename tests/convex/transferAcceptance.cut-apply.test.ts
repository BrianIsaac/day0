/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type schema from '../../convex/schema';
import type { McpClientLike, McpClientOptions } from '../../src/surfaces/mcp';
import { HELD_WITHHELD_TRANSITION } from '../../src/surfaces/policy';
import type { AppliedAction } from '../../src/surfaces/types';
import { transferExpiresAt } from '../../src/agent/manager-transfer';
import type { MockAction } from '../../src/work/types';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, fixtureAddressOf, managerIdentity } from './fakes/manager-identity';

/**
 * U-3 of the transfer plan (section 13): an action set the old manager's employee held for
 * approval moves with the employee, its surface is cut at the move, and the new manager
 * approves it before connecting the surface again. The model is not involved; the approval and
 * the apply are the real ones, with the provider's transport recorded.
 */

const recorded = vi.hoisted(() => ({
  mcp: [] as Array<{ server: string; tool: string; args: unknown }>,
}));

vi.mock('../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (args: { agent: { name: string } }): Promise<unknown> => {
    throw new Error(`unscripted agent ${args.agent.name}`);
  },
  agentText: async (): Promise<string> => '',
}));

vi.mock('../../src/surfaces/credentials', () => import('./fakes/surface-credentials'));

vi.mock('../../src/surfaces/mcp', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/surfaces/mcp')>();
  return {
    ...original,
    createMastraMcpClient: (options: McpClientOptions): McpClientLike => ({
      listTools: async () =>
        Object.fromEntries(
          ['get_issue', 'save_comment'].map((tool) => [
            `${options.serverName}_${tool}`,
            {
              execute: async (args: unknown): Promise<unknown> => {
                recorded.mcp.push({ server: options.serverName, tool, args });
                return { content: [{ type: 'text', text: JSON.stringify({ id: 'comment-1' }) }] };
              },
            },
          ]),
        ),
      disconnect: async (): Promise<void> => {},
    }),
  };
});

type Harness = TestConvex<typeof schema>;

/** The account the handover names. */
const COLLEAGUE = managerIdentity('colleague');

/** The held write: a comment on the ticket through the Linear surface. */
const COMMENT: MockAction = {
  tool: 'mcp.call',
  args: {
    surface: 'linear',
    tool: 'save_comment',
    toolArgsJson: JSON.stringify({ issueId: 'iss-1', body: 'Status: in review.' }),
  },
};

/**
 * Seed Maya with a connected Linear surface on the owner's credential and one comment held for
 * the manager's approval, and a handover request naming the colleague.
 */
async function seedHeldWrite(harness: Harness): Promise<{
  readonly workItemId: Id<'workItems'>;
  readonly transferId: Id<'managerTransfers'>;
}> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Maya',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    for (const scope of ['boss:message', 'linear:read', 'linear:write']) {
      await ctx.db.insert('permissionGrants', { agentId, scope, source: 'manager', createdAt: 1 });
    }
    const credentialId = await ctx.db.insert('credentials', {
      userId: 'owner',
      kind: 'value',
      label: 'Linear service token',
      ciphertext: 'sealed',
      iv: 'iv',
      source: 'entered',
      createdAt: 1,
    });
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'connected',
      endpoint: 'https://mcp.linear.app/mcp',
      path: 'mcp',
      managerApprovedAt: 1,
      toolAllowlist: ['get_issue', 'save_comment'],
      approvedToolAllowlist: ['get_issue', 'save_comment'],
      toolArguments: [
        { tool: 'get_issue', arguments: ['id'] },
        { tool: 'save_comment', arguments: ['issueId', 'body'] },
      ],
      credentialId,
      credentialKind: 'value',
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      whereFound: [],
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'iss-1',
      externalClaimKey: 'linear:iss-1',
      title: 'Move iss-1 to review',
      contentSummary: 'Say on the ticket that it is in review.',
      contentRefs: [],
      state: 'actions-pending',
      verdict: { decision: 'claim', value: 60, risk: 30, requiredPermissions: ['linear:write'] },
      observedAt: 1,
      createdAt: 1,
    });
    const runId = await ctx.db.insert('events', {
      agentId,
      type: 'work.execution-claimed',
      payload: { workItemId },
      createdAt: Date.now(),
    });
    await ctx.db.patch(workItemId, {
      executionRunId: runId,
      pendingRunId: runId,
      applyPhase: 'auto',
      actionVerdicts: [{ disposition: 'held', reason: HELD_WITHHELD_TRANSITION }],
      output: { draft: 'Status: in review.', notes: '', actions: [COMMENT] },
    });
    const transferId = await ctx.db.insert('managerTransfers', {
      agentId,
      agentName: 'Maya',
      fromOwnerKey: 'owner',
      fromAddress: MANAGER_ADDRESS,
      toAddress: fixtureAddressOf('colleague'),
      state: 'asked',
      requestedAt: Date.now(),
      expiresAt: transferExpiresAt(Date.now()),
    });
    return { workItemId, transferId };
  });
}

/** Accept the handover, approve the held write as the new manager, and run the apply. */
async function approveAfterTheMove(harness: Harness): Promise<Doc<'workItems'>> {
  const { workItemId, transferId } = await seedHeldWrite(harness);
  const colleague = harness.withIdentity(COLLEAGUE);
  await colleague.mutation(api.transferAcceptance.accept, { transferId });
  const held = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!held?.pendingRunId) throw new Error('the held row lost its run');
  await colleague.mutation(api.work.approveActions, {
    workItemId,
    pendingRunId: held.pendingRunId,
    approvedIndexes: [0],
  });
  await harness.action(internal.workActions.applyApprovedActions, { workItemId });
  const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
  if (!row) throw new Error('work item missing');
  return row;
}

describe('an approved write on a surface the handover cut (U-3)', (): void => {
  beforeEach((): void => {
    useSurfaceMode('real');
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
    // The apply an approval schedules waits on the faked clock, so the one each test runs by
    // hand is the only apply of the item.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach((): void => {
    recorded.mcp.length = 0;
    vi.useRealTimers();
    vi.unstubAllEnvs();
    restoreSurfaceMode();
  });

  /** A harness whose modules resolved real mode. */
  async function realHarness(): Promise<Harness> {
    const [{ default: realSchema }, { allConvexModules: realModules }] = await Promise.all([
      import('../../convex/schema'),
      import('./all-modules'),
    ]);
    return convexTest(realSchema, realModules());
  }

  it('sends nothing through the cut connection and refuses the write at the gate', async (): Promise<void> => {
    const harness = await realHarness();

    const row = await approveAfterTheMove(harness);

    expect(recorded.mcp.filter((call) => call.tool === 'save_comment')).toEqual([]);
    const ledger = (row.output as { applied: AppliedAction[] }).applied;
    expect(ledger).toMatchObject([{ ok: false, reason: 'surface not connected (proposed)' }]);
  });

  it.fails(
    // until the approval or the apply's start parks it (convex/work.ts, recorded for the cockpit in the 9-U3a handover): today the gate fails the item
    'parks the approved write on its connection until the new manager connects it',
    async (): Promise<void> => {
      const harness = await realHarness();

      const row = await approveAfterTheMove(harness);

      expect(row.state).toBe('deferred');
      expect(row.verdict).toMatchObject({ reason: 'awaiting-connection' });
    },
  );
});
