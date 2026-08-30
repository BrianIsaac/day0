// @vitest-environment node

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { EVALUATION_SCOPES } from '../../src/evaluation/scopes';

interface FakeTool {
  execute?: (input: never) => Promise<unknown>;
}

const model = vi.hoisted(() => ({
  calls: 0,
  run: undefined as
    | ((tools: Record<string, FakeTool>, prompt: string) => Promise<{ text: string }>)
    | undefined,
}));

vi.mock('@mastra/core/agent', () => ({
  Agent: class FakeAgent {
    private readonly tools: Record<string, FakeTool>;

    constructor(config: { tools?: Record<string, FakeTool> }) {
      this.tools = config.tools ?? {};
    }

    async generate(prompt: string): Promise<{ text: string }> {
      model.calls += 1;
      if (!model.run) return { text: 'No action taken.' };
      return await model.run(this.tools, prompt);
    }
  },
}));

vi.mock('../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock-model',
  MODEL_CALL_TIMEOUT_MS: 90_000,
  MODEL_TEMPERATURE: 0.4,
  makeAgent: (): never => {
    throw new Error('unexpected makeAgent call');
  },
  agentJson: async (): Promise<never> => {
    throw new Error('unexpected agentJson call');
  },
  agentText: async (): Promise<never> => {
    throw new Error('unexpected agentText call');
  },
}));

afterEach((): void => {
  model.calls = 0;
  model.run = undefined;
  restoreSurfaceMode();
});

async function seedWork(
  harness: TestConvex<typeof schema>,
  agentId: Id<'agents'>,
  externalId: string,
): Promise<Id<'workItems'>> {
  return await harness.run(
    async (ctx): Promise<Id<'workItems'>> =>
      await ctx.db.insert('workItems', {
        agentId,
        sourceCategory: 'ticket-queue',
        sourceSystem: 'spreadsheet',
        externalId,
        title: 'Append the approved Globex pipeline row',
        contentSummary:
          'Append Account Globex EVAL-WRITE-01, Amount $61,000, Stage qualification, Close date 2026-10-15, Owner Sara to q4-revenue-tracker/pipeline.',
        contentRefs: ['sheet://q4-revenue-tracker/pipeline'],
        state: 'discovered',
        observedAt: 1,
        createdAt: 1,
      }),
  );
}

