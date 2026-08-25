import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { agentReadsSource, validateLinkInput } from '../../convex/docSources';
import { convexModules } from './modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

afterEach((): void => {
  vi.useRealTimers();
  restoreSurfaceMode();
});

/**
 * Seed one synced owner-level source with a page and a per-agent mirror.
 *
 * Args:
 *   harness: Convex test harness.
 *   userId: Owner subject.
 *
 * Returns:
 *   Ids of the seeded source and agent.
 */
async function seedSyncedSource(
  harness: TestConvex<typeof schema>,
  userId = 'owner',
): Promise<{ sourceId: Id<'docSources'>; agentId: Id<'agents'> }> {
  return await harness.run(async (ctx) => {
    const sourceId = await ctx.db.insert('docSources', {
      userId,
      label: 'Folder',
      kind: 'folder',
      locator: '.',
      status: 'synced',
      createdAt: 1,
      updatedAt: 1,
    });
    const agentId = await ctx.db.insert('agents', {
      bossEmail: 'boss@day0.local',
      name: 'source test',
      userId,
      state: 'deployed',
      createdAt: 1,
    });
    await ctx.db.insert('docPages', {
      sourceId,
      ref: 'page.md',
      title: 'Page',
      markdown: '# Page',
      updatedAt: 1,
    });
    await ctx.db.insert('mockDocs', {
      agentId,
      slug: 'source-page',
      title: 'Page',
      body: '# Page',
      category: 'team-doc',
      sourceId,
      sourceRef: 'page.md',
      updatedAt: 1,
    });
    return { sourceId, agentId };
  });
}

/**
 * Count the stored pages and mirrors that still point at a source.
 *
 * Args:
 *   harness: Convex test harness.
 *   sourceId: Source under test.
 *
 * Returns:
 *   Remaining `docPages` and `mockDocs` row counts.
 */
async function rowsForSource(
  harness: TestConvex<typeof schema>,
  sourceId: Id<'docSources'>,
): Promise<{ pages: number; mirrors: number; source: boolean }> {
  return await harness.run(async (ctx) => {
    const pages = await ctx.db
      .query('docPages')
      .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
      .collect();
    const mirrors = await ctx.db
      .query('mockDocs')
      .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
      .collect();
    return {
      pages: pages.length,
      mirrors: mirrors.length,
      source: (await ctx.db.get(sourceId)) !== null,
    };
  });
}

describe('documentation source validation', (): void => {
  it('validates kind-specific source fields', (): void => {
    expect(
      validateLinkInput({ label: ' Team docs ', kind: 'folder', locator: ' runbooks ' }),
    ).toEqual({ label: 'Team docs', kind: 'folder', locator: 'runbooks' });
    expect(() =>
      validateLinkInput({ label: 'Private', kind: 'folder', locator: '../private' }),
    ).toThrow('stay inside');
    expect(() =>
      validateLinkInput({
        label: 'Notion',
        kind: 'mcp',
        locator: 'http://notion-mcp:3000/mcp',
        serverKind: 'notion',
      }),
    ).toThrow('uppercase environment variable');
  });

  it('reads every owner source except the excluded ones, honouring legacy inclusion lists', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules);
    const result = await harness.run(async (ctx) => {
      const first = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'First',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const second = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Second',
        kind: 'folder',
        locator: 'second',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const base = {
        _id: 'agent' as never,
        _creationTime: 1,
        bossEmail: 'boss@day0.local',
        name: 'test',
        userId: 'owner',
        state: 'deployed' as const,
        createdAt: 1,
      };
      return {
        all: agentReadsSource(base, second),
        excludedSecond: agentReadsSource({ ...base, excludedDocSourceIds: [second] }, second),
        keptFirst: agentReadsSource({ ...base, excludedDocSourceIds: [second] }, first),
        legacySelectedFirst: agentReadsSource({ ...base, docSourceIds: [first] }, first),
        legacyRejectedSecond: agentReadsSource({ ...base, docSourceIds: [first] }, second),
        legacyEmptyMeansAll: agentReadsSource({ ...base, docSourceIds: [] }, second),
      };
    });
    expect(result).toEqual({
      all: true,
      excludedSecond: false,
      keptFirst: true,
      legacySelectedFirst: true,
      legacyRejectedSecond: false,
      legacyEmptyMeansAll: true,
    });
  });
});

