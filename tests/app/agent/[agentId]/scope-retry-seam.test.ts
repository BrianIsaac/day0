/** @vitest-environment node */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MANAGER_ADDRESS, managerIdentity } from '../../../convex/fakes/manager-identity';

vi.mock('convex/react', () => ({
  useQuery: (): undefined => undefined,
  useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
  useAction: (): (() => Promise<void>) => async (): Promise<void> => undefined,
}));
vi.mock('../../../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

import { api } from '../../../../convex/_generated/api';
import type { Doc, Id } from '../../../../convex/_generated/dataModel';
import schema from '../../../../convex/schema';
import { WorkItemCard } from '../../../../app/agent/[agentId]/work/WorkItemCard';
import { nextItemToEvaluate, retryRequest } from '../../../../app/agent/[agentId]/work/WorkQueue';
import { OUT_OF_SCOPE_SKIP_PREFIX } from '../../../../src/work/types';
import { allConvexModules } from '../../../convex/all-modules';
import { restoreSurfaceMode, useSurfaceMode } from '../../../convex/surface-mode-env';

type Harness = TestConvex<typeof schema>;

const OWNER = managerIdentity();

afterEach((): void => {
  restoreSurfaceMode();
});

async function seed(
  harness: Harness,
): Promise<{ agentId: Id<'agents'>; workItemId: Id<'workItems'> }> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId,
      version: '0.0',
      approved: true,
      approvedAt: 1,
      createdAt: 1,
      body: {
        proposedFunction: 'RevOps analyst',
        proposedBoundaries: { willDo: ['close summaries'], willNotDo: [], escalationTriggers: [] },
        approvalChain: { boss: 'boss@day0.local' },
      },
    });
    await ctx.db.insert('skills', {
      agentId,
      name: 'update-linear-ticket',
      description: 'Comment on and close a linear ticket.',
      body: 'Comment, then close.',
      sourceType: 'agent-authored',
      state: 'registered',
      createdAt: 1,
      registeredAt: 1,
    });
    for (const scope of ['boss:message', 'linear:read', 'linear:write']) {
      await ctx.db.insert('permissionGrants', { agentId, scope, createdAt: 1 });
    }
    await ctx.db.insert('mockSlackChannels', {
      agentId,
      slug: 'dm-manager',
      displayName: 'Manager DM',
      kind: 'dm',
      createdAt: 1,
    });
    const workItemId = await ctx.db.insert('workItems', {
      agentId,
      sourceCategory: 'ticket-queue',
      sourceSystem: 'linear',
      externalId: 'OPS-9',
      title: 'Book the offsite venue',
      contentSummary: 'Reserve the venue and confirm the catering headcount.',
      contentRefs: [],
      state: 'discovered',
      observedAt: 1,
      createdAt: 1,
    });
    return { agentId, workItemId };
  });
}

const noop = (): void => undefined;
const resolved = async (): Promise<void> => undefined;

function card(item: Doc<'workItems'>, onRetryFailed: (feedback?: string) => void): string {
  return renderToStaticMarkup(
    createElement(WorkItemCard, {
      item,
      surfaces: [],
      autonomousActions: false,
      onApprovePlan: noop,
      onCancelPlan: noop,
      onRetryFailed,
      onReconcileFailed: resolved,
      onApproveActions: resolved,
      onRejectActions: resolved,
      onResendDecision: resolved,
    }),
  );
}

/** The Convex modules the seam's three calls load, each with everything it imports. */
const SEAM_MODULES = ['work', 'workActions', 'workRuns'] as const;

// The seam's calls load most of the Convex tree, and the harness loads a module at the first call
// that needs it, so the test's own clock used to hold that cold load: about five seconds alone
// and several times that beside other suites, which is what timed the test out at 30 s once
// (16-F's F7: one run in a five-file targeted run while another unit's bed was up). The load is
// taken here, under its own bound, so the test's timeout measures the seam and nothing else. A
// reset of the module registry (`useSurfaceMode`) evaluates the modules again and transforms none.
beforeAll(async (): Promise<void> => {
  useSurfaceMode('mock');
  const modules = allConvexModules();
  await Promise.all(SEAM_MODULES.map(async (name) => await modules[`../../convex/${name}.ts`]?.()));
  restoreSurfaceMode();
}, 180_000);

