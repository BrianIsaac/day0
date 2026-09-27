import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  FINISHING_CURSOR,
  RUN_HISTORY_MS,
  STALE_SYNC_MS,
  agentReadsSource,
  validateLinkInput,
  validateReaderSecret,
} from '../../convex/docSources';
import { DOCS_NOTION_LOCATOR } from '../../src/docs/components';
import { allConvexModules } from './all-modules';
import { mirroredDocSlug } from '../../src/docs/types';
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

/** The first page of a paged read, as the tests read a small table. */
const FIRST_PAGE = { paginationOpts: { numItems: 100, cursor: null } };

/**
 * Record a generation's last batch and finish it the way the sync action does:
 * the stale pages and mirrors are pruned, the intake scopes re-read, and the
 * generation completed. The test must run on fake timers, since the finish
 * schedules discovery and re-orientation.
 *
 * Returns:
 *   What the finishing sync step reported.
 */
async function finishGeneration(
  harness: TestConvex<typeof schema>,
  sourceId: Id<'docSources'>,
  runId: Id<'docSyncRuns'>,
  last: {
    currentCursor?: string;
    refs: string[];
    credentialRefs: string[];
    pageCount: number;
    redactionCount: number;
  },
): Promise<unknown> {
  await harness.mutation(internal.docSources.recordSyncBatch, {
    sourceId,
    runId,
    nextCursor: FINISHING_CURSOR,
    ...last,
  });
  return await harness.action(internal.docSyncActions.syncBatch, {
    sourceId,
    runId,
    cursor: FINISHING_CURSOR,
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

  it('refuses a user name or token in every remote locator, and never repeats it', (): void => {
    for (const [kind, locator] of [
      ['git', 'https://oauth2:glpat-abc@git.corp.internal/team/docs#main'],
      ['git', 'https://ghp_secret123@github.com/example/docs'],
      ['urls', 'https://docs.example.com/a\nhttps://deploy:hunter2@docs.example.com/b'],
      ['mcp', 'https://svc:hunter2@docs.example.com/mcp'],
      ['git', 'https://ghp_secret123#en@github.com/org/docs#main'],
      ['urls', 'https://hunter2#x@docs.example.com/page'],
    ] as const) {
      let message = '';
      try {
        validateLinkInput({
          label: 'Docs',
          kind,
          locator,
          ...(kind === 'mcp' ? { serverKind: 'confluence' as const } : {}),
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, locator).toContain('must not carry a user name or password');
      for (const secret of ['glpat-abc', 'ghp_secret123', 'hunter2', 'oauth2', 'deploy', 'svc']) {
        expect(message).not.toContain(secret);
      }
    }
  });

  it("refuses a plain HTTP MCP locator except Day0's own component, before a secret is stored (M16)", (): void => {
    const mcp = (locator: string) => (): unknown =>
      validateLinkInput({ label: 'Docs', kind: 'mcp', locator, serverKind: 'confluence' });
    expect(mcp('http://docs.example.com/mcp')).toThrow('must use HTTPS');
    // The component's host under another server kind is not the component.
    expect(mcp('http://docs-notion-mcp:3000/mcp')).toThrow('must use HTTPS');
    expect(mcp('https://docs.example.com/mcp')).not.toThrow();
    expect(() =>
      validateLinkInput({
        label: 'Notion',
        kind: 'mcp',
        locator: 'http://docs-notion-mcp:3000/mcp',
        serverKind: 'notion',
      }),
    ).not.toThrow();
  });

  it('reads every owner source except the excluded ones', async (): Promise<void> => {
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
      };
    });
    expect(result).toEqual({
      all: true,
      excludedSecond: false,
      keptFirst: true,
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
    await expect(
      harness.query(internal.docSources.listSyncable, FIRST_PAGE),
    ).resolves.toMatchObject({ page: [], isDone: true });
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
    const credentials = await harness.run(
      async (ctx) => await ctx.db.query('credentials').collect(),
    );
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
        {
          label: 'Enterprise Notion proxy',
          kind: 'mcp' as const,
          locator: 'https://notion.internal.example/mcp',
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
      { kind: 'folder', serverKind: undefined, component: undefined, count: 2 },
      { kind: 'mcp', serverKind: 'notion', component: undefined, count: 1 },
      {
        kind: 'mcp',
        serverKind: 'notion',
        component: 'docs-notion-mcp',
        count: 1,
      },
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

  it('refuses a git locator carrying a token at link, so no row stores it', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(
      owner.action(api.docSources.link, {
        label: 'Runbooks',
        kind: 'git',
        locator: 'https://oauth2:glpat-abc@github.com/team/docs#main',
      }),
    ).rejects.toThrow('must not carry a user name or password');
    await expect(owner.query(api.docSources.listMine, {})).resolves.toEqual([]);
  });

  it('stores a private repository’s reader secret as a credential, never in the locator (E-74)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
    const secret = ['ghp', 'readerContractValue0123456789'].join('_');
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity({ subject: 'owner' });
    const sourceId = await owner.action(api.docSources.link, {
      label: 'Runbooks',
      kind: 'git',
      locator: 'https://github.com/team/private-docs#main',
      credential: secret,
    });
    const { source, credential } = await harness.run(async (ctx) => {
      const source = await ctx.db.get(sourceId);
      return {
        source,
        credential: source?.credentialId ? await ctx.db.get(source.credentialId) : null,
      };
    });
    expect(source).toMatchObject({
      kind: 'git',
      locator: 'https://github.com/team/private-docs#main',
      credentialId: credential?._id,
    });
    expect(credential).toMatchObject({ label: 'Runbooks reader secret', source: 'entered' });
    expect(JSON.stringify({ source, credential })).not.toContain(secret);
    await expect(
      harness.action(internal.credentials.decrypt, { credentialId: credential!._id }),
    ).resolves.toBe(secret);
    vi.unstubAllEnvs();
  });

  it('refuses a reader secret a source cannot keep to one https site, and a folder’s (E-74)', (): void => {
    const folder = validateLinkInput({ label: 'Folder', kind: 'folder', locator: '.' });
    expect(() => validateReaderSecret(folder, 'value')).toThrow('takes no secret');
    const twoSites = validateLinkInput({
      label: 'Wiki',
      kind: 'urls',
      locator: 'https://wiki.example/a\nhttps://other.example/b',
    });
    expect(() => validateReaderSecret(twoSites, 'value')).toThrow('one https site');
    const plaintext = validateLinkInput({
      label: 'Wiki',
      kind: 'urls',
      locator: 'http://wiki.example/a',
    });
    expect(() => validateReaderSecret(plaintext, 'value')).toThrow('one https site');
    const oneSite = validateLinkInput({
      label: 'Wiki',
      kind: 'urls',
      locator: 'https://wiki.example/a\nhttps://wiki.example/b',
    });
    expect(() => validateReaderSecret(oneSite, 'value')).not.toThrow();
    expect(() => validateReaderSecret(oneSite, undefined)).not.toThrow();
    expect(() => validateReaderSecret(oneSite, '')).toThrow('cannot be empty');
    expect(() => validateReaderSecret(oneSite, 'first\nsecond')).toThrow('line break');
    const mcp = validateLinkInput({
      label: 'Notion',
      kind: 'mcp',
      serverKind: 'generic',
      locator: 'https://mcp.example/mcp',
    });
    expect(() => validateReaderSecret(mcp, undefined)).toThrow('Connection secret is required');
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
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId } = await seedSyncedSource(harness);
    const owner = harness.withIdentity({ subject: 'owner' });
    await expect(owner.mutation(api.docSources.unlink, { sourceId })).resolves.toBeNull();
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    await expect(rowsForSource(harness, sourceId)).resolves.toEqual({
      pages: 0,
      mirrors: 0,
      source: false,
    });
  });

  it('deletes the ciphertext of every credential an unlink revokes and keeps the row', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { sourceId } = await seedSyncedSource(harness);
    const { discovered, connection, typed } = await harness.run(async (ctx) => {
      const base = {
        userId: 'owner',
        kind: 'value' as const,
        ciphertext: 'sealed',
        iv: 'iv',
        createdAt: 1,
      };
      const connection = await ctx.db.insert('credentials', {
        ...base,
        label: 'notion integration token',
        source: 'entered',
      });
      await ctx.db.patch(sourceId, { credentialId: connection });
      return {
        discovered: await ctx.db.insert('credentials', {
          ...base,
          label: 'linear service token',
          source: { sourceId, ref: 'linear-automation' },
        }),
        connection,
        typed: await ctx.db.insert('credentials', {
          ...base,
          label: 'typed elsewhere',
          source: 'entered',
        }),
      };
    });
    await harness.withIdentity({ subject: 'owner' }).mutation(api.docSources.unlink, { sourceId });
    for (const id of [discovered, connection]) {
      const row = await harness.run(async (ctx) => await ctx.db.get(id));
      expect(row).toMatchObject({ userId: 'owner', revokedAt: expect.any(Number) });
      expect(row?.label).toBeTruthy();
      expect(row).not.toHaveProperty('ciphertext');
      expect(row).not.toHaveProperty('iv');
    }
    // A credential the source never held is not the unlink's to touch.
    expect(await harness.run(async (ctx) => await ctx.db.get(typed))).toMatchObject({
      ciphertext: 'sealed',
      iv: 'iv',
    });
  });

  it('retires a discovered system as history and keeps its approved surface', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, agentId } = await seedSyncedSource(harness);
    const surfaceId = await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      await ctx.db.insert('docSystemDiscoveries', {
        sourceId,
        slug: 'northstar-crm',
        displayName: 'Northstar CRM',
        class: 'crm',
        ref: 'systems/northstar-crm.md',
        quote: '# Northstar CRM',
        current: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      return await ctx.db.insert('surfaces', {
        agentId,
        slug: 'northstar-crm',
        displayName: 'Northstar CRM',
        class: 'crm',
        verdict: 'approved',
        path: 'documented-api',
        endpoint: 'https://northstar.example/api',
        whereFound: [{ ref: 'systems/northstar-crm.md', quote: '# Northstar CRM' }],
        discoveryEvidence: [
          {
            kind: 'documentation',
            sourceId,
            ref: 'systems/northstar-crm.md',
            quote: '# Northstar CRM',
            current: true,
            firstSeenAt: 1,
            lastSeenAt: 1,
          },
        ],
        credentialLanded: true,
        createdAt: 1,
      });
    });

    const owner = harness.withIdentity({ subject: 'owner' });
    await owner.mutation(api.docSources.unlink, { sourceId });

    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    // The row survives as an audit row with its authority intact; only the
    // provenance that justified it becomes history.
    expect(surface).toMatchObject({
      verdict: 'approved',
      path: 'documented-api',
      endpoint: 'https://northstar.example/api',
    });
    expect(surface?.discoveryEvidence).toMatchObject([
      { kind: 'documentation', sourceId, current: false },
    ]);
    await expect(
      harness.run(async (ctx) => await ctx.db.query('docSystemDiscoveries').collect()),
    ).resolves.toEqual([]);
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
    await expect(
      harness.query(internal.docSources.listSyncable, FIRST_PAGE),
    ).resolves.toMatchObject({ page: [{ _id: sourceId }] });
  });

  it('keeps stale pages through continuations and deletes them only on the fenced final batch', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId } = await seedSyncedSource(harness);
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.upsertPage, {
      sourceId,
      syncRunId: runId,
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
      syncRunId: runId,
      ref: 'new-two.md',
      title: 'New two',
      markdown: '# New two',
      updatedAt: 2,
    });
    await expect(
      finishGeneration(harness, sourceId, runId, {
        currentCursor: 'page-25',
        refs: ['new-two.md'],
        credentialRefs: [],
        pageCount: 1,
        redactionCount: 0,
      }),
    ).resolves.toMatchObject({ ok: true, complete: true, pages: 2, redactions: 1 });
    const pages = await harness.query(internal.docSources.pagesForSourceInternal, {
      sourceId,
      ...FIRST_PAGE,
    });
    expect(pages.page.map((page) => page.ref).sort()).toEqual(['new-one.md', 'new-two.md']);
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
    expect(credential?.status).toBe('superseded');
    expect(credential?.revokedAt).toBeUndefined();
  });

  it('records on each run why it ended short, and what a completed one changed (U8 D1 (b))', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId } = await seedSyncedSource(harness);
    const superseded = await harness.mutation(internal.docSources.beginSync, { sourceId });
    const failed = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.failSync, {
      sourceId,
      runId: failed,
      status: 'error',
      reason: 'The documentation read was interrupted (timeout).',
    });
    const completed = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.upsertPage, {
      sourceId,
      syncRunId: completed,
      ref: 'fresh.md',
      title: 'Fresh',
      markdown: '# Fresh',
      updatedAt: 2,
    });
    await finishGeneration(harness, sourceId, completed, {
      refs: ['fresh.md'],
      credentialRefs: [],
      pageCount: 1,
      redactionCount: 0,
    });
    const runs = await harness.run(
      async (ctx) => await Promise.all([superseded, failed, completed].map((id) => ctx.db.get(id))),
    );
    expect(runs.map((run) => [run?.state, run?.reason ?? null])).toEqual([
      ['superseded', 'a newer sync of the source started before this one finished'],
      ['error', 'The documentation read was interrupted (timeout).'],
      ['completed', null],
    ]);
    expect(runs[2]?.summary).toEqual({
      pagesKept: 1,
      pagesRemoved: 1,
      mirrorsRemoved: 1,
      credentialsSuperseded: 0,
      surfacesToReapprove: 0,
    });
  });

  it('deletes a mirror an earlier slug rule keyed, once the sync has mirrored the page under its own (review M20)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, agentId } = await seedSyncedSource(harness);
    await harness.run(async (ctx) => {
      await ctx.db.insert('mockDocs', {
        agentId,
        slug: `source-${String(sourceId).slice(-10).toLowerCase()}-caf-md`,
        title: 'Café, as v0.4.0 keyed it',
        body: '# Café',
        category: 'team-doc',
        sourceId,
        sourceRef: 'Café.md',
        updatedAt: 1,
      });
    });
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.upsertPage, {
      sourceId,
      syncRunId: runId,
      ref: 'Café.md',
      title: 'Café',
      markdown: '# Café',
      updatedAt: 2,
    });
    await harness.mutation(internal.mock.upsertDoc, {
      syncRunId: runId,
      agentId,
      slug: mirroredDocSlug(sourceId, 'Café.md'),
      title: 'Café',
      body: '# Café',
      category: 'team-doc',
      sourceId,
      sourceRef: 'Café.md',
    });
    await finishGeneration(harness, sourceId, runId, {
      refs: ['Café.md'],
      credentialRefs: [],
      pageCount: 1,
      redactionCount: 0,
    });
    const mirrors = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('mockDocs')
          .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
          .collect(),
    );
    expect(mirrors.map((mirror) => mirror.slug)).toEqual([mirroredDocSlug(sourceId, 'Café.md')]);
  });

  it('keeps an old-slug mirror while it is the only copy of a listed page the sync could not read (adversarial pass)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, agentId } = await seedSyncedSource(harness);
    const oldSlug = `source-${String(sourceId).slice(-10).toLowerCase()}-caf-md`;
    await harness.run(async (ctx) => {
      await ctx.db.insert('mockDocs', {
        agentId,
        slug: oldSlug,
        title: 'Café, as v0.4.0 keyed it',
        body: '# Café',
        category: 'team-doc',
        sourceId,
        sourceRef: 'Café.md',
        updatedAt: 1,
      });
    });
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await finishGeneration(harness, sourceId, runId, {
      refs: ['page.md', 'Café.md'],
      credentialRefs: [],
      pageCount: 1,
      redactionCount: 0,
    });
    const mirrors = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('mockDocs')
          .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
          .collect(),
    );
    expect(mirrors.map((mirror) => mirror.slug)).toContain(oldSlug);
  });

  it('returns a connected card to proposal when its approved queue line changes', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, agentId } = await seedSyncedSource(harness);
    // The page as an earlier sync left it.
    await harness.run(async (ctx) => {
      const page = await ctx.db
        .query('docPages')
        .withIndex('by_source_ref', (q) => q.eq('sourceId', sourceId).eq('ref', 'page.md'))
        .unique();
      await ctx.db.patch(page!._id, {
        title: 'Finance handbook',
        markdown: '- Channels: #finance-close',
        updatedAt: 2,
      });
    });
    const surfaceId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'slack',
          displayName: 'Slack',
          class: 'chat',
          verdict: 'connected',
          credentialLanded: true,
          whereFound: [],
          createdAt: 1,
          managerApprovedAt: 2,
          itApprovedAt: 3,
          probeGeneration: 4,
          intakeScope: {
            channels: [
              {
                value: 'finance-close',
                sourceId,
                ref: 'page.md',
                quote: '- Channels: #finance-close',
              },
            ],
          },
        }),
    );
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.upsertPage, {
      sourceId,
      syncRunId: runId,
      ref: 'page.md',
      title: 'Finance handbook',
      markdown: '- Channels: #ops-requests',
      updatedAt: 3,
    });
    await finishGeneration(harness, sourceId, runId, {
      refs: ['page.md'],
      credentialRefs: [],
      pageCount: 1,
      redactionCount: 0,
    });
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({ verdict: 'proposed', probeGeneration: 5 });
    expect(surface?.managerApprovedAt).toBeUndefined();
    expect(surface?.itApprovedAt).toBeUndefined();
    expect(surface?.intakeScope?.channels?.[0].value).toBe('finance-close');
    await expect(
      harness.withIdentity({ subject: 'owner' }).mutation(api.surfaces.approve, {
        surfaceId,
        role: 'manager',
      }),
    ).rejects.toThrow('re-run orientation');
  });

  it('keeps a connected card connected when its queue page is renamed or the line is reflowed, and re-points its quote', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, agentId } = await seedSyncedSource(harness);
    const surfaceId = await harness.run(
      async (ctx) =>
        await ctx.db.insert('surfaces', {
          agentId,
          slug: 'slack',
          displayName: 'Slack',
          class: 'chat',
          verdict: 'connected',
          credentialLanded: true,
          whereFound: [],
          createdAt: 1,
          managerApprovedAt: 2,
          itApprovedAt: 3,
          probeGeneration: 4,
          managerDmChannelId: 'D1',
          // The team's handbook is renamed within the team's directory; a
          // one-value scope follows a gone page only there (review M15).
          intakeScope: {
            channels: [
              {
                value: 'finance-close',
                sourceId,
                ref: 'finance/handbook.md',
                quote: '- Channels: #finance-close',
              },
            ],
          },
        }),
    );
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.upsertPage, {
      sourceId,
      syncRunId: runId,
      ref: 'finance/team.md',
      title: 'Finance handbook',
      markdown: '- Channels:  #finance-close,  #ops-requests',
      updatedAt: 3,
    });
    await finishGeneration(harness, sourceId, runId, {
      refs: ['finance/team.md'],
      credentialRefs: [],
      pageCount: 1,
      redactionCount: 0,
    });
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({
      verdict: 'connected',
      probeGeneration: 4,
      managerApprovedAt: 2,
      managerDmChannelId: 'D1',
    });
    expect(surface?.intakeScope?.channels).toEqual([
      {
        value: 'finance-close',
        sourceId,
        ref: 'finance/team.md',
        quote: '- Channels:  #finance-close,  #ops-requests',
      },
    ]);
  });

  it('skips a source mid-sync and restarts one whose generation stopped progressing', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T10:00:00Z'));
    const harness = convexTest(schema, allConvexModules());
    const { sourceId } = await seedSyncedSource(harness);
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await expect(
      harness.query(internal.docSources.listSyncable, FIRST_PAGE),
    ).resolves.toMatchObject({ page: [] });
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
    await expect(
      harness.query(internal.docSources.listSyncable, FIRST_PAGE),
    ).resolves.toMatchObject({ page: [] });
    vi.setSystemTime(new Date(Date.parse('2026-08-26T10:25:00Z') + STALE_SYNC_MS + 1));
    const stale = await harness.query(internal.docSources.listSyncable, FIRST_PAGE);
    expect(stale.page.map((source) => source._id)).toEqual([sourceId]);
    const replacementRunId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    expect(replacementRunId).not.toBe(runId);
    await expect(
      harness.query(internal.docSources.syncContext, { sourceId, runId }),
    ).resolves.toBeNull();
    const dead = await harness.run(async (ctx) => await ctx.db.get(runId));
    expect(dead?.state).toBe('superseded');
    // The action the runtime killed read 25 pages; the new run reads on from there (step 17).
    expect(dead?.reason).toBe(
      'a newer sync of the source took over from its cursor after 25 pages',
    );
    await expect(
      harness.query(internal.docSources.syncContext, { sourceId, runId: replacementRunId }),
    ).resolves.toMatchObject({ run: { cursor: '25', pageCount: 25, state: 'running' } });
  });

  it('starts a sync from page one for a new secret, and after a resume that got no further (step 17)', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { sourceId } = await seedSyncedSource(harness);
    const failAt = async (runId: Id<'docSyncRuns'>): Promise<void> => {
      await harness.mutation(internal.docSources.failSync, {
        sourceId,
        runId,
        status: 'error',
        reason: 'The documentation read was interrupted (timeout).',
      });
    };
    const first = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.recordSyncBatch, {
      sourceId,
      runId: first,
      nextCursor: '25',
      refs: ['page.md'],
      credentialRefs: [],
      pageCount: 25,
      redactionCount: 0,
    });
    await failAt(first);
    const context = async (runId: Id<'docSyncRuns'>) =>
      (await harness.query(internal.docSources.syncContext, { sourceId, runId }))?.run;

    const rotated = await harness.mutation(internal.docSources.beginSync, {
      sourceId,
      fresh: true,
    });
    expect(await context(rotated)).toMatchObject({ refs: [], pageCount: 0 });
    expect((await context(rotated))?.cursor).toBeUndefined();
    await failAt(rotated);

    // The fresh run failed before its first batch: nothing to carry.
    const second = await harness.mutation(internal.docSources.beginSync, { sourceId });
    expect((await context(second))?.cursor).toBeUndefined();
    await harness.mutation(internal.docSources.recordSyncBatch, {
      sourceId,
      runId: second,
      nextCursor: '25',
      refs: ['page.md'],
      credentialRefs: [],
      pageCount: 25,
      redactionCount: 0,
    });
    await failAt(second);
    const resumed = await harness.mutation(internal.docSources.beginSync, { sourceId });
    expect(await context(resumed)).toMatchObject({ cursor: '25', pageCount: 25 });
    await failAt(resumed);

    // The resume failed where it started: the provider may no longer take the cursor.
    const restarted = await harness.mutation(internal.docSources.beginSync, { sourceId });
    expect(await context(restarted)).toMatchObject({ refs: [], pageCount: 0 });
    expect((await context(restarted))?.cursor).toBeUndefined();
  });
});