describe('documentation sources in mock mode', (): void => {
  it('refuses to link any location, including link-local metadata URLs', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, convexModules).withIdentity({ subject: 'owner' });
    await expect(
      harness.mutation(api.docSources.link, { label: 'Team folder', kind: 'folder', locator: '.' }),
    ).rejects.toThrow('real-mode feature');
    await expect(
      harness.mutation(api.docSources.link, {
        label: 'Metadata',
        kind: 'urls',
        locator: 'http://169.254.169.254/latest/meta-data/',
      }),
    ).rejects.toThrow('real-mode feature');
    await expect(harness.query(api.docSources.listMine, {})).resolves.toEqual([]);
  });

  it('refuses resync and unlink and leaves existing rows untouched', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, convexModules);
    const { sourceId } = await seedSyncedSource(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(owner.mutation(api.docSources.resync, { sourceId })).rejects.toThrow(
      'real-mode feature',
    );
    await expect(owner.mutation(api.docSources.unlink, { sourceId })).rejects.toThrow(
      'real-mode feature',
    );
    await expect(rowsForSource(harness, sourceId)).resolves.toEqual({
      pages: 1,
      mirrors: 1,
      source: true,
    });
  });

  it('leaves the periodic sync with nothing to do', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, convexModules);
    await seedSyncedSource(harness);
    await expect(harness.query(internal.docSources.listSyncable, {})).resolves.toEqual([]);
  });
});

describe('documentation sources in real mode', (): void => {
  it('links and lists only the caller-owned source', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, convexModules);
    const owner = harness.withIdentity({ subject: 'owner' });
    const sourceId = await owner.mutation(api.docSources.link, {
      label: 'Team folder',
      kind: 'folder',
      locator: '.',
    });
    const sources = await owner.query(api.docSources.listMine, {});
    expect(sources).toMatchObject([{ _id: sourceId, status: 'linking', pageCount: 0 }]);
    await expect(
      harness.withIdentity({ subject: 'other-owner' }).query(api.docSources.listMine, {}),
    ).resolves.toEqual([]);
  });

  it('unlinks stored pages and per-agent mirrors together', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, convexModules);
    const { sourceId } = await seedSyncedSource(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(owner.mutation(api.docSources.unlink, { sourceId })).resolves.toEqual({
      pages: 1,
      mirrors: 1,
    });
    await expect(rowsForSource(harness, sourceId)).resolves.toEqual({
      pages: 0,
      mirrors: 0,
      source: false,
    });
  });

  it('refuses resync and unlink of a source owned by another caller', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, convexModules);
    const { sourceId } = await seedSyncedSource(harness, 'owner');
    const other = harness.withIdentity({ subject: 'other-owner' });
    await expect(other.mutation(api.docSources.resync, { sourceId })).rejects.toThrow('not found');
    await expect(other.mutation(api.docSources.unlink, { sourceId })).rejects.toThrow('not found');
    await expect(other.query(api.docSources.byIds, { sourceIds: [sourceId] })).resolves.toEqual([]);
    await expect(rowsForSource(harness, sourceId)).resolves.toEqual({
      pages: 1,
      mirrors: 1,
      source: true,
    });
  });

  it('schedules synced sources for the periodic resync', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, convexModules);
    const { sourceId } = await seedSyncedSource(harness);
    await expect(harness.query(internal.docSources.listSyncable, {})).resolves.toMatchObject([
      { _id: sourceId },
    ]);
  });
});