describe(
  'the manager retries an out-of-scope skip from the card',
  { timeout: 30_000 },
  (): void => {
    it('reaches the evaluator with the scope rule waived, from the Retry the card offers to the claim', async (): Promise<void> => {
      useSurfaceMode('mock');
      const harness = convexTest(schema, allConvexModules());
      const { agentId, workItemId } = await seed(harness);
      const owner = harness.withIdentity(OWNER);
      const items = async (): Promise<Doc<'workItems'>[]> =>
        await owner.query(api.work.listForAgent, { agentId });
      const events = async (type: string): Promise<unknown[]> =>
        (
          await harness.run(
            async (ctx) =>
              await ctx.db
                .query('events')
                .withIndex('by_agent', (q) => q.eq('agentId', agentId))
                .collect(),
          )
        )
          .filter((event) => event.type === type)
          .map((event) => event.payload);

      // The queue evaluates the discovered item on its own and the scope judgement skips it.
      expect(nextItemToEvaluate(await items())?._id).toBe(workItemId);
      await expect(owner.action(api.workActions.evaluateWorkItem, { workItemId })).resolves.toEqual(
        { decision: 'skip' },
      );
      const skipped = (await items())[0];
      expect(skipped).toMatchObject({
        state: 'skipped',
        verdict: {
          decision: 'skip',
          // Re-taken for RM21 (c), 12 October 2026: the lexical rule's reason in plain words.
          reason: `${OUT_OF_SCOPE_SKIP_PREFIX}nothing in it is part of the role or its will-do clauses, and it names no system the role is connected to`,
        },
      });

      // The card offers Retry as the manager's scope decision; its button sends
      // exactly the request the page hands to workRuns.retryFailed.
      const sent: Array<string | undefined> = [];
      const markup = card(skipped, (feedback) => sent.push(feedback));
      expect(markup).toContain('>Take it anyway<');
      expect(markup).toContain('Take it anyway is your decision that this work is');
      expect(retryRequest(skipped._id, '  ')).toEqual({ workItemId });
      expect(retryRequest(skipped._id, 'The venue is ours to book.')).toEqual({
        workItemId,
        feedback: 'The venue is ours to book.',
      });
      expect(sent).toEqual([]);

      await expect(
        owner.mutation(
          api.workRuns.retryFailed,
          retryRequest(skipped._id, 'The venue is ours to book.'),
        ),
      ).resolves.toEqual({
        ok: true,
        resumeState: 'discovered',
      });
      expect(await events('work.retry')).toEqual([
        {
          workItemId,
          resumeState: 'discovered',
          fromState: 'skipped',
          waived: 'scope',
          feedback: 'The venue is ours to book.',
        },
      ]);

      // The queue picks the re-admitted row up again, and this time the
      // evaluator leaves the scope rule out.
      const readmitted = await items();
      expect(nextItemToEvaluate(readmitted)?._id).toBe(workItemId);
      expect(typeof readmitted[0].scopeWaivedAt).toBe('number');
      await expect(owner.action(api.workActions.evaluateWorkItem, { workItemId })).resolves.toEqual(
        { decision: 'claim' },
      );
      const claimed = (await items())[0];
      expect(claimed.state).toBe('claimed');
      expect(claimed.qualityFitWaivedAt).toBeUndefined();
      expect(claimed.managerFeedback).toMatchObject({
        reason: 'The venue is ours to book.',
        kind: 'retry-note',
      });
      expect(nextItemToEvaluate(await items())).toBeUndefined();
      expect(card(claimed, noop)).not.toContain('>Retry<');
      // The whole seam in one test: the card's render, the retry, the evaluation, with the
      // modules already loaded by the hook above.
    }, 30_000);
  },
);
