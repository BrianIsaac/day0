import { randomBytes } from 'node:crypto';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import {
  FINISHING_CURSOR,
  RUN_HISTORY_MS,
  STALE_LISTING_PAGE,
  STALE_SYNC_MS,
  SUPERSEDED_CREDENTIAL_KEEP_MS,
  validateLinkInput,
  validateReaderSecret,
} from '../../convex/docSources';
import { DOCS_NOTION_LOCATOR } from '../../src/docs/components';
import { finishingCursor } from '../../src/docs/finishing';
import { listingCursor } from '../../src/docs/readers/batch';
import { allConvexModules } from './all-modules';

import { mirroredDocSlug } from '../../src/docs/types';
import { restoreSurfaceMode, useSurfaceMode } from './surface-mode-env';
import { MANAGER_ADDRESS, managerIdentity } from './fakes/manager-identity';
import { goneRowOf, guardRefusal } from './fakes/anonymous-caller';

/**
 * A cursor a resume can check: an offset bound to the listing it continues,
 * as the folder and URL readers write one. A provider's own cursor, or a bare
 * offset, starts the next sync from page one (D D5).
 */
const AFTER_PAGE_1 = listingCursor(1, ['page.md', 'fresh.md']);
const AFTER_25 = listingCursor(25, ['page.md']);

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
      listings: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    const agentId = await ctx.db.insert('agents', {
      bossEmail: MANAGER_ADDRESS,
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
    // The page an earlier sync (listing 1) stored and named.
    await ctx.db.insert('docPageListings', { sourceId, ref: 'page.md', seenBy: 1 });
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
    unread?: Array<{ ref: string; reason: string }>;
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
});

describe('documentation sources in mock mode', (): void => {
  it('refuses to link any location, including link-local metadata URLs', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules()).withIdentity(managerIdentity());
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
    const owner = harness.withIdentity(managerIdentity());
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
    const owner = harness.withIdentity(managerIdentity());
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
    const owner = harness.withIdentity(managerIdentity());
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
    const owner = harness.withIdentity(managerIdentity());
    const sourceId = await owner.action(api.docSources.link, {
      label: 'Team folder',
      kind: 'folder',
      locator: '.',
    });
    const sources = await owner.query(api.docSources.listMine, {});
    expect(sources).toMatchObject([{ _id: sourceId, status: 'linking', pageCount: 0 }]);
    await expect(
      harness.withIdentity(managerIdentity('other-owner')).query(api.docSources.listMine, {}),
    ).resolves.toEqual([]);
  });

  it('refuses a git locator carrying a token at link, so no row stores it', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
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
    const owner = harness.withIdentity(managerIdentity());
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

  it('rotates a URL source’s reader secret, reads again from page one, and refuses one that would leave its site (E-74)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
    const harness = convexTest(schema, allConvexModules());
    const owner = harness.withIdentity(managerIdentity());
    const sourceId = await owner.action(api.docSources.link, {
      label: 'Wiki',
      kind: 'urls',
      locator: 'https://wiki.example/a\nhttps://wiki.example/b',
      credential: 'first-reader-value',
    });
    const first = (await harness.run(async (ctx) => await ctx.db.get(sourceId)))?.credentialId;
    await owner.action(api.docSources.rotateCredential, {
      sourceId,
      credential: 'second-reader-value',
    });
    const { source, old, scheduled } = await harness.run(async (ctx) => ({
      source: await ctx.db.get(sourceId),
      old: first ? await ctx.db.get(first) : null,
      scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
    }));
    expect(source?.credentialId).not.toBe(first);
    expect(old?.revokedAt).toEqual(expect.any(Number));
    expect(scheduled.map((job) => job.args[0])).toContainEqual({ sourceId, fresh: true });
    await expect(
      owner.action(api.docSources.rotateCredential, { sourceId, credential: 'bad\nvalue' }),
    ).rejects.toThrow('line break');
    const folder = await harness.run(
      async (ctx) =>
        await ctx.db.insert('docSources', {
          userId: 'owner',
          label: 'Folder',
          kind: 'folder',
          locator: '.',
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    await expect(
      owner.action(api.docSources.rotateCredential, { sourceId: folder, credential: 'value' }),
    ).rejects.toThrow('Documentation source not found.');
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
    const owner = harness.withIdentity(managerIdentity());
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
    await harness.withIdentity(managerIdentity()).mutation(api.docSources.unlink, { sourceId });
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

    const owner = harness.withIdentity(managerIdentity());
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
    const other = harness.withIdentity(managerIdentity('other-owner'));
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

  it('ends a run the pause held as held, and the source as held, keeping its cursor (W12V-2)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId } = await seedSyncedSource(harness);
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.run(async (ctx) => await ctx.db.patch(runId, { cursor: 'kept-cursor' }));
    await harness.mutation(internal.docSources.failSync, {
      sourceId,
      runId,
      status: 'held',
      reason: "Held: this deployment's scheduled work is paused.",
    });
    const [source, run] = await harness.run(
      async (ctx) => await Promise.all([ctx.db.get(sourceId), ctx.db.get(runId)]),
    );
    expect(source).toMatchObject({
      status: 'held',
      lastError: "Held: this deployment's scheduled work is paused.",
    });
    expect(source?.activeSyncId).toBeUndefined();
    expect(run).toMatchObject({ state: 'held', cursor: 'kept-cursor' });
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
      credentialsPruned: 0,
      mirrorsRemoved: 1,
      credentialsSuperseded: 0,
      surfacesToReapprove: 0,
    });
  });

  it('keeps the unread record on its own field through every rewrite of the reason, and carries it into the run that resumes (D D1 (a))', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId } = await seedSyncedSource(harness);
    const first = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.recordSyncBatch, {
      sourceId,
      runId: first,
      nextCursor: AFTER_PAGE_1,
      refs: ['page.md'],
      credentialRefs: [],
      pageCount: 0,
      redactionCount: 0,
      unread: [{ ref: 'page.md', reason: 'HTTP 404' }],
    });
    await harness.mutation(internal.docSources.failSync, {
      sourceId,
      runId: first,
      status: 'error',
      reason: 'The documentation read was interrupted (timeout).\nat read (urls.ts:1)',
    });
    const resumed = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.upsertPage, {
      sourceId,
      syncRunId: resumed,
      ref: 'fresh.md',
      title: 'Fresh',
      markdown: '# Fresh',
      updatedAt: 2,
    });
    await finishGeneration(harness, sourceId, resumed, {
      currentCursor: AFTER_PAGE_1,
      refs: ['fresh.md', 'gone.md'],
      credentialRefs: [],
      pageCount: 1,
      redactionCount: 0,
      unread: [{ ref: 'gone.md', reason: 'truncated' }],
    });

    const [failed, completed, source] = await harness.run(
      async (ctx) =>
        await Promise.all([ctx.db.get(first), ctx.db.get(resumed), ctx.db.get(sourceId)]),
    );
    expect(failed?.reason).toBe(
      'The documentation read was interrupted (timeout). at read (urls.ts:1) A newer sync of the source took over from its cursor after 0 pages.',
    );
    expect(failed?.unread).toEqual({ count: 1, pages: [{ ref: 'page.md', reason: 'HTTP 404' }] });
    expect(completed).toMatchObject({
      state: 'completed',
      unread: {
        count: 2,
        pages: [
          { ref: 'page.md', reason: 'HTTP 404' },
          { ref: 'gone.md', reason: 'truncated' },
        ],
      },
    });
    expect(completed?.reason).toBeUndefined();
    expect(source?.lastError).toBe(
      '2 pages could not be read this sync and keep their last stored version: page.md: HTTP 404; gone.md: truncated. The next sync reads them again.',
    );
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
          probeGeneration: 4,
          probeStartedAt: 3,
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
    // The probe in flight is ended with its generation, so the next probe is not held back.
    expect(surface?.probeStartedAt).toBeUndefined();
    expect(surface?.managerApprovedAt).toBeUndefined();
    expect(surface?.intakeScope?.channels?.[0].value).toBe('finance-close');
    await expect(
      harness.withIdentity(managerIdentity()).mutation(api.surfaces.approve, { surfaceId }),
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
        nextCursor: AFTER_25,
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
    ).resolves.toMatchObject({ run: { cursor: AFTER_25, pageCount: 25, state: 'running' } });
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
      nextCursor: AFTER_25,
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
    expect(await context(rotated)).toMatchObject({ pagesListed: 0, pageCount: 0 });
    expect((await context(rotated))?.cursor).toBeUndefined();
    await failAt(rotated);

    // The fresh run failed before its first batch: nothing to carry.
    const second = await harness.mutation(internal.docSources.beginSync, { sourceId });
    expect((await context(second))?.cursor).toBeUndefined();
    await harness.mutation(internal.docSources.recordSyncBatch, {
      sourceId,
      runId: second,
      nextCursor: AFTER_25,
      refs: ['page.md'],
      credentialRefs: [],
      pageCount: 25,
      redactionCount: 0,
    });
    await failAt(second);
    const resumed = await harness.mutation(internal.docSources.beginSync, { sourceId });
    expect(await context(resumed)).toMatchObject({ cursor: AFTER_25, pageCount: 25 });
    await failAt(resumed);

    // The resume failed where it started: the provider may no longer take the cursor.
    const restarted = await harness.mutation(internal.docSources.beginSync, { sourceId });
    expect(await context(restarted)).toMatchObject({ pagesListed: 0, pageCount: 0 });
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
      probeGeneration: 4,
      probeStartedAt: 5,
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
    request: { credential: { found: 'location', method: 'bot-token' } },
  });
  expect(surface?.credentialId).toBeUndefined();
  expect(surface?.probeStartedAt).toBeUndefined();
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

