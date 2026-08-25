import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import { agentReadsSource, validateLinkInput } from '../../convex/docSources';
import { convexModules } from './modules';

afterEach((): void => {
  vi.useRealTimers();
});

describe('documentation sources', (): void => {
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

  it('links and lists only the caller-owned source', async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, convexModules).withIdentity({ subject: 'owner' });
    const sourceId = await harness.mutation(api.docSources.link, {
      label: 'Team folder',
      kind: 'folder',
      locator: '.',
    });
    const sources = await harness.query(api.docSources.listMine, {});
    expect(sources).toMatchObject([{ _id: sourceId, status: 'linking', pageCount: 0 }]);
  });

  it('unlinks stored pages and per-agent mirrors together', async (): Promise<void> => {
    const harness = convexTest(schema, convexModules).withIdentity({ subject: 'owner' });
    const ids = await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Folder',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'unlink test',
        userId: 'owner',
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
    await expect(
      harness.mutation(api.docSources.unlink, { sourceId: ids.sourceId }),
    ).resolves.toEqual({
      pages: 1,
      mirrors: 1,
    });
    expect(await harness.run(async (ctx) => await ctx.db.get(ids.sourceId))).toBeNull();
  });

  it('treats an empty selection as all and a non-empty selection as explicit', async (): Promise<void> => {
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
        selectedFirst: agentReadsSource({ ...base, docSourceIds: [first] }, first),
        rejectedSecond: agentReadsSource({ ...base, docSourceIds: [first] }, second),
      };
    });
    expect(result).toEqual({ all: true, selectedFirst: true, rejectedSecond: false });
  });
});