it('supersedes missing page credentials and unbinds every dependent surface atomically', async () => {
  useSurfaceMode('real');
  const harness = convexTest(schema, allConvexModules());
  const { sourceId, agentId } = await seedSyncedSource(harness);
  const { credentialId, surfaceId, retainedId, proposedId } = await harness.run(async (ctx) => {
    const credentialId = await ctx.db.insert('credentials', {
      userId: 'owner',
      kind: 'value',
      label: 'Slack credential',
      source: { sourceId, ref: 'page.md' },
      ciphertext: 'sealed',
      iv: 'iv',
      createdAt: 1,
      status: 'suspect',
      statusReason: 'permission scope',
    });
    const retainedId = await ctx.db.insert('credentials', {
      userId: 'owner',
      kind: 'value',
      label: 'retained',
      source: { sourceId, ref: 'retained.md' },
      ciphertext: 'sealed',
      iv: 'iv',
      createdAt: 1,
    });
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'connected',
      credentialId,
      credentialKind: 'value',
      credentialLanded: true,
      whereFound: [],
      createdAt: 1,
      request: { credential: { found: 'value', method: 'bot-token', evidenceRef: 'page.md' } },
      managerApprovedAt: 2,
      itApprovedAt: 3,
      probeGeneration: 4,
      lastVerifiedAt: 5,
      toolAllowlist: ['chat.postMessage'],
      providerIdentityId: 'bot',
    });
    const proposedId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'slack-proposed',
      displayName: 'Slack proposed',
      class: 'chat',
      verdict: 'proposed',
      credentialId,
      credentialKind: 'value',
      credentialLanded: false,
      whereFound: [],
      createdAt: 1,
    });
    return { credentialId, surfaceId, retainedId, proposedId };
  });
  const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
  const finish = {
    sourceId,
    runId,
    refs: ['page.md', 'retained.md'],
    credentialRefs: ['retained.md'],
    pageCount: 2,
    redactionCount: 1,
  };
  await harness.mutation(internal.docSources.finishSync, finish);
  const superseded = await harness.query(internal.credentials.getInternal, { credentialId });
  expect(superseded).toMatchObject({ status: 'superseded' });
  // Superseded by the sync, not revoked: the same value returning revives it.
  expect(superseded).not.toHaveProperty('revokedAt');
  const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
  expect(surface).toMatchObject({
    verdict: 'ungranted',
    credentialLanded: false,
    probeGeneration: 5,
    managerApprovedAt: 2,
    itApprovedAt: 3,
    request: { credential: { found: 'location', method: 'bot-token' } },
  });
  expect(surface?.credentialId).toBeUndefined();
  expect(surface?.toolAllowlist).toBeUndefined();
  expect(surface?.lastVerifiedAt).toBeUndefined();
  expect(surface?.providerIdentityId).toBeUndefined();
  const proposed = await harness.run(async (ctx) => await ctx.db.get(proposedId));
  expect(proposed?.verdict).toBe('proposed');
  expect(proposed?.credentialId).toBeUndefined();
  expect(
    await harness.mutation(internal.surfaces.recordConnected, {
      surfaceId,
      generation: 4,
      toolAllowlist: ['chat.postMessage'],
      toolArguments: [],
      verifiedAt: 10,
    }),
  ).toBe(false);
  expect(
    await harness.query(internal.credentials.getInternal, { credentialId: retainedId }),
  ).not.toHaveProperty('status');
  await harness.mutation(internal.docSources.finishSync, finish);
  expect(await harness.run(async (ctx) => await ctx.db.get(surfaceId))).toEqual(surface);
});

