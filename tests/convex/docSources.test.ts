import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { STALE_SYNC_MS, agentReadsSource, validateLinkInput } from '../../convex/docSources';
import { DOCS_NOTION_LOCATOR } from '../../src/docs/components';
import { allConvexModules } from './all-modules';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
    ).not.toThrow();
  });

  it('reads every owner source except the excluded ones, honouring legacy inclusion lists', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
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
    const harness = convexTest(schema, allConvexModules()).withIdentity({ subject: 'owner' });
    await expect(
      harness.action(api.docSources.link, { label: 'Team folder', kind: 'folder', locator: '.' }),
    ).rejects.toThrow('real-mode feature');
    await expect(
      harness.action(api.docSources.link, {
        label: 'Metadata',
        kind: 'urls',
        locator: 'http://169.254.169.254/latest/meta-data/',
      }),
    ).rejects.toThrow('real-mode feature');
    await expect(harness.query(api.docSources.listMine, {})).resolves.toEqual([]);
  });

  it('refuses resync and unlink and leaves existing rows untouched', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
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
    const harness = convexTest(schema, allConvexModules());
    await seedSyncedSource(harness);
    await expect(harness.query(internal.docSources.listSyncable, {})).resolves.toEqual([]);
  });
});

describe('documentation components a source depends on', (): void => {
  it('refuses a Notion link when day0 is not running the Notion component', async (): Promise<void> => {
    useSurfaceMode('real');
    const reach = vi.fn(async (): Promise<Response> => {
      throw new Error('fetch failed');
    });
    vi.stubGlobal('fetch', reach);
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.action(api.docSources.link, {
        label: 'RevOps handbook',
        kind: 'mcp',
        locator: DOCS_NOTION_LOCATOR,
        serverKind: 'notion',
        credential: 'ntn_secret',
      }),
    ).rejects.toThrow('the Notion documentation component is not running');
    expect(reach).toHaveBeenCalled();
    // Nothing half-linked, and no credential stored for a source that does not exist.
    await expect(owner.query(api.docSources.listMine, {})).resolves.toEqual([]);
    const credentials = await harness.run(async (ctx) => await ctx.db.query('credentials').collect());
    expect(credentials).toEqual([]);
  });

  it('links a folder source with no component running at all', async (): Promise<void> => {
    useSurfaceMode('real');
    const reach = vi.fn(async (): Promise<Response> => {
      throw new Error('fetch failed');
    });
    vi.stubGlobal('fetch', reach);
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.action(api.docSources.link, { label: 'Team folder', kind: 'folder', locator: '.' }),
    ).resolves.toBeDefined();
    expect(reach).not.toHaveBeenCalled();
  });

  it('reports the linked kinds without a locator, label or secret', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    await harness.run(async (ctx): Promise<void> => {
      for (const source of [
        { label: 'Team folder', kind: 'folder' as const, locator: '.' },
        { label: 'Runbooks', kind: 'folder' as const, locator: 'runbooks' },
        {
          label: 'RevOps handbook',
          kind: 'mcp' as const,
          locator: DOCS_NOTION_LOCATOR,
          serverKind: 'notion' as const,
        },
      ]) {
        await ctx.db.insert('docSources', {
          userId: 'owner',
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
          ...source,
        });
      }
    });
    const kinds = await harness.query(internal.docSources.linkedKinds, {});
    expect(kinds).toEqual([
      { kind: 'folder', serverKind: undefined, count: 2 },
      { kind: 'mcp', serverKind: 'notion', count: 1 },
    ]);
    expect(JSON.stringify(kinds)).not.toContain('runbooks');
  });
});