it("reads one surface's own pages for its probe, the ones its card cites, and no other (D D3)", async () => {
  useSurfaceMode('real');
  const harness = convexTest(schema, allConvexModules());
  const { sourceId, agentId } = await seedSyncedSource(harness);
  const surfaceId = await harness.run(async (ctx) => {
    for (const ref of ['tile.md', 'unrelated.md']) {
      await ctx.db.insert('docPages', {
        sourceId,
        ref,
        title: ref,
        markdown: `# ${ref}`,
        updatedAt: 1,
      });
    }
    return await ctx.db.insert('surfaces', {
      agentId,
      slug: 'tile',
      displayName: 'Tile',
      class: 'analytics',
      verdict: 'approved',
      whereFound: [{ sourceId, ref: 'tile.md', quote: 'Tile' }],
      credentialLanded: false,
      createdAt: 1,
    });
  });
  const pages = await harness.query(internal.docSources.cardPagesForSurface, { surfaceId });
  expect(pages.map((page) => page.ref)).toEqual(['tile.md']);
});

it('leaves a credential an earlier sync superseded alone, and counts only what this sync superseded', async () => {
  useSurfaceMode('real');
  const harness = convexTest(schema, allConvexModules());
  const { sourceId } = await seedSyncedSource(harness);
  const credentialId = await harness.run(
    async (ctx) =>
      await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Slack credential',
        source: { sourceId, ref: 'page.md' },
        ciphertext: 'sealed',
        iv: 'iv',
        createdAt: 1,
      }),
  );
  const sync = async (): Promise<Doc<'docSyncRuns'> | null> => {
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.finishSync, {
      sourceId,
      runId,
      refs: ['page.md'],
      credentialRefs: [],
      pageCount: 1,
      redactionCount: 0,
    });
    return await harness.run(async (ctx) => await ctx.db.get(runId));
  };
  expect((await sync())?.summary?.credentialsSuperseded).toBe(1);
  const first = await harness.run(async (ctx) => await ctx.db.get(credentialId));
  expect(first?.status).toBe('superseded');
  expect((await sync())?.summary?.credentialsSuperseded).toBe(0);
  expect(await harness.run(async (ctx) => await ctx.db.get(credentialId))).toEqual(first);
});