describe('the sync generation fence on pages (step 14)', (): void => {
  it('refuses a page from a generation a newer sync superseded and writes the running one’s', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = convexTest(schema, allConvexModules());
    const { sourceId } = await seedSyncedSource(harness);
    const stale = await harness.mutation(internal.docSources.beginSync, { sourceId });
    const current = await harness.mutation(internal.docSources.beginSync, { sourceId });
    const page = { sourceId, ref: 'late.md', title: 'Late', markdown: '# Late', updatedAt: 2 };

    await expect(
      harness.mutation(internal.docSources.upsertPage, { ...page, syncRunId: stale }),
    ).rejects.toThrow('superseded by a newer one');
    await expect(rowsForSource(harness, sourceId)).resolves.toMatchObject({ pages: 1 });

    await harness.mutation(internal.docSources.upsertPage, { ...page, syncRunId: current });
    await harness.mutation(internal.docSources.finishSync, {
      sourceId,
      runId: current,
      refs: ['page.md', 'late.md'],
      credentialRefs: [],
      pageCount: 2,
      redactionCount: 0,
    });
    // Completed, the generation no longer writes either.
    await expect(
      harness.mutation(internal.docSources.upsertPage, { ...page, syncRunId: current }),
    ).rejects.toThrow('superseded by a newer one');
    await expect(rowsForSource(harness, sourceId)).resolves.toMatchObject({ pages: 2 });
  });
});

