/** @vitest-environment node */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { contractSchema } from './contract-schema';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

/**
 * Every model call a loop step makes in real mode goes on the item's events
 * as `work.model-call`: which step, which agent, how many attempts, how long,
 * how it ended. Three employees under autonomy put up to nine runs on one
 * provider route, and this is how a five-minute step is read afterwards as a
 * slow call or as retries. The payload never carries the prompt, the reply
 * or an error message that could quote either. Mock mode writes nothing: its
 * event feed is what the frozen harness and the hosted demo read.
 */

const recorded = vi.hoisted(() => ({
  prompts: [] as string[],
  /** Scripted outcomes for the scope judgement, consumed in order. */
  scopeOutcomes: [] as Array<{ statusCode: number } | { object: unknown }>,
}));

vi.mock('../../src/lib/mastra', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/mastra')>();
  return {
    ...original,
    makeAgent: (name: string): { name: string; generate: (user: string) => Promise<unknown> } => ({
      name,
      generate: async (user: string): Promise<unknown> => {
        recorded.prompts.push(user);
        if (name === 'day0-scope-judgement') {
          const next = recorded.scopeOutcomes.shift() ?? {
            object: { inScope: true, fit: true, reason: 'close summaries are the charter work' },
          };
          if ('statusCode' in next) throw Object.assign(new Error(`provider answered ${next.statusCode} to: ${user}`), next);
          return next;
        }
        if (name === 'day0-quality-fit') {
          return { object: { pass: true, reason: 'fits' } };
        }
        throw new Error(`unscripted agent ${name}`);
      },
    }),
  };
});

type Harness = TestConvex<typeof schema>;
const OWNER = { subject: 'owner' };
const TICKET_BODY = 'Triage this Linear close summary revenue operations hand-off.';

afterEach((): void => {
  recorded.prompts.length = 0;
  recorded.scopeOutcomes.length = 0;
  vi.useRealTimers();
  restoreSurfaceMode();
});

async function seedEmployee(harness: Harness): Promise<Id<'agents'>> {
  return await harness.run(async (ctx) => {
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      autonomousActions: false,
      createdAt: 1,
    });
    await ctx.db.insert('charters', {
      agentId,
      version: 'v1',
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
    await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'connected',
      endpoint: 'https://mcp.linear.app/mcp',
      path: 'mcp',
      toolAllowlist: ['save_comment', 'save_issue'],
      credentialId: 'cred-linear',
      credentialLanded: true,
      lastVerifiedAt: Date.now(),
      whereFound: [],
      createdAt: 1,
    } as never);
    return agentId;
  });
}

async function insertDiscovered(harness: Harness, agentId: Id<'agents'>, externalId: string): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx) =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId,
        title: `Triage the Linear close summary ${externalId}`,
        contentSummary: TICKET_BODY,
        contentRefs: [`ticket://${externalId}`],
        priority: 'High',
        state: 'discovered',
        observedAt: Date.now(),
        createdAt: Date.now(),
      }),
  );
}

async function modelCallEvents(harness: Harness): Promise<Doc<'events'>[]> {
  return (await harness.run(async (ctx) => await ctx.db.query('events').collect())).filter(
    (event) => event.type === 'work.model-call',
  );
}

describe('work.model-call on the item events', (): void => {
  it('records the evaluation step\'s charter judgement with its stage, agent, attempts and duration', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await insertDiscovered(harness, agentId, 'REVOPS-70');

    await expect(
      harness.action(internal.workActions.evaluateWorkItemInternal, { workItemId }),
    ).resolves.toEqual({ decision: 'claim' });

    const events = await modelCallEvents(harness);
    expect(events).toHaveLength(1);
    expect(events[0]!.agentId).toBe(agentId);
    expect(events[0]!.payload).toEqual({
      workItemId,
      stage: 'evaluation',
      agent: 'day0-scope-judgement',
      attempts: 1,
      retries: 0,
      durationMs: expect.any(Number),
      outcome: 'ok',
    });
  });

  it('records the retries a call needed, and never the prompt or the provider\'s message', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    const workItemId = await insertDiscovered(harness, agentId, 'REVOPS-71');
    // Only the wrapper's back-off timer is faked: the harness and the clock
    // the report's duration is read from stay real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    recorded.scopeOutcomes.push({ statusCode: 503 }, { statusCode: 429 });
    vi.spyOn(console, 'warn').mockImplementation((): void => {});

    // The step reads its rows before the first attempt and the harness loads
    // each module it reaches from disk, so the faked clock is advanced in
    // slices, yielding to the real event loop between them, until the action
    // settles.
    let settled = false;
    const pending = harness.action(internal.workActions.evaluateWorkItemInternal, { workItemId }).finally(
      (): void => {
        settled = true;
      },
    );
    const deadline = Date.now() + 15_000;
    while (!settled && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(500);
    }
    await expect(pending).resolves.toEqual({ decision: 'claim' });

    const events = await modelCallEvents(harness);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      stage: 'evaluation',
      agent: 'day0-scope-judgement',
      attempts: 3,
      retries: 2,
      outcome: 'ok',
    });
    expect(recorded.prompts.length).toBeGreaterThan(0);
    const stored = JSON.stringify(events[0]!.payload);
    expect(stored).not.toContain(TICKET_BODY);
    expect(stored).not.toContain('provider answered');
    for (const prompt of recorded.prompts) expect(stored).not.toContain(prompt.slice(0, 40));
  }, 20_000);

  it('writes nothing in mock mode', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(contractSchema(), allConvexModules());
    const agentId = await seedEmployee(harness);
    // A good-habits memory is what makes the mock evaluator spend a model
    // call on quality fit; without one it short-circuits and nothing is
    // there to observe.
    await harness.run(async (ctx) => {
      await ctx.db.insert('workspace', {
        agentId,
        fileName: 'AGENTS.md',
        content: '## Good-habits memory\n\n- Close summaries name the quarter.\n',
        updatedAt: 1,
      });
    });
    const workItemId = await insertDiscovered(harness, agentId, 'REVOPS-72');

    await harness.withIdentity(OWNER).action(api.workActions.evaluateWorkItem, { workItemId });

    expect(recorded.prompts.length).toBeGreaterThan(0);
    expect(await modelCallEvents(harness)).toEqual([]);
  });
});