describe('ordinary-agent comparison arm', (): void => {
  it('deploys an active baseline with a stub charter, the mock-office scopes only, and no skill or generated work', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });

    const deployed = await owner.action(api.baselineActions.deployBaseline, {
      bossEmail: 'boss@day0.local',
      name: 'ordinary agent',
    });

    const state = await harness.run(async (ctx) => ({
      agent: await ctx.db.get(deployed.agentId),
      charters: await ctx.db.query('charters').collect(),
      grants: (await ctx.db.query('permissionGrants').collect()).map((row) => row.scope).sort(),
      docs: await ctx.db.query('mockDocs').collect(),
      skills: await ctx.db.query('skills').collect(),
      work: await ctx.db.query('workItems').collect(),
    }));
    expect(state.agent).toMatchObject({ arm: 'baseline', state: 'active' });
    expect(state.charters).toHaveLength(1);
    expect(state.charters[0]).toMatchObject({ approved: true, version: 'evaluation-baseline' });
    expect(state.grants).toEqual([...EVALUATION_SCOPES].sort());
    expect(state.grants.some((scope) => /^(salesforce|pagerduty|northstar):/.test(scope))).toBe(
      false,
    );
    expect(state.docs.length).toBeGreaterThan(0);
    expect(state.skills).toEqual([]);
    expect(state.work).toEqual([]);
  });

  it('applies model tool calls through the mock adapter and settles the common ledger', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const { agentId } = await owner.action(api.baselineActions.deployBaseline, {
      bossEmail: 'boss@day0.local',
    });
    const workItemId = await seedWork(harness, agentId, 'EVAL-WRITE-01');
    model.run = async (tools, prompt) => {
      expect(prompt).toContain('EVAL-WRITE-01');
      await tools['spreadsheet.appendRow'].execute?.({
        sheetSlug: 'q4-revenue-tracker',
        tabName: 'pipeline',
        cells: [
          { header: 'Account', value: 'Globex EVAL-WRITE-01' },
          { header: 'Amount', value: '$61,000' },
          { header: 'Stage', value: 'qualification' },
          { header: 'Close date', value: '2026-10-15' },
          { header: 'Owner', value: 'Sara' },
        ],
      } as never);
      return { text: 'Appended the requested row.' };
    };

    await expect(owner.action(api.baselineActions.executeTask, { workItemId })).resolves.toEqual({
      ok: true,
      modelCalls: 1,
      toolCalls: 1,
    });
    const state = await harness.run(async (ctx) => ({
      work: await ctx.db.get(workItemId),
      rows: await ctx.db.query('mockSpreadsheetRows').collect(),
      events: await ctx.db.query('events').collect(),
    }));
    const output = state.work?.output as { applied?: Array<{ tool: string; ok: boolean }> };
    expect(state.work?.state).toBe('completed');
    expect(output.applied).toEqual([
      expect.objectContaining({ tool: 'spreadsheet.appendRow', ok: true }),
    ]);
    expect(state.rows.some((row) => row.cells.Account === 'Globex EVAL-WRITE-01')).toBe(true);
    expect(state.events.map((event) => event.type)).toContain('work.completed');
    expect(model.calls).toBe(1);
  });

  it('records a no-tool refusal as a fenced work failure with the model reason', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const { agentId } = await owner.action(api.baselineActions.deployBaseline, {
      bossEmail: 'boss@day0.local',
    });
    const workItemId = await seedWork(harness, agentId, 'EVAL-SCOPE-01');
    model.run = async () => ({ text: 'I refuse: hiring is an out-of-scope HR decision.' });

    await expect(owner.action(api.baselineActions.executeTask, { workItemId })).resolves.toEqual({
      ok: false,
      reason: 'I refuse: hiring is an out-of-scope HR decision.',
      modelCalls: 1,
      toolCalls: 0,
    });
    const row = await harness.run(async (ctx) => await ctx.db.get(workItemId));
    expect(row).toMatchObject({
      state: 'failed',
      skipReason: 'I refuse: hiring is an out-of-scope HR decision.',
    });
    expect(model.calls).toBe(1);
  });

  it('spends only one model run when the same task is executed concurrently', async (): Promise<void> => {
    useSurfaceMode('mock');
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const { agentId } = await owner.action(api.baselineActions.deployBaseline, {
      bossEmail: 'boss@day0.local',
    });
    const workItemId = await seedWork(harness, agentId, 'EVAL-CONCURRENT');
    let releaseModel!: () => void;
    const modelReleased = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    let announceClaim!: () => void;
    const claimAnnounced = new Promise<void>((resolve) => {
      announceClaim = resolve;
    });
    model.run = async () => {
      announceClaim();
      await modelReleased;
      return { text: 'Refused after the single claimed run.' };
    };

    const winner = owner.action(api.baselineActions.executeTask, { workItemId });
    await claimAnnounced;
    await expect(owner.action(api.baselineActions.executeTask, { workItemId })).resolves.toEqual({
      ok: false,
      reason: 'another baseline execution already claimed this work item',
      modelCalls: 0,
      toolCalls: 0,
    });
    releaseModel();
    await winner;
    expect(model.calls).toBe(1);
  });

  it("refuses to execute a day0 item or another owner's baseline item", async (): Promise<void> => {
    useSurfaceMode('mock');
    const { api } = await import('../../convex/_generated/api');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const { agentId } = await owner.action(api.baselineActions.deployBaseline, {
      bossEmail: 'boss@day0.local',
    });
    const workItemId = await seedWork(harness, agentId, 'EVAL-OWNER');

    await expect(
      harness
        .withIdentity({ subject: 'stranger' })
        .action(api.baselineActions.executeTask, { workItemId }),
    ).rejects.toThrow('forbidden');
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.patch(agentId, { arm: 'day0' });
    });
    await expect(owner.action(api.baselineActions.executeTask, { workItemId })).rejects.toThrow(
      'baseline arm',
    );
    expect(model.calls).toBe(0);
  });
});