describe('the documentation store under the transaction limits (step 49)', (): void => {
  /** A page body of about half a mebibyte: forty of them outgrow one transaction's reads. */
  const LARGE_BODY = `# Runbook\n\n${'Follow the documented steps in order.\n'.repeat(14_000)}`;
  const LARGE_PAGES = 40;

  /** A harness that enforces Convex's per-transaction limits. */
  function limitedHarness(): TestConvex<typeof schema> {
    return convexTest({ schema, modules: allConvexModules(), transactionLimits: true });
  }

  /**
   * Seed a synced source whose pages and one employee's mirrors are each far
   * more than one transaction may read, with a completed run that lists them,
   * an approved chat scope quoting `handbook.md`, and a documented system.
   */
  async function largeSource(harness: TestConvex<typeof schema>): Promise<{
    sourceId: Id<'docSources'>;
    agentId: Id<'agents'>;
    surfaceId: Id<'surfaces'>;
  }> {
    const { sourceId, agentId } = await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Large handbook',
        kind: 'folder',
        locator: '.',
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
      const agentId = await ctx.db.insert('agents', {
        bossEmail: 'boss@day0.local',
        name: 'large source test',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
      });
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'handbook.md',
        title: 'Handbook',
        markdown: '# Handbook\n\n- Channels: #finance-close',
        updatedAt: 1,
      });
      return { sourceId, agentId };
    });
    const refs = ['handbook.md'];
    for (let start = 0; start < LARGE_PAGES; start += 4) {
      await harness.run(async (ctx) => {
        for (let index = start; index < start + 4; index += 1) {
          const ref = `runbooks/page-${index}.md`;
          await ctx.db.insert('docPages', {
            sourceId,
            ref,
            title: `Page ${index}`,
            markdown: LARGE_BODY,
            updatedAt: 1,
          });
          await ctx.db.insert('mockDocs', {
            agentId,
            slug: mirroredDocSlug(sourceId, ref),
            title: `Page ${index}`,
            body: LARGE_BODY,
            category: 'how-to-guide',
            sourceId,
            sourceRef: ref,
            updatedAt: 1,
          });
        }
      });
      for (let index = start; index < start + 4; index += 1) refs.push(`runbooks/page-${index}.md`);
    }
    const surfaceId = await harness.run(async (ctx): Promise<Id<'surfaces'>> => {
      const runId = await ctx.db.insert('docSyncRuns', {
        sourceId,
        refs,
        credentialRefs: [],
        pageCount: refs.length,
        redactionCount: 0,
        state: 'completed',
        createdAt: 1,
        completedAt: 1,
        summary: {
          pagesKept: refs.length,
          pagesRemoved: 0,
          mirrorsRemoved: 0,
          credentialsSuperseded: 0,
          surfacesToReapprove: 0,
        },
      });
      await ctx.db.patch(sourceId, { lastCompletedSyncId: runId });
      return await ctx.db.insert('surfaces', {
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        credentialLanded: true,
        whereFound: [{ sourceId, ref: 'runbooks/page-3.md', quote: '# Runbook' }],
        createdAt: 1,
        managerApprovedAt: 2,
        itApprovedAt: 3,
        intakeScope: {
          channels: [
            {
              value: 'finance-close',
              sourceId,
              ref: 'handbook.md',
              quote: '- Channels: #finance-close',
            },
          ],
        },
      });
    });
    return { sourceId, agentId, surfaceId };
  }

  it('counts a large source’s pages from its run record, not by reading them', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = limitedHarness();
    const { sourceId } = await largeSource(harness);
    await expect(
      harness.withIdentity({ subject: 'owner' }).query(api.docSources.listMine, {}),
    ).resolves.toMatchObject([{ _id: sourceId, pageCount: LARGE_PAGES + 1 }]);
    await expect(
      harness.query(internal.docSources.syncReport, { sourceId }),
    ).resolves.toMatchObject({ status: 'synced', pageCount: LARGE_PAGES + 1 });
  });

  it('sends the surface cards the pages they read, not every page body', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = limitedHarness();
    const { agentId } = await largeSource(harness);
    const pages = await harness
      .withIdentity({ subject: 'owner' })
      .query(api.docSources.pagesForAgent, { agentId });
    expect(pages.map((page) => page.ref)).toEqual(['handbook.md', 'runbooks/page-3.md']);
    expect(pages[0]).toMatchObject({ sourceLabel: 'Large handbook', sourceKind: 'folder' });
  });

  it('finishes a generation whose pages and mirrors outgrow one transaction', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = limitedHarness();
    const { sourceId, surfaceId } = await largeSource(harness);
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    const listed = ['handbook.md'];
    for (let index = 1; index < LARGE_PAGES; index += 1) listed.push(`runbooks/page-${index}.md`);
    // The handbook is renamed within the team's pages: the approved quote follows it.
    await harness.mutation(internal.docSources.upsertPage, {
      sourceId,
      syncRunId: runId,
      ref: 'handbook.md',
      title: 'Handbook',
      markdown: '# Handbook\n\n- Channels:  #finance-close',
      updatedAt: 2,
    });
    await expect(
      finishGeneration(harness, sourceId, runId, {
        refs: listed,
        credentialRefs: [],
        pageCount: listed.length,
        redactionCount: 0,
      }),
    ).resolves.toMatchObject({ ok: true, complete: true });
    const run = await harness.run(async (ctx) => await ctx.db.get(runId));
    expect(run).toMatchObject({ state: 'completed' });
    expect(run?.summary).toEqual({
      pagesKept: LARGE_PAGES,
      pagesRemoved: 1,
      mirrorsRemoved: 1,
      credentialsSuperseded: 0,
      surfacesToReapprove: 0,
    });
    const gone = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('docPages')
          .withIndex('by_source_ref', (index) =>
            index.eq('sourceId', sourceId).eq('ref', 'runbooks/page-0.md'),
          )
          .unique(),
    );
    expect(gone).toBeNull();
    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({ verdict: 'connected' });
    expect(surface?.intakeScope?.channels?.[0].quote).toBe('- Channels:  #finance-close');
  });

  it('mirrors a large source for a new employee a page at a time', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = limitedHarness();
    const { sourceId } = await largeSource(harness);
    const newcomer = await harness.run(
      async (ctx) =>
        await ctx.db.insert('agents', {
          bossEmail: 'boss@day0.local',
          name: 'newcomer',
          userId: 'owner',
          state: 'deployed',
          createdAt: 2,
        }),
    );
    await expect(
      harness.action(internal.docSyncActions.mirrorForAgent, { agentId: newcomer }),
    ).resolves.toEqual({ pages: LARGE_PAGES + 1 });
    let mirrored = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = await harness.run(
        async (ctx) =>
          await ctx.db
            .query('mockDocs')
            .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
            .paginate({ numItems: 4, cursor }),
      );
      mirrored += page.page.filter((mirror) => mirror.agentId === newcomer).length;
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(mirrored).toBe(LARGE_PAGES + 1);
  });

  it('unlinks a large source, deleting its rows in scheduled pages', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = limitedHarness();
    const { sourceId } = await largeSource(harness);
    await harness.withIdentity({ subject: 'owner' }).mutation(api.docSources.unlink, { sourceId });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await harness.run(async (ctx) => ({
      page: await ctx.db
        .query('docPages')
        .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
        .first(),
      mirror: await ctx.db
        .query('mockDocs')
        .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
        .first(),
      run: await ctx.db
        .query('docSyncRuns')
        .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
        .first(),
    }));
    expect(left).toEqual({ page: null, mirror: null, run: null });
  });

  it('lists the syncable sources a page at a time', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = limitedHarness();
    await harness.run(async (ctx) => {
      for (let index = 0; index < 150; index += 1) {
        await ctx.db.insert('docSources', {
          userId: `owner-${index}`,
          label: `Source ${index}`,
          kind: 'folder',
          locator: '.',
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });
    const first = await harness.query(internal.docSources.listSyncable, {
      paginationOpts: { numItems: 100, cursor: null },
    });
    expect(first.page).toHaveLength(100);
    expect(first.isDone).toBe(false);
    const rest = await harness.query(internal.docSources.listSyncable, {
      paginationOpts: { numItems: 100, cursor: first.continueCursor },
    });
    expect(rest.page).toHaveLength(50);
    expect(rest.isDone).toBe(true);
  });

  it('leaves an unchanged page unwritten, so its readers are not woken each sync', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = limitedHarness();
    const { sourceId } = await seedSyncedSource(harness);
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    const unchanged = {
      sourceId,
      syncRunId: runId,
      ref: 'page.md',
      title: 'Page',
      markdown: '# Page',
    };
    await harness.mutation(internal.docSources.upsertPage, { ...unchanged, updatedAt: 9 });
    const page = async () =>
      await harness.run(
        async (ctx) =>
          await ctx.db
            .query('docPages')
            .withIndex('by_source_ref', (index) =>
              index.eq('sourceId', sourceId).eq('ref', 'page.md'),
            )
            .unique(),
      );
    expect((await page())?.updatedAt).toBe(1);
    await harness.mutation(internal.docSources.upsertPage, {
      ...unchanged,
      markdown: '# Page\n\nEdited.',
      updatedAt: 9,
    });
    expect(await page()).toMatchObject({ markdown: '# Page\n\nEdited.', updatedAt: 9 });
  });

  it('resumes a finish cut off part-way from the checkpoint its run recorded (adversarial pass)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = limitedHarness();
    const { sourceId } = await seedSyncedSource(harness);
    const listed: string[] = [];
    await harness.run(async (ctx): Promise<void> => {
      const insert = async (ref: string): Promise<void> => {
        await ctx.db.insert('docPages', {
          sourceId,
          ref,
          title: ref,
          markdown: `# ${ref}`,
          updatedAt: 1,
        });
      };
      await insert('stale-first.md');
      for (let index = 0; index < 150; index += 1) {
        listed.push(`page-${index}.md`);
        await insert(`page-${index}.md`);
      }
      await insert('stale-last.md');
    });
    const cutOff = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.recordSyncBatch, {
      sourceId,
      runId: cutOff,
      nextCursor: FINISHING_CURSOR,
      refs: listed,
      credentialRefs: [],
      pageCount: listed.length,
      redactionCount: 0,
    });
    // One recorded page of the finish, then the action is cut off.
    const first = await harness.mutation(internal.docSources.prunePages, {
      sourceId,
      runId: cutOff,
      checkpoint: FINISHING_CURSOR,
      from: null,
      record: true,
    });
    expect(first).toMatchObject({ removed: 2, done: false });
    const resumed = await harness.mutation(internal.docSources.beginSync, { sourceId });
    const context = await harness.query(internal.docSources.syncContext, {
      sourceId,
      runId: resumed,
    });
    expect(context?.run.cursor).toBe(first?.checkpoint);
    await harness.action(internal.docSyncActions.syncBatch, {
      sourceId,
      runId: resumed,
      cursor: context?.run.cursor,
    });
    const run = await harness.run(async (ctx) => await ctx.db.get(resumed));
    expect(run).toMatchObject({ state: 'completed' });
    expect(run?.summary).toMatchObject({ pagesKept: 150, pagesRemoved: 1 });
    const left = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('docPages')
          .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
          .take(200),
    );
    expect(left.map((page) => page.ref).sort()).toEqual([...listed].sort());
  });

  it('prunes a source’s old runs, keeping what it points at and what a migration still reads', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T00:00:00Z'));
    const harness = limitedHarness();
    const { sourceId } = await seedSyncedSource(harness);
    const old = Date.now() - RUN_HISTORY_MS - 1;
    const runs = await harness.run(async (ctx) => {
      const insert = async (
        state: 'completed' | 'error' | 'superseded',
        completedAt: number,
      ): Promise<Id<'docSyncRuns'>> =>
        await ctx.db.insert('docSyncRuns', {
          sourceId,
          refs: ['page.md'],
          credentialRefs: [],
          pageCount: 1,
          redactionCount: 0,
          state,
          createdAt: completedAt,
          completedAt,
        });
      const oldFailed = await insert('error', old);
      const oldSuperseded = await insert('superseded', old);
      const oldCompleted = await insert('completed', old);
      const pointedAt = await insert('completed', old);
      const recent = await insert('error', Date.now());
      await ctx.db.patch(sourceId, { lastCompletedSyncId: pointedAt });
      return { oldFailed, oldSuperseded, oldCompleted, pointedAt, recent };
    });
    const left = async (): Promise<Array<Id<'docSyncRuns'>>> =>
      await harness.run(async (ctx) =>
        (
          await ctx.db
            .query('docSyncRuns')
            .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
            .collect()
        ).map((run) => run._id),
      );
    await expect(harness.mutation(internal.docSources.pruneRunHistory, { sourceId })).resolves.toBe(
      2,
    );
    expect(await left()).toEqual([runs.oldCompleted, runs.pointedAt, runs.recent]);
    await harness.run(async (ctx) => {
      await ctx.db.insert('migrations', {
        name: 'credentials-sync-revoke',
        release: '0.5.0',
        read: 0,
        changed: 0,
        startedAt: 1,
        completedAt: 2,
      });
    });
    await expect(harness.mutation(internal.docSources.pruneRunHistory, { sourceId })).resolves.toBe(
      1,
    );
    expect(await left()).toEqual([runs.pointedAt, runs.recent]);
  });
});
