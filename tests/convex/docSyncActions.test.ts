/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { convexTest, type TestConvex } from 'convex-test';
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveSpanModel } from '../fixtures/redaction-double';
import { internal } from '../../convex/_generated/api';
import { FolderReader } from '../../src/docs/readers/folder';
import { UrlsReader } from '../../src/docs/readers/urls';
import { RedactorUnavailableError } from '../../src/redaction/client';
import type { ActionCtx } from '../../convex/_generated/server';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { LINEAR_TOKEN_PLACEHOLDER, notionPageTemplate } from '../fixtures/notion-pages';
import {
  SYNC_BATCH_SIZE,
  categoryForPage,
  persistPageBatch,
  safeSyncError,
} from '../../convex/docSyncActions';
import type { DocPage } from '../../src/docs/types';
import { FINISHING_CURSOR } from '../../convex/docSources';
import {
  credentialValueFingerprint,
  encrypt,
  openOwnedCredential as openSpy,
} from '../../src/lib/credential-crypto';
import { credentialSourceRef } from '../../src/docs/redaction';
import { ownerValuesRef } from '../../src/redaction/known-values';
import { temporaryDirectories } from '../setup/temporary-directories';

const temporary = temporaryDirectories();

// The redaction component the actions reach through DAY0_REDACTOR_URL, served
// in-process from the recorded span model.
let redactorDouble: { url: string; close: () => Promise<void> } | undefined;
beforeAll(async (): Promise<void> => {
  redactorDouble = await serveSpanModel();
  process.env.DAY0_REDACTOR_URL = redactorDouble.url;
});
afterAll(async (): Promise<void> => {
  delete process.env.DAY0_REDACTOR_URL;
  await redactorDouble?.close();
});

vi.mock('../../src/lib/credential-crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/lib/credential-crypto')>();
  return { ...original, openOwnedCredential: vi.fn(original.openOwnedCredential) };
});

const { schemaChecked } = await vi.hoisted(async () => await import('./fakes/mastra'));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: schemaChecked(() => ({ systems: [] })),
}));

/**
 * Run the scheduled continuations due now, without firing the timeouts of
 * the redaction calls in flight: `vi.runAllTimers` would fire every
 * `AbortSignal.timeout` at once and cut the in-process redactor off, which
 * the whole file's order hid.
 */
function drainScheduled(): void {
  vi.advanceTimersByTime(0);
}

/** Build a token-shaped value at runtime so no fixture stores one verbatim. */
function token(parts: string[], separator: string, suffix: string): string {
  return `${parts.join(separator)}${separator}${suffix}`;
}

/**
 * The source ref the sync gives a value on a page under the key the test
 * stubbed for the deployment.
 */
function valueRef(pageRef: string, value: string, userId: string): string {
  const key = process.env.DAY0_CREDENTIAL_KEY;
  if (key === undefined) throw new Error('The test stubs no DAY0_CREDENTIAL_KEY.');
  return credentialSourceRef(pageRef, credentialValueFingerprint(value, key, userId));
}