describe('documentation sources in real mode', (): void => {
  it('links and lists only the caller-owned source', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const sourceId = await owner.action(api.docSources.link, {
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

  it('persists only a credential id on an authenticated source', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Notion handbook',
      kind: 'mcp',
      locator: 'http://notion-mcp:3000/mcp',
      serverKind: 'notion',
    });
    const credentialId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'value',
          label: 'Notion handbook connection secret',
          ciphertext: 'encrypted',
          iv: 'iv',
          source: 'entered',
          createdAt: 1,
        }),
    );
    await harness.mutation(internal.docSources.attachCredential, {
      sourceId,
      userId: 'owner',
      credentialId,
    });
    const source = await harness.query(internal.docSources.getInternal, { sourceId });
    expect(source).toMatchObject({ credentialId });
    expect(source).not.toHaveProperty('credential');
    expect(source).not.toHaveProperty('ciphertext');
  });

  it('unlinks stored pages and per-agent mirrors together', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
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
    const harness = convexTest(schema, allConvexModules());
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
    const harness = convexTest(schema, allConvexModules());
    const { sourceId } = await seedSyncedSource(harness);
    await expect(harness.query(internal.docSources.listSyncable, {})).resolves.toMatchObject([
      { _id: sourceId },
    ]);
  });

  it('keeps stale pages through continuations and deletes them only on the fenced final batch', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { sourceId } = await seedSyncedSource(harness);
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.upsertPage, {
      sourceId,
      ref: 'new-one.md',
      title: 'New one',
      markdown: '# New one',
      updatedAt: 2,
    });
    await expect(
      harness.mutation(internal.docSources.recordSyncBatch, {
        sourceId,
        runId,
        nextCursor: 'page-25',
        refs: ['new-one.md'],
        credentialRefs: ['new-one.md'],
        pageCount: 1,
        redactionCount: 1,
      }),
    ).resolves.toBe(true);
    await expect(rowsForSource(harness, sourceId)).resolves.toMatchObject({ pages: 2 });
    await harness.mutation(internal.docSources.upsertPage, {
      sourceId,
      ref: 'new-two.md',
      title: 'New two',
      markdown: '# New two',
      updatedAt: 2,
    });
    await expect(
      harness.mutation(internal.docSources.finishSync, {
        sourceId,
        runId,
        currentCursor: 'page-25',
        refs: ['new-two.md'],
        credentialRefs: [],
        pageCount: 1,
        redactionCount: 0,
      }),
    ).resolves.toMatchObject({ completed: true, pages: 2, redactions: 1 });
    const pages = await harness.query(internal.docSources.pagesForSourceInternal, { sourceId });
    expect(pages.map((page) => page.ref).sort()).toEqual(['new-one.md', 'new-two.md']);
    const source = await harness.query(internal.docSources.getInternal, { sourceId });
    expect(source).toMatchObject({ status: 'synced' });
    expect(source).not.toHaveProperty('activeSyncId');
    const credentialId = await harness.run(
      async (ctx): Promise<Id<'credentials'>> =>
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'value',
          label: 'linear service token',
          ciphertext: 'encrypted',
          iv: 'iv',
          source: { sourceId, ref: 'new-one.md' },
          createdAt: 1,
        }),
    );
    const replacementRunId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.finishSync, {
      sourceId,
      runId: replacementRunId,
      refs: ['new-one.md', 'new-two.md'],
      credentialRefs: [],
      pageCount: 2,
      redactionCount: 0,
    });
    const credential = await harness.run(async (ctx) => await ctx.db.get(credentialId));
    expect(credential?.revokedAt).toEqual(expect.any(Number));
  });

  it('skips a source mid-sync and restarts one whose generation stopped progressing', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T10:00:00Z'));
    const harness = convexTest(schema, allConvexModules());
    const { sourceId } = await seedSyncedSource(harness);
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await expect(harness.query(internal.docSources.listSyncable, {})).resolves.toEqual([]);
    vi.setSystemTime(new Date('2026-08-26T10:25:00Z'));
    await expect(
      harness.mutation(internal.docSources.recordSyncBatch, {
        sourceId,
        runId,
        nextCursor: '25',
        refs: [],
        credentialRefs: [],
        pageCount: 25,
        redactionCount: 0,
      }),
    ).resolves.toBe(true);
    vi.setSystemTime(new Date('2026-08-26T10:40:00Z'));
    await expect(harness.query(internal.docSources.listSyncable, {})).resolves.toEqual([]);
    vi.setSystemTime(new Date(Date.parse('2026-08-26T10:25:00Z') + STALE_SYNC_MS + 1));
    const stale = await harness.query(internal.docSources.listSyncable, {});
    expect(stale.map((source) => source._id)).toEqual([sourceId]);
    const replacementRunId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    expect(replacementRunId).not.toBe(runId);
    await expect(
      harness.query(internal.docSources.syncContext, { sourceId, runId }),
    ).resolves.toBeNull();
    const dead = await harness.run(async (ctx) => await ctx.db.get(runId));
    expect(dead?.state).toBe('superseded');
  });
});