it('tells each agent whose card lost a swapped-out credential, naming the page and never the value', async () => {
  useSurfaceMode('real');
  const harness = convexTest(schema, allConvexModules());
  const { sourceId, agentId } = await seedSyncedSource(harness);
  const ref = 'runbooks/linear.md#credential=0123456789abcdef0123456789abcdef';
  const { credentialId, surfaceId } = await harness.run(async (ctx) => {
    const credentialId = await ctx.db.insert('credentials', {
      userId: 'owner',
      kind: 'value',
      label: 'linear service token',
      source: { sourceId, ref },
      ciphertext: 'sealed',
      iv: 'iv',
      createdAt: 1,
    });
    const surfaceId = await ctx.db.insert('surfaces', {
      agentId,
      slug: 'linear',
      displayName: 'Linear',
      class: 'kanban',
      verdict: 'connected',
      credentialId,
      credentialKind: 'value',
      credentialLanded: true,
      whereFound: [],
      createdAt: 1,
    });
    return { credentialId, surfaceId };
  });
  const sync = async (): Promise<void> => {
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.finishSync, {
      sourceId,
      runId,
      refs: ['runbooks/linear.md'],
      credentialRefs: [],
      pageCount: 1,
      redactionCount: 0,
    });
  };
  const superseded = async (): Promise<Doc<'events'>[]> =>
    await harness.run(
      async (ctx) =>
        await ctx.db
          .query('events')
          .withIndex('by_agent_type', (q) =>
            q.eq('agentId', agentId).eq('type', 'credential.superseded'),
          )
          .collect(),
    );
  await sync();
  const events = await superseded();
  expect(events.map((event) => event.payload)).toEqual([
    {
      credentialId,
      label: 'linear service token',
      sourceId,
      page: 'runbooks/linear.md',
      surfaceIds: [surfaceId],
    },
  ]);
  expect(JSON.stringify(events)).not.toContain('0123456789abcdef');
  // A later sync that finds the row already superseded tells no one again.
  await sync();
  expect(await superseded()).toHaveLength(1);
});

