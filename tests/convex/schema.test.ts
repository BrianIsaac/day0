import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { convexModules } from './modules';

describe('documentation schema', (): void => {
  it('stores owner-level sources, pages and agent source selections', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
    const result = await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Team folder',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const pageId = await ctx.db.insert('docPages', {
        sourceId,
        ref: 'onboarding.md',
        title: 'Onboarding',
        markdown: '# Onboarding',
        updatedAt: 1,
      });
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'schema test',
        userId: 'owner',
        excludedDocSourceIds: [sourceId],
        state: 'deployed',
        createdAt: 1,
      });
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'linear service token',
        ciphertext: 'ciphertext',
        iv: 'iv',
        source: { sourceId, ref: 'onboarding.md' },
        createdAt: 1,
      });
      return {
        source: await ctx.db.get(sourceId),
        page: await ctx.db.get(pageId),
        agent: await ctx.db.get(agentId),
        credential: await ctx.db.get(credentialId),
      };
    });
    expect(result.source?.kind).toBe('folder');
    expect(result.page?.ref).toBe('onboarding.md');
    expect(result.agent?.excludedDocSourceIds).toEqual([result.source?._id]);
    expect(result.credential?.source).toEqual({
      sourceId: result.source?._id,
      ref: 'onboarding.md',
    });
  });
});

describe('surface connection evidence persistence', (): void => {
  it('retains provider evidence while advancing intake checkpoints monotonically', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
    const surfaceId = await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'Schema behaviour test',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      return await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        whereFound: [],
        managerDmChannelId: 'DMANAGER',
        providerIdentityId: 'UBOT',
        providerWorkspaceId: 'TWORKSPACE',
        toolAllowlist: ['conversations.history'],
        toolArguments: [{ tool: 'conversations.history', arguments: ['channel', 'oldest'] }],
        probeGeneration: 2,
        credentialLanded: true,
        lastVerifiedAt: 100,
        createdAt: 1,
      });
    });

    await harness.mutation(internal.surfaces.recordIntake, {
      surfaceId,
      waterfallPosition: 4,
      polledAt: 200,
    });
    await harness.mutation(internal.surfaces.recordIntake, {
      surfaceId,
      waterfallPosition: 2,
      skipReason: 'temporarily skipped',
      polledAt: 150,
    });

    const surface = await harness.run(
      async (ctx): Promise<Doc<'surfaces'> | null> => await ctx.db.get(surfaceId),
    );
    expect(surface).toMatchObject({
      managerDmChannelId: 'DMANAGER',
      providerIdentityId: 'UBOT',
      providerWorkspaceId: 'TWORKSPACE',
      toolAllowlist: ['conversations.history'],
      toolArguments: [{ tool: 'conversations.history', arguments: ['channel', 'oldest'] }],
      probeGeneration: 2,
      waterfallPosition: 2,
      intakeSkipReason: 'temporarily skipped',
      lastPolledAt: 200,
    });
  });
});