/** Create the source fields used by the persistence boundary. */
function source(): Doc<'docSources'> {
  return {
    _id: 'source-contract' as Id<'docSources'>,
    _creationTime: 1,
    userId: 'owner-contract',
    label: 'Contract docs',
    kind: 'folder',
    locator: '.',
    status: 'linking',
    activeSyncId: 'run-contract' as Id<'docSyncRuns'>,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Create a minimal inheriting agent for mirror verification. */
function agent(): Doc<'agents'> {
  return {
    _id: 'agent-contract' as Id<'agents'>,
    _creationTime: 1,
    bossEmail: 'owner@example.test',
    name: 'Contract agent',
    userId: 'owner-contract',
    state: 'active',
    createdAt: 1,
  };
}

afterEach((): void => {
  vi.restoreAllMocks();
});

describe('documentation sync action helpers', (): void => {
  it('classifies runbooks from the title or first heading', (): void => {
    expect(categoryForPage({ title: 'How to update tickets', markdown: 'Body' })).toBe(
      'how-to-guide',
    );
    expect(categoryForPage({ title: 'Ticketing', markdown: '# Runbook for tickets\nBody' })).toBe(
      'how-to-guide',
    );
    for (const ref of [
      'revops/runbooks/q3-close-checklist.md',
      'how-to/billing.md',
      'playbooks/incident.md',
      'Runbook/refunds.md',
    ]) {
      expect(
        categoryForPage({ ref, title: 'Q3 close checklist', markdown: '# Q3 close checklist' }),
        ref,
      ).toBe('how-to-guide');
    }
    expect(
      categoryForPage({ ref: 'revops/handbook.md', title: 'Handbook', markdown: '# Handbook' }),
    ).toBe('team-doc');
    expect(categoryForPage({ title: 'Team overview', markdown: '# Team overview' })).toBe(
      'team-doc',
    );
    expect(SYNC_BATCH_SIZE).toBe(25);
  });

  it('reads a procedures directory from the path segments of the page, never its query or file name (review m33)', (): void => {
    const page = { title: 'Refund policy', markdown: '# Refund policy' };
    for (const ref of [
      'https://wiki.example/view?p=/how-to/refunds',
      'https://wiki.example/view#/runbooks/refunds',
      'https://wiki.example/pages/refunds?from=/playbooks/',
      'revops/how-to.md',
      'notes/my-runbooks/refunds.md',
    ]) {
      expect(categoryForPage({ ...page, ref }), ref).toBe('team-doc');
    }
    for (const ref of [
      'https://wiki.example/runbooks/refunds',
      'https://wiki.example/space/How-To/refunds?version=2',
      'https://wiki.example/how-to/',
      'finance/playbooks/refunds.md',
    ]) {
      expect(categoryForPage({ ...page, ref }), ref).toBe('how-to-guide');
    }
  });

  it('redacts explicit and recognisable credential values from errors', (): void => {
    expect(safeSyncError(new Error('failed token-value'), 'token-value')).toBe('failed <redacted>');
    expect(safeSyncError(new Error(`failed xox${'b'}-contract-value`))).toBe('failed <redacted>');
    expect(
      safeSyncError(
        new Error(`failed ${token(['secret'], '_', 'contract-value-0123456789abcdefghijklmnop')}`),
      ),
    ).toBe('failed <redacted>');
  });

  it('stores raw values only in credential actions and persists markers everywhere else', async (): Promise<void> => {
    const suffix = 'contract-value-0123456789abcdef';
    const values = [
      token(['ntn'], '_', suffix),
      token(['lin', 'api'], '_', suffix),
      `xox${'b'}-${suffix}`,
      `xox${'p'}-${suffix}`,
      `xox${'a'}-${suffix}`,
      token(['secret'], '_', suffix),
      `generic-${suffix}`,
      token(['ntn'], '_', `title-${suffix}`),
    ];
    const linearTemplate = notionPageTemplate('linear-automation').replace(
      LINEAR_TOKEN_PLACEHOLDER,
      values[1],
    );
    const bodies = [
      `# Notion\n\nValue: ${values[0]}`,
      linearTemplate,
      `# Slack bot\n\nValue: ${values[2]}`,
      `# Slack user\n\nValue: ${values[3]}`,
      `# Slack app\n\nValue: ${values[4]}`,
      `# Secret\n\nValue: ${values[5]}`,
      `# Billing\n\nAPI key: ${values[6]}`,
      `# Heading ${values[7]}\n\nbody`,
    ];
    const pages: DocPage[] = bodies.map(
      (markdown: string, index: number): DocPage => ({
        sourceId: source()._id,
        ref: `page-${index}`,
        title: index === bodies.length - 1 ? `Provider title ${values[7]}` : `Page ${index}`,
        markdown,
        updatedAt: 1,
      }),
    );
    const actionCalls: unknown[] = [];
    const fingerprintCalls: unknown[] = [];
    const mutationCalls: unknown[] = [];
    const credentialKey = randomBytes(32).toString('base64');
    const ctx = {
      runAction: async (
        reference: unknown,
        args: { plaintext: string; userId: string },
      ): Promise<Id<'credentials'> | string | string[]> => {
        const name = getFunctionName(reference as never);
        // The boundary asks for the owner's stored values first; this owner has none.
        if (name === getFunctionName(ownerValuesRef)) return [];
        if (name === getFunctionName(internal.credentialCryptoActions.fingerprint)) {
          fingerprintCalls.push(args);
          return credentialValueFingerprint(args.plaintext, credentialKey, args.userId);
        }
        actionCalls.push(args);
        return `credential-${actionCalls.length}` as Id<'credentials'>;
      },
      runMutation: async (_reference: unknown, args: unknown): Promise<unknown> => {
        mutationCalls.push(args);
        return undefined;
      },
    } as unknown as ActionCtx;
    const log = vi.spyOn(console, 'log').mockImplementation((): void => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation((): void => undefined);

    const result = await persistPageBatch(ctx, source(), pages, [agent()]);

    // Each page holds one value, keyed by the page and the value's fingerprint.
    const credentialRefs = pages.map((page: DocPage, index: number): string =>
      credentialSourceRef(
        page.ref,
        credentialValueFingerprint(values[index], credentialKey, source().userId),
      ),
    );
    expect(result).toEqual({
      refs: pages.map((page: DocPage): string => page.ref),
      credentialRefs,
      pages: pages.length,
      redactions: values.length,
      unread: [],
    });
    expect(actionCalls).toHaveLength(values.length);
    expect(actionCalls).toEqual(
      credentialRefs.map((ref: string) =>
        expect.objectContaining({ source: { sourceId: source()._id, ref } }),
      ),
    );
    expect(fingerprintCalls).toHaveLength(values.length);
    for (const value of values) {
      expect(
        actionCalls.some((call: unknown): boolean => JSON.stringify(call).includes(value)),
      ).toBe(true);
      expect(JSON.stringify(mutationCalls)).not.toContain(value);
      expect(JSON.stringify(log.mock.calls)).not.toContain(value);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(value);
      expect(JSON.stringify(error.mock.calls)).not.toContain(value);
    }
    const persisted = JSON.stringify(mutationCalls);
    expect(persisted).toContain('<credential: linear service token, stored>');
    expect(persisted).toContain('"title":"Heading <credential: notion connection token, stored>"');
    expect(persisted).toContain('body');
    expect(persisted).toContain('markdown');
    expect(persisted).not.toContain('events');
  });
});

describe('documentation sync batching', (): void => {
  /**
   * Lay out a 60-page folder with one token-bearing page under a fresh root.
   *
   * Returns:
   *   The fixture root and the runtime-built token it hides on page 30.
   */
  async function sixtyPages(): Promise<{ root: string; value: string }> {
    const root = temporary('day0-sync-batch-');
    await mkdir(join(root, 'many'));
    const value = token(['lin', 'api'], '_', 'batch-contract-0123456789abcdef');
    for (let index = 1; index <= 60; index += 1) {
      const name = `page-${String(index).padStart(2, '0')}.md`;
      const body =
        index === 30
          ? `# Page ${index}\n\nService token: ${value}\n`
          : `# Page ${index}\n\nBody ${index}\n`;
      await writeFile(join(root, 'many', name), body, 'utf8');
    }
    return { root, value };
  }

  /** Read the pending scheduled continuations. */
  async function scheduled(
    harness: TestConvex<typeof schema>,
  ): Promise<Array<Record<string, unknown>>> {
    return await harness.run(
      async (ctx) =>
        (await ctx.db.system.query('_scheduled_functions').collect()).filter(
          (job) => job.state.kind === 'pending',
        ) as unknown as Array<Record<string, unknown>>,
    );
  }

  beforeEach((): void => {
    vi.useFakeTimers();
    vi.stubEnv('DAY0_CREDENTIAL_KEY', randomBytes(32).toString('base64'));
  });

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('syncs 60 pages in three fenced batches whose continuations carry only ids', async (): Promise<void> => {
    const { root, value } = await sixtyPages();
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Many',
      kind: 'folder',
      locator: 'many',
    });
    const first = await harness.action(internal.docSyncActions.syncSource, { sourceId });
    expect(first).toMatchObject({ ok: true, pages: 25, complete: false });
    const pending = await scheduled(harness);
    expect(pending).toHaveLength(1);
    expect(pending[0].name).toBe('docSyncActions:syncBatch');
    expect(pending[0].args).toEqual([
      { sourceId, runId: expect.any(String), cursor: expect.stringMatching(/^25@[0-9a-z]{7}$/) },
    ]);
    expect(JSON.stringify(pending)).not.toContain(value);
    await expect(
      harness.query(internal.docSources.syncReport, { sourceId }),
    ).resolves.toMatchObject({ status: 'linking', running: true, pageCount: 25 });
    await harness.finishAllScheduledFunctions(drainScheduled);
    await expect(
      harness.query(internal.docSources.syncReport, { sourceId }),
    ).resolves.toMatchObject({
      status: 'synced',
      running: false,
      pageCount: 60,
      redactionCount: 1,
    });
    const runs = await harness.run(async (ctx) => await ctx.db.query('docSyncRuns').collect());
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: 'completed', pageCount: 60, refs: expect.any(Array) });
    expect(runs[0].refs).toHaveLength(60);
    expect(JSON.stringify(runs)).not.toContain(value);
    const pages = (
      await harness.query(internal.docSources.pagesForSourceInternal, {
        sourceId,
        paginationOpts: { numItems: 100, cursor: null },
      })
    ).page;
    expect(pages).toHaveLength(60);
    expect(JSON.stringify(pages)).not.toContain(value);
    expect(pages.find((page) => page.ref === 'page-30.md')?.markdown).toContain(
      '<credential: linear service token, stored>',
    );
    const credentials = await harness.run(
      async (ctx) => await ctx.db.query('credentials').collect(),
    );
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({
      source: { sourceId, ref: valueRef('page-30.md', value, 'owner') },
    });
    await expect(
      harness.action(internal.credentials.decrypt, { credentialId: credentials[0]._id }),
    ).resolves.toBe(value);
  }, 30_000);

  it('lets a manual resync supersede a running generation and finishes once', async (): Promise<void> => {
    const { root } = await sixtyPages();
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Many',
      kind: 'folder',
      locator: 'many',
    });
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    const stale = (await scheduled(harness))[0].args as Array<{ runId: Id<'docSyncRuns'> }>;
    const second = await harness.action(internal.docSyncActions.syncSource, { sourceId });
    expect(second).toMatchObject({ ok: true, pages: 25, complete: false });
    await harness.finishAllScheduledFunctions(drainScheduled);
    const runs = await harness.run(async (ctx) => await ctx.db.query('docSyncRuns').collect());
    expect(runs.map((run) => run.state).sort()).toEqual(['completed', 'superseded']);
    expect(runs.find((run) => run._id === stale[0].runId)?.state).toBe('superseded');
    expect(runs.find((run) => run.state === 'completed')?.pageCount).toBe(60);
    await expect(
      harness.query(internal.docSources.syncReport, { sourceId }),
    ).resolves.toMatchObject({ status: 'synced', running: false, pageCount: 60 });
  });

  it('records a reader failure as an error without losing the pages already stored', async (): Promise<void> => {
    const { root } = await sixtyPages();
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Many',
      kind: 'folder',
      locator: 'many',
    });
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    await rm(join(root, 'many'), { recursive: true, force: true });
    await harness.finishAllScheduledFunctions(drainScheduled);
    await expect(
      harness.query(internal.docSources.syncReport, { sourceId }),
    ).resolves.toMatchObject({ status: 'error', running: false, pageCount: 25 });
    const source = await harness.query(internal.docSources.getInternal, { sourceId });
    expect(source?.lastError).toMatch(/ENOENT|no such file/i);
    expect(source).not.toHaveProperty('activeSyncId');
  });

  it('records a read cut off mid-sync as a transient with its cause', async (): Promise<void> => {
    const { root } = await sixtyPages();
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Many',
      kind: 'folder',
      locator: 'many',
    });
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    vi.spyOn(FolderReader.prototype, 'listPageBatch').mockRejectedValueOnce(
      new Error('fetch failed', {
        cause: Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      }),
    );
    await harness.finishAllScheduledFunctions(drainScheduled);
    const source = await harness.query(internal.docSources.getInternal, { sourceId });
    expect(source?.lastError).toBe(
      'The documentation read was interrupted (read ETIMEDOUT); this is transient, and the next attempt reads it again.',
    );
  });

  it('records a stopped redaction component as itself, not as a transient read', async (): Promise<void> => {
    const { root } = await sixtyPages();
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Many',
      kind: 'folder',
      locator: 'many',
    });
    vi.spyOn(FolderReader.prototype, 'listPageBatch').mockRejectedValueOnce(
      new RedactorUnavailableError(
        'redaction component unreachable at redactor:8000: read ECONNRESET',
      ),
    );
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    const source = await harness.query(internal.docSources.getInternal, { sourceId });
    expect(source?.lastError).toBe(
      'redaction component unreachable at redactor:8000: read ECONNRESET',
    );
  });

  it('keeps a page it cannot store at its last version, with its credential, and completes the sync (P5-11)', async (): Promise<void> => {
    const root = temporary('day0-sync-unread-');
    await mkdir(join(root, 'few'));
    const value = token(['lin', 'api'], '_', 'unread-contract-0123456789abcdef');
    await writeFile(join(root, 'few', 'handbook.md'), '# Handbook\n\nFirst.\n', 'utf8');
    await writeFile(
      join(root, 'few', 'tile.md'),
      `# Tile runbook\n\nService token: ${value}\n`,
      'utf8',
    );
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Few',
      kind: 'folder',
      locator: 'few',
    });
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    const before = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('docPages')
          .withIndex('by_source_ref', (index) =>
            index.eq('sourceId', sourceId).eq('ref', 'tile.md'),
          )
          .unique(),
    );
    expect(before?.markdown).toContain('<credential: linear service token, stored>');

    // The runbook grows past what Day0 stores; the handbook changes as usual.
    await writeFile(
      join(root, 'few', 'tile.md'),
      `# Tile runbook\n\nService token: ${value}\n\n${'Step.\n'.repeat(160_000)}`,
      'utf8',
    );
    await writeFile(join(root, 'few', 'handbook.md'), '# Handbook\n\nSecond.\n', 'utf8');
    await expect(
      harness.action(internal.docSyncActions.syncSource, { sourceId }),
    ).resolves.toMatchObject({ ok: true, pages: 1, complete: true });

    const after = await harness.run(async (ctx) => ({
      pages: await ctx.db
        .query('docPages')
        .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
        .collect(),
      credentials: await ctx.db.query('credentials').collect(),
      runs: await ctx.db.query('docSyncRuns').order('desc').collect(),
      source: await ctx.db.get(sourceId),
    }));
    expect(after.pages.find((page) => page.ref === 'tile.md')).toMatchObject({
      markdown: before?.markdown,
      updatedAt: before?.updatedAt,
    });
    expect(after.pages.find((page) => page.ref === 'handbook.md')?.markdown).toContain('Second.');
    expect(after.credentials).toHaveLength(1);
    expect(after.credentials[0].status).toBeUndefined();
    // The value-keyed ref keeps its page part, which is how the unread page's
    // rows were found and kept (D8).
    expect(after.credentials[0].source).toEqual({
      sourceId,
      ref: valueRef('tile.md', value, 'owner'),
    });
    expect(after.runs[0]).toMatchObject({ state: 'completed' });
    expect(after.runs[0].reason).toBeUndefined();
    expect(after.runs[0].unread).toEqual({
      count: 1,
      pages: [
        {
          ref: 'tile.md',
          reason: expect.stringMatching(
            /^The page is \d+ KiB, larger than the 768 KiB Day0 stores\.$/,
          ),
        },
      ],
    });
    expect(after.source).toMatchObject({ status: 'synced' });
    expect(after.source?.lastError).toMatch(
      /^1 page could not be read this sync and keeps its last stored version: tile\.md: The page is \d+ KiB, larger than the 768 KiB Day0 stores\. The next sync reads them again\.$/,
    );
    expect(JSON.stringify(after)).not.toContain(value);
  });

  /**
   * Sync a one-folder source once per body given for `runbook.md`, and read
   * back every credential row after each sync.
   */
  async function syncEachVersion(
    prefix: string,
    bodies: readonly string[],
  ): Promise<{ sourceId: Id<'docSources'>; after: Doc<'credentials'>[][] }> {
    const root = temporary(prefix);
    await mkdir(join(root, 'docs'));
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Runbooks',
      kind: 'folder',
      locator: 'docs',
    });
    const after: Doc<'credentials'>[][] = [];
    for (const body of bodies) {
      await writeFile(join(root, 'docs', 'runbook.md'), body, 'utf8');
      await expect(
        harness.action(internal.docSyncActions.syncSource, { sourceId }),
      ).resolves.toMatchObject({ ok: true, complete: true });
      after.push(await harness.run(async (ctx) => await ctx.db.query('credentials').collect()));
    }
    return { sourceId, after };
  }

  it('keeps a relabelled value as the same credential, under the new label (P6-13)', async (): Promise<void> => {
    const value = 'generic-contract-value-0123456789abcdef';
    const { sourceId, after } = await syncEachVersion('day0-sync-relabel-', [
      `# Billing\n\nAPI key: ${value}\n`,
      `# Billing\n\nAccess key: ${value}\n`,
    ]);
    expect(after[0]).toHaveLength(1);
    expect(after[0][0].label).toBe('billing api key');
    expect(after[1]).toHaveLength(1);
    expect(after[1][0]).toMatchObject({
      _id: after[0][0]._id,
      label: 'billing access key',
      source: { sourceId, ref: valueRef('runbook.md', value, 'owner') },
    });
    expect(after[1][0].status).toBeUndefined();
  });

  it('keeps a value that moved down the page when a second one was added above it (P5-12)', async (): Promise<void> => {
    const kept = token(['lin', 'api'], '_', 'moved-contract-0123456789abcdef');
    const added = token(['lin', 'api'], '_', 'added-contract-0123456789abcdef');
    const { sourceId, after } = await syncEachVersion('day0-sync-move-', [
      `# Tile runbook\n\nService token: ${kept}\n`,
      `# Tile runbook\n\nService token: ${added}\n\nThe older one:\n\nService token: ${kept}\n`,
    ]);
    expect(after[0]).toHaveLength(1);
    const keptRow = after[1].find((row) => row._id === after[0][0]._id);
    expect(keptRow).toMatchObject({
      source: { sourceId, ref: valueRef('runbook.md', kept, 'owner') },
    });
    expect(keptRow?.status).toBeUndefined();
    expect(after[1]).toHaveLength(2);
    expect(after[1].find((row) => row._id !== after[0][0]._id)).toMatchObject({
      source: { sourceId, ref: valueRef('runbook.md', added, 'owner') },
    });
  });

  it('stores a value swapped in under the same label as a new credential and supersedes the old one, which revives if it returns (P7-15)', async (): Promise<void> => {
    const original = token(['lin', 'api'], '_', 'original-contract-0123456789abcdef');
    const swapped = token(['lin', 'api'], '_', 'swapped-contract-0123456789abcdef');
    const { after } = await syncEachVersion('day0-sync-swap-', [
      `# Tile runbook\n\nService token: ${original}\n`,
      `# Tile runbook\n\nService token: ${swapped}\n`,
      `# Tile runbook\n\nService token: ${original}\n`,
    ]);
    const [originalRow] = after[0];
    expect(after[1]).toHaveLength(2);
    const swappedRow = after[1].find((row) => row._id !== originalRow._id);
    expect(swappedRow).toMatchObject({
      label: originalRow.label,
      source: { ref: valueRef('runbook.md', swapped, 'owner') },
    });
    expect(swappedRow?.status).toBeUndefined();
    expect(after[1].find((row) => row._id === originalRow._id)).toMatchObject({
      status: 'superseded',
      source: originalRow.source,
    });
    // The original value back on the page is the original credential again.
    expect(after[2]).toHaveLength(2);
    expect(after[2].find((row) => row._id === originalRow._id)?.status).toBeUndefined();
    expect(after[2].find((row) => row._id === swappedRow?._id)?.status).toBe('superseded');
  });

  it('resumes a sync that failed at page 300 of 500 at page 300, not page one (step 17)', async (): Promise<void> => {
    const root = temporary('day0-sync-resume-');
    await mkdir(join(root, 'many'));
    for (let index = 1; index <= 500; index += 1) {
      await writeFile(
        join(root, 'many', `page-${String(index).padStart(3, '0')}.md`),
        `# Page ${index}\n\nBody ${index}\n`,
        'utf8',
      );
    }
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Many',
      kind: 'folder',
      locator: 'many',
    });
    const read = FolderReader.prototype.listPageBatch;
    let cutOff = false;
    const reads = vi
      .spyOn(FolderReader.prototype, 'listPageBatch')
      .mockImplementation(async function (this: FolderReader, ...args) {
        if (args[2]?.startsWith('300@') && !cutOff) {
          cutOff = true;
          throw new Error('fetch failed', {
            cause: Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' }),
          });
        }
        return await read.apply(this, args);
      });
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    await harness.finishAllScheduledFunctions(drainScheduled);
    await expect(
      harness.query(internal.docSources.syncReport, { sourceId }),
    ).resolves.toMatchObject({ status: 'error', pageCount: 300 });

    reads.mockClear();
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    await harness.finishAllScheduledFunctions(drainScheduled);

    expect(reads.mock.calls.map((call) => call[2]?.split('@')[0])).toEqual([
      '300',
      '325',
      '350',
      '375',
      '400',
      '425',
      '450',
      '475',
    ]);
    await expect(
      harness.query(internal.docSources.syncReport, { sourceId }),
    ).resolves.toMatchObject({ status: 'synced', running: false, pageCount: 500 });
    const [completed, failed] = await harness.run(
      async (ctx) => await ctx.db.query('docSyncRuns').order('desc').collect(),
    );
    expect(completed).toMatchObject({ state: 'completed', pageCount: 500 });
    expect(new Set(completed.refs).size).toBe(500);
    expect(failed).toMatchObject({
      state: 'error',
      cursor: expect.stringMatching(/^300@[0-9a-z]{7}$/),
      pageCount: 300,
    });
    expect(failed.reason).toBe(
      'The documentation read was interrupted (read ETIMEDOUT); this is transient, and the next attempt reads it again. A newer sync of the source took over from its cursor after 300 pages.',
    );
  }, 60_000);

  it('reads the source again from page one when its listing changed under a resumed cursor (adversarial pass, step 17)', async (): Promise<void> => {
    const root = temporary('day0-sync-listing-');
    await mkdir(join(root, 'many'));
    const name = (index: number): string => `page-${String(index).padStart(3, '0')}.md`;
    for (let index = 1; index <= 100; index += 1) {
      await writeFile(join(root, 'many', name(index)), `# Page ${index}\n`, 'utf8');
    }
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Many',
      kind: 'folder',
      locator: 'many',
    });
    const read = FolderReader.prototype.listPageBatch;
    let cutOff = false;
    vi.spyOn(FolderReader.prototype, 'listPageBatch').mockImplementation(async function (
      this: FolderReader,
      ...args
    ) {
      if (args[2]?.split('@')[0] === '50' && !cutOff) {
        cutOff = true;
        throw new Error('fetch failed', {
          cause: Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        });
      }
      return await read.apply(this, args);
    });
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    await harness.finishAllScheduledFunctions(drainScheduled);

    // A page before the cursor goes: the page that was 51st is now 50th.
    await rm(join(root, 'many', name(10)));
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    await harness.finishAllScheduledFunctions(drainScheduled);

    const state = await harness.run(async (ctx) => ({
      pages: await ctx.db
        .query('docPages')
        .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
        .collect(),
      runs: await ctx.db.query('docSyncRuns').order('desc').collect(),
    }));
    expect(state.pages.map((page) => page.ref).sort()).toEqual(
      Array.from({ length: 100 }, (_value, index) => name(index + 1)).filter(
        (ref) => ref !== name(10),
      ),
    );
    expect(state.runs[0]).toMatchObject({ state: 'completed', pageCount: 99 });
    expect(state.runs[1]).toMatchObject({ state: 'superseded' });
    expect(state.runs[1].reason).toContain('the listing changed under its cursor');
  });

  it('stops a source whose reader secret was revoked as a credential to land, and reads nothing (E-74)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.run(async (ctx) => {
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Wiki reader secret',
        source: 'entered',
        createdAt: 1,
        revokedAt: 2,
      });
      return await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Wiki',
        kind: 'urls',
        locator: 'https://wiki.example/one',
        credentialId,
        status: 'synced',
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const reads = vi.spyOn(UrlsReader.prototype, 'listPageBatch');
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    expect(reads).not.toHaveBeenCalled();
    expect(await harness.run(async (ctx) => await ctx.db.get(sourceId))).toMatchObject({
      status: 'credential-not-landed',
    });
  });

  it('words a failure while finishing as the error it is, not as a credential to land (adversarial pass)', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const { sourceId, runId } = await harness.run(async (ctx) => {
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Notion connection secret',
        source: 'entered',
        createdAt: 1,
        ...encrypt('connection-contract-value', process.env.DAY0_CREDENTIAL_KEY ?? ''),
      });
      const sourceId = await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Notion',
        kind: 'mcp',
        serverKind: 'notion',
        locator: 'http://notion-mcp:3000/mcp',
        credentialId,
        status: 'linking',
        createdAt: 1,
        updatedAt: 1,
      });
      const runId = await ctx.db.insert('docSyncRuns', {
        sourceId,
        cursor: FINISHING_CURSOR,
        refs: [],
        credentialRefs: [],
        pageCount: 0,
        redactionCount: 0,
        state: 'running',
        createdAt: 1,
      });
      await ctx.db.patch(sourceId, { activeSyncId: runId });
      // More page-derived credentials than one source may hold: the finish refuses.
      for (let index = 0; index < 1_001; index += 1) {
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'value',
          label: `value ${index}`,
          source: { sourceId, ref: `page-${index}` },
          ciphertext: 'sealed',
          iv: 'iv',
          createdAt: 1,
        });
      }
      return { sourceId, runId };
    });
    await harness.action(internal.docSyncActions.syncBatch, {
      sourceId,
      runId,
      cursor: FINISHING_CURSOR,
    });
    expect(await harness.run(async (ctx) => await ctx.db.get(sourceId))).toMatchObject({
      status: 'error',
      lastError: expect.stringContaining('Source exceeds 1,000 credentials.'),
    });
  });

  it('reads a private wiki with the reader secret it was linked with, and keeps the secret out of every stored reason (E-74)', async (): Promise<void> => {
    const secret = 'wiki-reader-contract-0123456789';
    const key = process.env.DAY0_CREDENTIAL_KEY ?? '';
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.run(async (ctx) => {
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Wiki reader secret',
        source: 'entered',
        createdAt: 1,
        ...encrypt(secret, key),
      });
      return await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Wiki',
        kind: 'urls',
        locator: 'https://wiki.example/one\nhttps://wiki.example/two',
        credentialId,
        status: 'linking',
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const seen: Array<string | null> = [];
    // The in-process redactor is reached through fetch too; only the wiki is faked.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (!String(input).startsWith('https://wiki.example/')) return await realFetch(input, init);
        seen.push(new Headers(init?.headers).get('authorization'));
        if (String(input).endsWith('/two')) {
          // A failure that echoes the secret across where a 200-character cut once fell.
          throw new Error(`${'refused by the wiki gateway; '.repeat(6)}token ${secret} rejected`);
        }
        return new Response('# One', { headers: { 'content-type': 'text/markdown' } });
      }),
    );
    try {
      await expect(
        harness.action(internal.docSyncActions.syncSource, { sourceId }),
      ).resolves.toMatchObject({ ok: true, pages: 1, complete: true });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(seen).toEqual([`Bearer ${secret}`, `Bearer ${secret}`]);
    const stored = await harness.run(async (ctx) => ({
      source: await ctx.db.get(sourceId),
      runs: await ctx.db.query('docSyncRuns').collect(),
    }));
    expect(stored.source).toMatchObject({ status: 'synced' });
    expect(stored.source?.lastError).toContain('https://wiki.example/two: refused by the wiki');
    expect(stored.runs[0].unread?.pages[0].reason).toContain('<redacted>');
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(secret.slice(0, 12));
  });

  it('decrypts the owner list once per batch, not once per page, and keeps its values out of every page', async (): Promise<void> => {
    const root = temporary('day0-sync-known-');
    await mkdir(join(root, 'few'));
    const stored = ['Sunny-Day-42', 'Winter2026!'];
    for (let index = 1; index <= 3; index += 1) {
      await writeFile(
        join(root, 'few', `page-${index}.md`),
        `# Page ${index}\n\nThe tile password is ${stored[index % 2]}; ask Priya.\n`,
        'utf8',
      );
    }
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const key = process.env.DAY0_CREDENTIAL_KEY ?? '';
    const harness = convexTest(schema, allConvexModules());
    await harness.run(async (ctx) => {
      for (const value of stored) {
        await ctx.db.insert('credentials', {
          userId: 'owner',
          kind: 'value',
          label: 'Looker tile password',
          source: 'entered',
          createdAt: 1,
          ...encrypt(value, key),
        });
      }
    });
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Few',
      kind: 'folder',
      locator: 'few',
    });
    vi.mocked(openSpy).mockClear();
    await expect(
      harness.action(internal.docSyncActions.syncSource, { sourceId }),
    ).resolves.toMatchObject({
      ok: true,
      pages: 3,
      complete: true,
    });
    // One open per stored row for the whole batch: the list is resolved
    // once and handed to every page.
    expect(vi.mocked(openSpy)).toHaveBeenCalledTimes(stored.length);
    const pages = (
      await harness.query(internal.docSources.pagesForSourceInternal, {
        sourceId,
        paginationOpts: { numItems: 100, cursor: null },
      })
    ).page;
    expect(pages).toHaveLength(3);
    for (const value of stored) expect(JSON.stringify(pages)).not.toContain(value);
    expect(pages.every((page) => page.markdown.includes('<credential: '))).toBe(true);
  });
});