describe('the re-bind on a page swap (N23, M15; 12-S3)', (): void => {
  const PAGE = 'runbooks/linear.md';
  const OLD_REF = `${PAGE}#credential=0123456789abcdef0123456789abcdef`;
  const NEW_REF = `${PAGE}#credential=fedcba9876543210fedcba9876543210`;
  const OTHER_REF = `${PAGE}#credential=11111111111111111111111111111111`;
  const LABEL = 'Linear service token';

  afterEach((): void => {
    vi.useRealTimers();
  });

  /** A page credential of the source, as a sync stored it. */
  const pageRow = (
    sourceId: Id<'docSources'>,
    ref: string,
    fields: Partial<Doc<'credentials'>> = {},
  ): Omit<Doc<'credentials'>, '_id' | '_creationTime'> => ({
    userId: 'owner',
    kind: 'value',
    label: LABEL,
    source: { sourceId, ref },
    ciphertext: 'sealed',
    iv: 'iv',
    createdAt: 1,
    ...fields,
  });

  /** A connected card holding a credential, approved by its manager. */
  const card = (
    agentId: Id<'agents'>,
    slug: string,
    credentialId: Id<'credentials'>,
    fields: Partial<Doc<'surfaces'>> = {},
  ): Omit<Doc<'surfaces'>, '_id' | '_creationTime'> => ({
    agentId,
    slug,
    displayName: 'Linear',
    class: 'kanban',
    verdict: 'connected',
    credentialId,
    credentialKind: 'value',
    credentialLanded: true,
    whereFound: [],
    createdAt: 1,
    request: { credential: { found: 'value', method: 'api-key', evidenceRef: PAGE } },
    managerApprovedAt: 2,
    probeGeneration: 4,
    lastVerifiedAt: 5,
    toolAllowlist: ['save_comment'],
    providerIdentityId: 'old-identity',
    ...fields,
  });

  /** The source's last completed generation, which stated the given credential refs. */
  async function statedBefore(
    harness: TestConvex<typeof schema>,
    sourceId: Id<'docSources'>,
    credentialRefs: string[],
  ): Promise<void> {
    await harness.run(async (ctx) => {
      const runId = await ctx.db.insert('docSyncRuns', {
        sourceId,
        listing: 1,
        pagesListed: 1,
        credentialRefs,
        pageCount: 1,
        redactionCount: credentialRefs.length,
        state: 'completed',
        createdAt: 1,
        completedAt: 2,
      });
      await ctx.db.patch(sourceId, { lastCompletedSyncId: runId });
    });
  }

  /** One sync that lists the page and states the given credential refs on it. */
  async function syncStating(
    harness: TestConvex<typeof schema>,
    sourceId: Id<'docSources'>,
    credentialRefs: string[],
  ): Promise<void> {
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await harness.mutation(internal.docSources.finishSync, {
      sourceId,
      runId,
      refs: [PAGE],
      credentialRefs,
      pageCount: 1,
      redactionCount: credentialRefs.length,
    });
  }

  /** The probes scheduled for the given cards. */
  async function probesOf(harness: TestConvex<typeof schema>): Promise<unknown[]> {
    return await harness.run(async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect())
        .filter((job) => job.name.includes('probeInternal'))
        .map((job) => job.args[0]),
    );
  }

  /** The `credential.superseded` payloads of one employee. */
  async function supersededOf(
    harness: TestConvex<typeof schema>,
    agentId: Id<'agents'>,
  ): Promise<unknown[]> {
    return await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('events')
          .withIndex('by_agent_type', (q) =>
            q.eq('agentId', agentId).eq('type', 'credential.superseded'),
          )
          .collect()
      ).map((event) => event.payload),
    );
  }

  it('re-binds every card the swapped-out value held, of each employee, to the value swapped in, and checks each at once', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, agentId } = await seedSyncedSource(harness);
    await statedBefore(harness, sourceId, [OLD_REF]);
    const { oldId, newId, priya, mateo, mateoCard } = await harness.run(async (ctx) => {
      const oldId = await ctx.db.insert('credentials', pageRow(sourceId, OLD_REF));
      // The new value the page now states under the same label, stored by this sync's batch.
      const newId = await ctx.db.insert(
        'credentials',
        pageRow(sourceId, NEW_REF, { createdAt: 9 }),
      );
      const mateo = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'Mateo',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      });
      const priya = await ctx.db.insert('surfaces', card(agentId, 'linear', oldId));
      const mateoCard = await ctx.db.insert('surfaces', card(mateo, 'linear', oldId));
      return { oldId, newId, priya, mateo, mateoCard };
    });

    await syncStating(harness, sourceId, [NEW_REF]);

    expect(await harness.run(async (ctx) => await ctx.db.get(oldId))).toMatchObject({
      status: 'superseded',
    });
    for (const surfaceId of [priya, mateoCard]) {
      const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
      expect(surface).toMatchObject({
        credentialId: newId,
        credentialKind: 'value',
        credentialLanded: false,
        verdict: 'approved',
        managerApprovedAt: 2,
        probeGeneration: 5,
        request: { credential: { found: 'value', method: 'api-key' } },
      });
      expect(surface?.lastVerifiedAt).toBeUndefined();
      expect(surface?.toolAllowlist).toBeUndefined();
      expect(surface?.providerIdentityId).toBeUndefined();
    }
    // Each re-bound card is probed with the new value at once, as a hand landing is.
    expect(await probesOf(harness)).toEqual([{ surfaceId: priya }, { surfaceId: mateoCard }]);
    // The record says the value moved, and no card is among those sent back to landing.
    const payload = { credentialId: oldId, label: LABEL, sourceId, page: PAGE, surfaceIds: [] };
    expect(await supersededOf(harness, agentId)).toEqual([
      { ...payload, reboundSurfaceIds: [priya] },
    ]);
    expect(await supersededOf(harness, mateo)).toEqual([
      { ...payload, reboundSurfaceIds: [mateoCard] },
    ]);
  });

  it('never binds a value the page already stated under the same label, which is another system’s', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, agentId } = await seedSyncedSource(harness);
    // The page stated two values under one label, each bound to its own system's card.
    await statedBefore(harness, sourceId, [OLD_REF, OTHER_REF]);
    const { surfaceId } = await harness.run(async (ctx) => {
      const oldId = await ctx.db.insert('credentials', pageRow(sourceId, OLD_REF));
      await ctx.db.insert('credentials', pageRow(sourceId, OTHER_REF, { createdAt: 2 }));
      const surfaceId = await ctx.db.insert('surfaces', card(agentId, 'linear', oldId));
      return { surfaceId };
    });

    // The edit drops the first value and states nothing new.
    await syncStating(harness, sourceId, [OTHER_REF]);

    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({ verdict: 'ungranted', credentialLanded: false });
    expect(surface?.credentialId).toBeUndefined();
    expect(await probesOf(harness)).toEqual([]);
  });

  it('binds nothing when two new values under the label cannot be told apart, or when no earlier sync says what the page held', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, agentId } = await seedSyncedSource(harness);
    await statedBefore(harness, sourceId, [OLD_REF]);
    const { surfaceId } = await harness.run(async (ctx) => {
      const oldId = await ctx.db.insert('credentials', pageRow(sourceId, OLD_REF));
      await ctx.db.insert('credentials', pageRow(sourceId, NEW_REF, { createdAt: 9 }));
      await ctx.db.insert('credentials', pageRow(sourceId, OTHER_REF, { createdAt: 10 }));
      const surfaceId = await ctx.db.insert('surfaces', card(agentId, 'linear', oldId));
      return { surfaceId };
    });

    await syncStating(harness, sourceId, [NEW_REF, OTHER_REF]);

    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({ verdict: 'ungranted' });
    expect(surface?.credentialId).toBeUndefined();

    const fresh = convexTest(schema, allConvexModules());
    const seeded = await seedSyncedSource(fresh);
    const unknownBefore = await fresh.run(async (ctx) => {
      const oldId = await ctx.db.insert('credentials', pageRow(seeded.sourceId, OLD_REF));
      await ctx.db.insert('credentials', pageRow(seeded.sourceId, NEW_REF, { createdAt: 9 }));
      return await ctx.db.insert('surfaces', card(seeded.agentId, 'linear', oldId));
    });
    await syncStating(fresh, seeded.sourceId, [NEW_REF]);
    expect(
      (await fresh.run(async (ctx) => await ctx.db.get(unknownBefore)))?.credentialId,
    ).toBeUndefined();
  });

  it("re-binds a card its manager has not approved without probing it, keeping the card's own reason", async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, agentId } = await seedSyncedSource(harness);
    await statedBefore(harness, sourceId, [OLD_REF]);
    const queueChanged =
      'The documented queue this card reads changed; approve it again once it is right.';
    const { newId, surfaceId } = await harness.run(async (ctx) => {
      const oldId = await ctx.db.insert('credentials', pageRow(sourceId, OLD_REF));
      const newId = await ctx.db.insert(
        'credentials',
        pageRow(sourceId, NEW_REF, { createdAt: 9 }),
      );
      const surfaceId = await ctx.db.insert(
        'surfaces',
        card(agentId, 'linear', oldId, {
          verdict: 'proposed',
          managerApprovedAt: undefined,
          reason: queueChanged,
          lastVerifiedAt: undefined,
          toolAllowlist: undefined,
          providerIdentityId: undefined,
        }),
      );
      return { newId, surfaceId };
    });

    await syncStating(harness, sourceId, [NEW_REF]);

    expect(await harness.run(async (ctx) => await ctx.db.get(surfaceId))).toMatchObject({
      credentialId: newId,
      verdict: 'proposed',
      reason: queueChanged,
    });
    expect(await probesOf(harness)).toEqual([]);
  });

  it('re-binds a card whose access ended without probing it, so it stays ended until its renewal', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, agentId } = await seedSyncedSource(harness);
    await statedBefore(harness, sourceId, [OLD_REF]);
    const { newId, ended, lapsed } = await harness.run(async (ctx) => {
      const oldId = await ctx.db.insert('credentials', pageRow(sourceId, OLD_REF));
      const newId = await ctx.db.insert(
        'credentials',
        pageRow(sourceId, NEW_REF, { createdAt: 9 }),
      );
      // Ended by the sweep, the pasted key kept for the renewal; and past its end date, not yet swept.
      const ended = await ctx.db.insert(
        'surfaces',
        card(agentId, 'linear', oldId, {
          verdict: 'approved',
          reason: 'expired',
          credentialLanded: false,
          lastVerifiedAt: undefined,
        }),
      );
      const lapsed = await ctx.db.insert(
        'surfaces',
        card(agentId, 'linear-2', oldId, { expiresAt: Date.now() - 1 }),
      );
      return { newId, ended, lapsed };
    });

    await syncStating(harness, sourceId, [NEW_REF]);

    expect(await harness.run(async (ctx) => await ctx.db.get(ended))).toMatchObject({
      credentialId: newId,
      verdict: 'approved',
      reason: 'expired',
    });
    expect(await harness.run(async (ctx) => await ctx.db.get(lapsed))).toMatchObject({
      credentialId: newId,
      verdict: 'connected',
    });
    expect(await probesOf(harness)).toEqual([]);
  });

  it("sends a card handed to another owner back to landing rather than binding the old owner's new value", async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId } = await seedSyncedSource(harness);
    await statedBefore(harness, sourceId, [OLD_REF]);
    const { surfaceId } = await harness.run(async (ctx) => {
      const oldId = await ctx.db.insert('credentials', pageRow(sourceId, OLD_REF));
      await ctx.db.insert('credentials', pageRow(sourceId, NEW_REF, { createdAt: 9 }));
      // The employee went to another manager; its card keeps the credential for re-approval.
      const handedOver = await ctx.db.insert('agents', {
        bossEmail: 'next@example.test',
        name: 'Ines',
        userId: 'next-owner',
        state: 'active',
        createdAt: 1,
      });
      const surfaceId = await ctx.db.insert(
        'surfaces',
        card(handedOver, 'linear', oldId, { verdict: 'proposed', managerApprovedAt: undefined }),
      );
      return { surfaceId };
    });

    await syncStating(harness, sourceId, [NEW_REF]);

    expect((await harness.run(async (ctx) => await ctx.db.get(surfaceId)))?.credentialId).toBe(
      undefined,
    );
    expect(await probesOf(harness)).toEqual([]);
  });

  it('sends a card back to landing only where the page holds no live row of the same label', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, agentId } = await seedSyncedSource(harness);
    await statedBefore(harness, sourceId, [OLD_REF]);
    const { oldId, surfaceId } = await harness.run(async (ctx) => {
      const oldId = await ctx.db.insert('credentials', pageRow(sourceId, OLD_REF));
      // The new value carries another label, and a same-label row is revoked or suspect.
      await ctx.db.insert('credentials', pageRow(sourceId, NEW_REF, { label: 'Linear webhook' }));
      await ctx.db.insert(
        'credentials',
        pageRow(sourceId, OTHER_REF, {
          revokedAt: 3,
        }),
      );
      await ctx.db.insert(
        'credentials',
        pageRow(sourceId, `${PAGE}#credential=22222222222222222222222222222222`, {
          status: 'suspect',
        }),
      );
      const surfaceId = await ctx.db.insert('surfaces', card(agentId, 'linear', oldId));
      return { oldId, surfaceId };
    });

    await syncStating(harness, sourceId, [NEW_REF, OTHER_REF]);

    const surface = await harness.run(async (ctx) => await ctx.db.get(surfaceId));
    expect(surface).toMatchObject({ verdict: 'ungranted', credentialLanded: false });
    expect(surface?.credentialId).toBeUndefined();
    expect(await harness.run(async (ctx) => await ctx.db.get(oldId))).toMatchObject({
      status: 'superseded',
    });
  });
});

describe('superseded page credentials that have aged out (C2 D2 (a))', (): void => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 9, 28);

  /** One page credential of a source, as a sync stored it. */
  async function credential(
    harness: TestConvex<typeof schema>,
    sourceId: Id<'docSources'>,
    ref: string,
    fields: Partial<Doc<'credentials'>> = {},
  ): Promise<Id<'credentials'>> {
    return await harness.run(
      async (ctx) =>
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'value',
          label: ref,
          ciphertext: 'sealed',
          iv: 'iv',
          source: { sourceId, ref },
          createdAt: 1,
          ...fields,
        }),
    );
  }

  it('prunes a row superseded longer than the keep that no surface holds, and keeps every other', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, agentId } = await seedSyncedSource(harness);
    const other = await harness.run(
      async (ctx) =>
        await ctx.db.insert('docSources', {
          userId: 'owner',
          label: 'Other',
          kind: 'folder',
          locator: './other',
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    const aged = {
      status: 'superseded' as const,
      supersededAt: NOW - SUPERSEDED_CREDENTIAL_KEEP_MS,
    };
    const ids = {
      aged: await credential(harness, sourceId, 'page.md#aged', aged),
      held: await credential(harness, sourceId, 'page.md#held', aged),
      recent: await credential(harness, sourceId, 'page.md#recent', {
        status: 'superseded',
        supersededAt: NOW - DAY,
      }),
      live: await credential(harness, sourceId, 'page.md#live'),
      // A person's revoke must outlive the prune, or the value returning revives unrevoked.
      revoked: await credential(harness, sourceId, 'page.md#revoked', { ...aged, revokedAt: 5 }),
      elsewhere: await credential(harness, other, 'page.md#aged', aged),
    };
    await harness.run(async (ctx): Promise<void> => {
      await ctx.db.insert('surfaces', {
        agentId,
        slug: 'linear',
        displayName: 'Linear',
        class: 'kanban',
        verdict: 'ungranted',
        whereFound: [],
        credentialId: ids.held,
        credentialLanded: false,
        createdAt: 1,
      });
    });
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    await finishGeneration(harness, sourceId, runId, {
      refs: ['page.md'],
      credentialRefs: ['page.md#live'],
      pageCount: 0,
      redactionCount: 0,
    });

    const left = await harness.run(async (ctx) =>
      Object.fromEntries(
        await Promise.all(
          Object.entries(ids).map(async ([name, id]) => [name, (await ctx.db.get(id)) !== null]),
        ),
      ),
    );
    expect(left).toEqual({
      aged: false,
      held: true,
      recent: true,
      live: true,
      revoked: true,
      elsewhere: true,
    });
    const run = await harness.run(async (ctx) => await ctx.db.get(runId));
    expect(run?.summary).toMatchObject({ credentialsPruned: 1 });
  });

  it('ages a row from its first supersede, which a later sync superseding it again does not move', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = convexTest(schema, allConvexModules());
    const { sourceId } = await seedSyncedSource(harness);
    const rotated = await credential(harness, sourceId, 'page.md#old-token');
    const sync = async (): Promise<Id<'docSyncRuns'>> => {
      const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
      await finishGeneration(harness, sourceId, runId, {
        refs: ['page.md'],
        credentialRefs: [],
        pageCount: 0,
        redactionCount: 0,
      });
      return runId;
    };
    await sync();
    expect(await harness.run(async (ctx) => await ctx.db.get(rotated))).toMatchObject({
      status: 'superseded',
      supersededAt: NOW,
    });
    vi.setSystemTime(NOW + SUPERSEDED_CREDENTIAL_KEEP_MS - DAY);
    await sync();
    expect((await harness.run(async (ctx) => await ctx.db.get(rotated)))?.supersededAt).toBe(NOW);
    vi.setSystemTime(NOW + SUPERSEDED_CREDENTIAL_KEEP_MS);
    await sync();
    expect(await harness.run(async (ctx) => await ctx.db.get(rotated))).toBeNull();
  });
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
        listings: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
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
      await ctx.db.insert('docPageListings', { sourceId, ref: 'handbook.md', seenBy: 1 });
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
          await ctx.db.insert('docPageListings', { sourceId, ref, seenBy: 1 });
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
      harness.withIdentity(managerIdentity()).query(api.docSources.listMine, {}),
    ).resolves.toMatchObject([{ _id: sourceId, pageCount: LARGE_PAGES + 1 }]);
    await expect(
      harness.query(internal.docSources.syncReport, { sourceId }),
    ).resolves.toMatchObject({ status: 'synced', pageCount: LARGE_PAGES + 1 });
  });

  it('reads a surface card the pages it cites, not every page body', async (): Promise<void> => {
    useSurfaceMode('real');
    const harness = limitedHarness();
    const { surfaceId } = await largeSource(harness);
    const pages = await harness.query(internal.docSources.cardPagesForSurface, { surfaceId });
    expect(pages.map((page) => page.ref)).toEqual(['handbook.md', 'runbooks/page-3.md']);
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
      credentialsPruned: 0,
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
          bossEmail: MANAGER_ADDRESS,
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
    await harness.withIdentity(managerIdentity()).mutation(api.docSources.unlink, { sourceId });
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
      listing: await ctx.db
        .query('docPageListings')
        .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
        .first(),
    }));
    expect(left).toEqual({ page: null, mirror: null, run: null, listing: null });
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
      // Each page an earlier sync (listing 1) stored and named.
      const insert = async (ref: string): Promise<void> => {
        await ctx.db.insert('docPages', {
          sourceId,
          ref,
          title: ref,
          markdown: `# ${ref}`,
          updatedAt: 1,
        });
        await ctx.db.insert('docPageListings', { sourceId, ref, seenBy: 1 });
      };
      for (let index = 0; index < 40; index += 1) await insert(`stale-${index}.md`);
      for (let index = 0; index < 150; index += 1) {
        listed.push(`page-${index}.md`);
        await insert(`page-${index}.md`);
      }
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
    expect(first).toMatchObject({ removed: STALE_LISTING_PAGE, done: false });
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
    // The resumed finish counts its own part: the rest of the stale pages and `page.md`.
    expect(run?.summary).toMatchObject({ pagesKept: 150, pagesRemoved: 41 - STALE_LISTING_PAGE });
    const left = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('docPages')
          .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
          .take(200),
    );
    expect(left.map((page) => page.ref).sort()).toEqual([...listed].sort());
  });

  it('finishes a listing of more than 8,192 pages, which one run once could not record, and prunes only what it did not name (D D2 (a))', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = limitedHarness();
    const { sourceId } = await seedSyncedSource(harness);
    // Pages an earlier listing stored: the first ten this sync names again, the rest it does not.
    const stored = Array.from({ length: 40 }, (_value, index) => `stored-${index}.md`);
    await harness.run(async (ctx): Promise<void> => {
      for (const ref of stored) {
        await ctx.db.insert('docPages', {
          sourceId,
          ref,
          title: ref,
          markdown: `# ${ref}`,
          updatedAt: 1,
        });
        await ctx.db.insert('docPageListings', { sourceId, ref, seenBy: 1 });
      }
    });
    const listed = [
      ...stored.slice(0, 10),
      ...Array.from({ length: 8_200 }, (_value, index) => `listed-${index}.md`),
    ];
    const runId = await harness.mutation(internal.docSources.beginSync, { sourceId });
    let cursor: string | undefined;
    for (let start = 0; start < listed.length; start += 1_000) {
      const next = start + 1_000 >= listed.length ? FINISHING_CURSOR : `after-${start + 1_000}`;
      await harness.mutation(internal.docSources.recordSyncBatch, {
        sourceId,
        runId,
        currentCursor: cursor,
        nextCursor: next,
        refs: listed.slice(start, start + 1_000),
        credentialRefs: [],
        pageCount: 0,
        redactionCount: 0,
      });
      cursor = next;
    }
    await expect(
      harness.action(internal.docSyncActions.syncBatch, {
        sourceId,
        runId,
        cursor: FINISHING_CURSOR,
      }),
    ).resolves.toMatchObject({ ok: true, complete: true });

    const run = await harness.run(async (ctx) => await ctx.db.get(runId));
    expect(run).toMatchObject({ state: 'completed', pagesListed: listed.length });
    // The thirty stored pages it did not name, and the seeded `page.md`.
    expect(run?.summary).toMatchObject({ pagesKept: listed.length, pagesRemoved: 31 });
    const left = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('docPages')
          .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
          .collect()
      ).map((page) => page.ref),
    );
    expect(left.sort()).toEqual(stored.slice(0, 10).sort());
  }, 120_000);

  it('reads a source from page one after a run begun before 0.6.0, whose bare offset names no listing, and removes nothing at the start (D D5)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = limitedHarness();
    const sourceId = await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Folder',
        kind: 'folder',
        locator: '.',
        status: 'error',
        createdAt: 1,
        updatedAt: 1,
      });
      // The upgrade's copy stamps every stored page 0 (`doc-page-listings`).
      for (const ref of ['read-before.md', 'gone.md']) {
        await ctx.db.insert('docPages', {
          sourceId,
          ref,
          title: ref,
          markdown: `# ${ref}`,
          updatedAt: 1,
        });
        await ctx.db.insert('docPageListings', { sourceId, ref, seenBy: 0 });
      }
      await ctx.db.insert('docSyncRuns', {
        sourceId,
        cursor: '25',
        credentialRefs: [],
        pageCount: 1,
        redactionCount: 0,
        state: 'error',
        reason: 'The documentation read was interrupted (timeout).',
        createdAt: Date.now(),
        completedAt: Date.now(),
      });
      return sourceId;
    });
    const fresh = await harness.mutation(internal.docSources.beginSync, { sourceId });
    const run = await harness.run(async (ctx) => await ctx.db.get(fresh));
    expect(run).toMatchObject({ pagesListed: 0, pageCount: 0 });
    expect(run?.cursor).toBeUndefined();
    const stored = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('docPages')
          .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
          .collect()
      ).map((page) => page.ref),
    );
    expect(stored.sort()).toEqual(['gone.md', 'read-before.md']);
  });

  // Re-pinned at 12-S3: the finish no longer reads a run's refs (legacyListedRefs). The
  // sync-runs-refs pass clears them and the run's cursor, so its finish is refused and nothing it
  // named is removed; the next sync reads the source from page one. Re-pinned again at 13-K: the
  // refs declaration and the pass are retired, so the run is seeded as the pass left it.
  it('keeps the page and mirror a run begun before 0.6.0 named once the clearing pass has cleared its cursor, refusing its finish (12-S3)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = limitedHarness();
    const { sourceId, agentId, runId } = await harness.run(async (ctx) => {
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Folder',
        kind: 'folder',
        locator: '.',
        status: 'linking',
        createdAt: 1,
        updatedAt: 1,
      });
      const agentId = await ctx.db.insert('agents', {
        bossEmail: MANAGER_ADDRESS,
        name: 'legacy mirror test',
        userId: 'owner',
        state: 'deployed',
        createdAt: 1,
      });
      // Stored before the upgrade, and not yet given a listing row by the migration.
      await ctx.db.insert('docPages', {
        sourceId,
        ref: 'runbook.md',
        title: 'Runbook',
        markdown: '# Runbook',
        updatedAt: 1,
      });
      await ctx.db.insert('mockDocs', {
        agentId,
        slug: mirroredDocSlug(sourceId, 'runbook.md'),
        title: 'Runbook',
        body: '# Runbook',
        category: 'how-to-guide',
        sourceId,
        sourceRef: 'runbook.md',
        updatedAt: 1,
      });
      // As the sync-runs-refs pass left it at 0.16.0: its refs counted, its cursor taken.
      const runId = await ctx.db.insert('docSyncRuns', {
        sourceId,
        pagesListed: 1,
        credentialRefs: [],
        pageCount: 1,
        redactionCount: 0,
        state: 'running',
        createdAt: Date.now(),
      });
      await ctx.db.patch(sourceId, { activeSyncId: runId });
      return { sourceId, agentId, runId };
    });

    await expect(
      harness.action(internal.docSyncActions.syncBatch, {
        sourceId,
        runId,
        cursor: FINISHING_CURSOR,
      }),
    ).resolves.toMatchObject({ ok: false });

    const ended = await harness.run(async (ctx) => await ctx.db.get(runId));
    expect(ended).toMatchObject({ pagesListed: 1, state: 'running' });
    expect(ended?.cursor).toBeUndefined();
    const left = await harness.run(async (ctx) => ({
      pages: (
        await ctx.db
          .query('docPages')
          .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
          .collect()
      ).map((page) => page.ref),
      mirrors: (
        await ctx.db
          .query('mockDocs')
          .withIndex('by_agent_slug', (index) => index.eq('agentId', agentId))
          .collect()
      ).map((mirror) => mirror.sourceRef),
    }));
    expect(left).toEqual({ pages: ['runbook.md'], mirrors: ['runbook.md'] });
  });

  // Re-pinned at 12-S3: the finish no longer reads a run's refs, and the sync-runs-refs pass clears
  // the cursor of a run begun before 0.6.0, so its checkpoint over the pages themselves is refused
  // and every page stays until a sync from page one lists the source again. Re-pinned again at
  // 13-K: the refs declaration and the pass are retired, so the run is seeded as the pass left it.
  it('refuses the finish of a run begun before 0.6.0 cut off part-way through its pages once the clearing pass has cleared its cursor, and removes nothing (12-S3)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = limitedHarness();
    const { sourceId } = await seedSyncedSource(harness);
    const { runId, checkpoint } = await harness.run(async (ctx) => {
      for (const ref of ['kept.md', 'stale.md']) {
        await ctx.db.insert('docPages', {
          sourceId,
          ref,
          title: ref,
          markdown: `# ${ref}`,
          updatedAt: 1,
        });
        await ctx.db.insert('docPageListings', { sourceId, ref, seenBy: 0 });
      }
      // The pre-0.6.0 walk over the pages, one page in.
      const walked = await ctx.db
        .query('docPages')
        .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
        .paginate({ numItems: 1, cursor: null });
      // As the sync-runs-refs pass left it at 0.16.0: its two refs counted, its checkpoint taken.
      const runId = await ctx.db.insert('docSyncRuns', {
        sourceId,
        pagesListed: 2,
        credentialRefs: [],
        pageCount: 2,
        redactionCount: 0,
        state: 'running',
        createdAt: Date.now(),
      });
      await ctx.db.patch(sourceId, { activeSyncId: runId });
      return {
        runId,
        checkpoint: finishingCursor({ phase: 'pages', cursor: walked.continueCursor }),
      };
    });

    await expect(
      harness.action(internal.docSyncActions.syncBatch, { sourceId, runId, cursor: checkpoint }),
    ).resolves.toMatchObject({ ok: false, complete: true });
    const left = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('docPages')
          .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
          .collect()
      )
        .map((page) => page.ref)
        .sort(),
    );
    expect(left).toEqual(['kept.md', 'page.md', 'stale.md']);

    // The next sync reads from page one; its finish removes what its listing did not name.
    const fresh = await harness.mutation(internal.docSources.beginSync, { sourceId, fresh: true });
    await finishGeneration(harness, sourceId, fresh, {
      refs: ['page.md', 'kept.md'],
      credentialRefs: [],
      pageCount: 2,
      redactionCount: 0,
    });
    const relisted = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('docPages')
          .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
          .collect()
      )
        .map((page) => page.ref)
        .sort(),
    );
    expect(relisted).toEqual(['kept.md', 'page.md']);
  });

  it('removes a page whose batch never recorded, at the next finish that does not name it', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = limitedHarness();
    const { sourceId } = await seedSyncedSource(harness);
    const cut = await harness.mutation(internal.docSources.beginSync, { sourceId });
    // The batch stored the page, then the action died before it recorded the batch.
    await harness.mutation(internal.docSources.upsertPage, {
      sourceId,
      syncRunId: cut,
      ref: 'orphan.md',
      title: 'Orphan',
      markdown: '# Orphan',
      updatedAt: 2,
    });
    const fresh = await harness.mutation(internal.docSources.beginSync, { sourceId, fresh: true });
    await finishGeneration(harness, sourceId, fresh, {
      refs: ['page.md'],
      credentialRefs: [],
      pageCount: 0,
      redactionCount: 0,
    });
    const left = await harness.run(async (ctx) =>
      (
        await ctx.db
          .query('docPages')
          .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
          .collect()
      ).map((page) => page.ref),
    );
    expect(left).toEqual(['page.md']);
  });

  it('prunes more than eight old runs in one pass, now a run carries no list of its pages (13-K)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T00:00:00Z'));
    const harness = limitedHarness();
    const { sourceId } = await seedSyncedSource(harness);
    const old = Date.now() - RUN_HISTORY_MS - 1;
    await harness.run(async (ctx) => {
      for (let index = 0; index < 40; index += 1) {
        await ctx.db.insert('docSyncRuns', {
          sourceId,
          credentialRefs: [],
          pageCount: 1,
          redactionCount: 0,
          state: 'error',
          createdAt: old - index,
          completedAt: old - index,
        });
      }
    });
    await expect(harness.mutation(internal.docSources.pruneRunHistory, { sourceId })).resolves.toBe(
      32,
    );
  });

  it('refuses a batch for a run that carries no listing rather than giving it one, and writes nothing (13-K)', async (): Promise<void> => {
    useSurfaceMode('real');
    vi.useFakeTimers();
    const harness = limitedHarness();
    const { sourceId } = await seedSyncedSource(harness);
    // A run begun before 0.6.0 as the sync-runs-refs pass (0.16.0) left it: no listing, no cursor.
    const runId = await harness.run(async (ctx) => {
      const id = await ctx.db.insert('docSyncRuns', {
        sourceId,
        pagesListed: 1,
        credentialRefs: [],
        pageCount: 1,
        redactionCount: 0,
        state: 'running',
        createdAt: Date.now(),
      });
      await ctx.db.patch(sourceId, { activeSyncId: id });
      return id;
    });

    await expect(
      harness.mutation(internal.docSources.recordSyncBatch, {
        sourceId,
        runId,
        nextCursor: listingCursor(1, ['late.md']),
        refs: ['late.md'],
        credentialRefs: [],
        pageCount: 1,
        redactionCount: 0,
      }),
    ).rejects.toThrow('no listing');
    const after = await harness.run(async (ctx) => ({
      run: await ctx.db.get(runId),
      source: await ctx.db.get(sourceId),
      listed: await ctx.db
        .query('docPageListings')
        .withIndex('by_source_ref', (index) => index.eq('sourceId', sourceId).eq('ref', 'late.md'))
        .first(),
    }));
    expect(after.run).not.toHaveProperty('listing');
    expect(after.run?.pageCount).toBe(1);
    expect(after.source?.listings).toBe(1);
    expect(after.listed).toBeNull();
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

describe("a handed-over employee's mirrors of its old owner's sources (transfer plan 6.2)", (): void => {
  afterEach((): void => {
    vi.useRealTimers();
  });

  it("deletes them page by page and keeps the seeded pages, the new owner's and a colleague's", async (): Promise<void> => {
    vi.useFakeTimers();
    const harness = convexTest(schema, allConvexModules());
    const { moved, colleague } = await harness.run(async (ctx) => {
      const source = async (userId: string): Promise<Id<'docSources'>> =>
        await ctx.db.insert('docSources', {
          userId,
          label: `${userId} handbook`,
          kind: 'folder',
          locator: '.',
          status: 'synced',
          createdAt: 1,
          updatedAt: 1,
        });
      const previous = await source('owner');
      const own = await source('colleague');
      const employee = async (userId: string, name: string): Promise<Id<'agents'>> =>
        await ctx.db.insert('agents', {
          bossEmail: MANAGER_ADDRESS,
          name,
          userId,
          state: 'active',
          createdAt: 1,
        });
      const moved = await employee('colleague', 'Maya');
      const colleague = await employee('owner', 'Tomas');
      const page = async (
        agentId: Id<'agents'>,
        slug: string,
        sourceId?: Id<'docSources'>,
      ): Promise<void> => {
        await ctx.db.insert('mockDocs', {
          agentId,
          slug,
          title: slug,
          body: `# ${slug}`,
          category: 'team-doc',
          ...(sourceId ? { sourceId, sourceRef: `${slug}.md` } : {}),
          updatedAt: 1,
        });
      };
      // More than one page of the paged read, so the delete must schedule itself again.
      for (let index = 0; index < 150; index += 1) await page(moved, `owner-${index}`, previous);
      await page(moved, 'office-welcome');
      await page(moved, 'colleague-onboarding', own);
      await page(colleague, 'owner-0', previous);
      return { moved, colleague };
    });

    await harness.mutation(internal.docSources.pruneDepartedMirrors, { agentId: moved });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);

    const slugsOf = async (agentId: Id<'agents'>): Promise<string[]> =>
      (
        await harness.run(
          async (ctx) =>
            await ctx.db
              .query('mockDocs')
              .withIndex('by_agent_slug', (q) => q.eq('agentId', agentId))
              .collect(),
        )
      )
        .map((doc) => doc.slug)
        .sort();
    expect(await slugsOf(moved)).toEqual(['colleague-onboarding', 'office-welcome']);
    expect(await slugsOf(colleague)).toEqual(['owner-0']);
  });
});

describe('the anonymous-caller guard before the mode (12-G)', (): void => {
  it('refuses a caller with no identity before it says the deployment runs in mock mode', async (): Promise<void> => {
    useSurfaceMode('mock');
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await goneRowOf(harness, 'docSources');
    const refusal = await guardRefusal();
    await expect(
      harness.action(api.docSources.link, {
        label: 'Wiki',
        kind: 'mcp',
        locator: 'https://wiki.test',
      }),
    ).rejects.toMatchObject(refusal);
    await expect(harness.mutation(api.docSources.resync, { sourceId })).rejects.toMatchObject(
      refusal,
    );
    await expect(
      harness.action(api.docSources.rotateCredential, { sourceId, credential: 'fake-key' }),
    ).rejects.toMatchObject(refusal);
    await expect(harness.mutation(api.docSources.unlink, { sourceId })).rejects.toMatchObject(
      refusal,
    );
  });
});
