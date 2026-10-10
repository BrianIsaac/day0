/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { convexTest, type TestConvex } from 'convex-test';
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeSpanModelFetch, SPAN_MODEL_TEST_URL } from '../fixtures/redaction-double';
import { internal } from '../../convex/_generated/api';
import { FolderReader } from '../../src/docs/readers/folder';
import { UrlsReader, __setPageConnectionForTest } from '../../src/docs/readers/urls';
import { privateHostAllowlist } from '../../src/lib/private-hosts';
import { RedactorUnavailableError } from '../../src/redaction/client';
import type { ActionCtx } from '../../convex/_generated/server';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { LINEAR_TOKEN_PLACEHOLDER, notionPageTemplate } from '../fixtures/notion-pages';
import {
  LISTING_RESTARTS_REASON,
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
import { credentialSourceRef } from '../../src/docs/credential-ref';
import { ownerValuesRef } from '../../src/redaction/known-values';
import { temporaryDirectories } from '../setup/temporary-directories';

const temporary = temporaryDirectories();

// The redaction component the actions reach through DAY0_REDACTOR_URL, answered
// in-process from the recorded span model by the global fetch each test starts
// with, never over a socket: the batching tests fake setTimeout, and from undici
// 6.28 (Node 22.23) a request on a pooled socket waits for a zero-delay timer
// that a faked clock never fires (about 6 s a test until the double dropped the
// socket, 12-N, 5 October 2026). A test that stubs fetch again keeps the route by
// handing on to the global it found.
const redactorFetch = routeSpanModelFetch(globalThis.fetch);
beforeAll((): void => {
  process.env.DAY0_REDACTOR_URL = SPAN_MODEL_TEST_URL;
});
afterAll((): void => {
  delete process.env.DAY0_REDACTOR_URL;
});
beforeEach((): void => {
  vi.stubGlobal('fetch', redactorFetch);
});
afterEach((): void => {
  vi.unstubAllGlobals();
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

describe('the unchanged-page skip at the persistence boundary (P8-10, 14-I)', (): void => {
  /** A fixed 32-byte credential key in standard base64. */
  const KEY = Buffer.alloc(32, 7).toString('base64');

  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  /** A fake action context: the stored page the skip reads, and every mutation it asks for. */
  function contextWith(stored: { title: string; markdown: string } | null): {
    ctx: ActionCtx;
    queries: string[];
    upserts: Array<Record<string, unknown>>;
  } {
    const queries: string[] = [];
    const upserts: Array<Record<string, unknown>> = [];
    const ctx = {
      runQuery: async (reference: unknown): Promise<unknown> => {
        const name = getFunctionName(reference as never);
        queries.push(name);
        if (name === getFunctionName(internal.docBlocks.unchangedPage)) return stored;
        return [];
      },
      runAction: async (reference: unknown): Promise<string> =>
        getFunctionName(reference as never) ===
        getFunctionName(internal.credentialCryptoActions.fingerprint)
          ? 'f'.repeat(32)
          : 'credential-1',
      runMutation: async (reference: unknown, args: Record<string, unknown>): Promise<unknown> => {
        if (
          getFunctionName(reference as never) === getFunctionName(internal.docSources.upsertPage)
        ) {
          upserts.push(args);
        }
        return undefined;
      },
    } as unknown as ActionCtx;
    return { ctx, queries, upserts };
  }

  const page: DocPage = {
    sourceId: 'source-contract' as Id<'docSources'>,
    ref: 'runbook.md',
    title: 'Runbook',
    markdown: '# Runbook\n\nPress refresh.',
    updatedAt: 1,
  };

  it('keeps a page stored under its hash as stored, with nothing redacted or written', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    const { ctx, upserts } = contextWith({ title: 'Runbook', markdown: '# Runbook\n\nStored.' });
    const result = await persistPageBatch(ctx, source(), [page], [], undefined, []);
    expect(upserts).toEqual([]);
    expect(result).toMatchObject({ refs: ['runbook.md'], pages: 1, redactions: 0, unread: [] });
  });

  it('redacts a page again when its stored text holds a value the owner stored since', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    const known = token(['lin', 'api'], '_', 'known-contract-0123456789abcdef');
    const { ctx, upserts } = contextWith({ title: 'Runbook', markdown: `# Runbook\n\n${known}` });
    const result = await persistPageBatch(
      ctx,
      source(),
      [{ ...page, markdown: `# Runbook\n\n${known}` }],
      [],
      undefined,
      [known],
    );
    expect(result.unread).toEqual([]);
    expect(upserts).toHaveLength(1);
    expect(JSON.stringify(upserts)).not.toContain(known);
    expect(upserts[0].contentHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('redacts a page again when its stored text holds a value stored since in its address form', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    const known = 'p@ss/word-contract-0123456789';
    const stored = `# Runbook\n\npostgres://svc:${encodeURIComponent(known)}@db.example.test/ledger`;
    const { ctx, upserts } = contextWith({ title: 'Runbook', markdown: stored });
    await persistPageBatch(ctx, source(), [{ ...page, markdown: stored }], [], undefined, [known]);
    expect(upserts).toHaveLength(1);
    expect(JSON.stringify(upserts)).not.toContain(encodeURIComponent(known));
  });

  it('takes no hash, and stores every page as before, where the deployment key is not a usable key', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', 'not-a-key');
    const { ctx, queries, upserts } = contextWith(null);
    const result = await persistPageBatch(ctx, source(), [page], [], undefined, []);
    expect(result.unread).toEqual([]);
    expect(queries).not.toContain(getFunctionName(internal.docBlocks.unchangedPage));
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).not.toHaveProperty('contentHash');
  });

  it('takes no hash and asks for no stored page where the deployment has no key', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', '');
    const { ctx, queries, upserts } = contextWith(null);
    await persistPageBatch(ctx, source(), [page], [], undefined, []);
    expect(queries).not.toContain(getFunctionName(internal.docBlocks.unchangedPage));
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).not.toHaveProperty('contentHash');
  });
});

describe('the status a source gives a page, beside its hash (15-A; A-2)', (): void => {
  /** A fixed 32-byte credential key in standard base64. */
  const KEY = Buffer.alloc(32, 7).toString('base64');

  afterEach((): void => {
    vi.unstubAllEnvs();
  });

  /** A fake action context: the stored page the skip reads, and each write the batch asks for. */
  function contextWith(
    stored: {
      title: string;
      markdown: string;
      nativeStatus?: string;
      sourceRevision?: string;
    } | null,
  ): { ctx: ActionCtx; writes: Array<{ name: string; args: Record<string, unknown> }> } {
    const writes: Array<{ name: string; args: Record<string, unknown> }> = [];
    const ctx = {
      runQuery: async (reference: unknown): Promise<unknown> =>
        getFunctionName(reference as never) === getFunctionName(internal.docBlocks.unchangedPage)
          ? stored
          : [],
      runAction: async (): Promise<string> => 'f'.repeat(32),
      runMutation: async (reference: unknown, args: Record<string, unknown>): Promise<unknown> => {
        writes.push({ name: getFunctionName(reference as never), args });
        return undefined;
      },
    } as unknown as ActionCtx;
    return { ctx, writes };
  }

  const page: DocPage = {
    sourceId: 'source-contract' as Id<'docSources'>,
    ref: 'runbook.md',
    title: 'Runbook',
    markdown: '# Runbook\n\nPress refresh.',
    updatedAt: 1,
  };
  const UPSERT = getFunctionName(internal.docSources.upsertPage);
  const RECORD = getFunctionName(internal.docStatus.recordRead);

  it('records that a page kept as stored is now archived at its source, with nothing redacted or upserted', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    const { ctx, writes } = contextWith({ title: 'Runbook', markdown: '# Runbook\n\nStored.' });
    await persistPageBatch(
      ctx,
      source(),
      [{ ...page, nativeStatus: 'archived', sourceRevision: '12' }],
      [],
      undefined,
      [],
    );
    expect(writes).toEqual([
      {
        name: RECORD,
        args: {
          sourceId: 'source-contract',
          syncRunId: 'run-contract',
          ref: 'runbook.md',
          nativeStatus: 'archived',
          sourceRevision: '12',
        },
      },
    ]);
  });

  it('records that a kept page is archived no longer, and writes nothing while its source says what the row holds', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    const archived = contextWith({
      title: 'Runbook',
      markdown: '# Runbook\n\nStored.',
      nativeStatus: 'archived',
      sourceRevision: '12',
    });
    await persistPageBatch(archived.ctx, source(), [page], [], undefined, []);
    expect(archived.writes).toEqual([
      {
        name: RECORD,
        args: { sourceId: 'source-contract', syncRunId: 'run-contract', ref: 'runbook.md' },
      },
    ]);
    const same = contextWith({
      title: 'Runbook',
      markdown: '# Runbook\n\nStored.',
      nativeStatus: 'archived',
      sourceRevision: '12',
    });
    await persistPageBatch(
      same.ctx,
      source(),
      [{ ...page, nativeStatus: 'archived', sourceRevision: '12' }],
      [],
      undefined,
      [],
    );
    expect(same.writes).toEqual([]);
  });

  it('stores a page it reads again without the status in the upsert, then records the status beside it', async (): Promise<void> => {
    vi.stubEnv('DAY0_CREDENTIAL_KEY', KEY);
    const { ctx, writes } = contextWith(null);
    await persistPageBatch(
      ctx,
      source(),
      [{ ...page, nativeStatus: 'draft', sourceRevision: '3' }],
      [],
      undefined,
      [],
    );
    expect(writes.map((write) => write.name)).toEqual([UPSERT, RECORD]);
    expect(writes[0].args).not.toHaveProperty('nativeStatus');
    expect(writes[0].args).not.toHaveProperty('sourceRevision');
    expect(writes[1].args).toEqual({
      sourceId: 'source-contract',
      syncRunId: 'run-contract',
      ref: 'runbook.md',
      nativeStatus: 'draft',
      sourceRevision: '3',
    });
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
    // Re-pinned for 14-I: each stored page also schedules its split into blocks, so the pending
    // jobs are the one continuation and a split per page, every one of them ids only.
    const pending = await scheduled(harness);
    const continuations = pending.filter((job) => job.name === 'docSyncActions:syncBatch');
    expect(continuations).toHaveLength(1);
    expect(continuations[0].args).toEqual([
      { sourceId, runId: expect.any(String), cursor: expect.stringMatching(/^25@[0-9a-z]{7}$/) },
    ]);
    expect(pending.filter((job) => job.name === 'docBlocks:splitStoredPage')).toHaveLength(25);
    expect(pending).toHaveLength(26);
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
    expect(runs[0]).toMatchObject({ state: 'completed', pageCount: 60, pagesListed: 60 });
    expect(runs[0]).not.toHaveProperty('refs');
    const listings = await harness.run(
      async (ctx) => await ctx.db.query('docPageListings').collect(),
    );
    expect(listings).toHaveLength(60);
    expect(listings.every((row) => row.seenBy === runs[0].listing)).toBe(true);
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
    // The continuation among the pending jobs, beside each stored page's split (14-I).
    const stale = (await scheduled(harness)).find((job) => job.name === 'docSyncActions:syncBatch')
      ?.args as Array<{ runId: Id<'docSyncRuns'> }>;
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

  it('neither redacts nor splits again a page whose hash is unchanged, and redoes the one page that changed (P8-10, 14-I)', async (): Promise<void> => {
    const root = temporary('day0-sync-unchanged-');
    await mkdir(join(root, 'few'));
    const value = token(['lin', 'api'], '_', 'unchanged-contract-0123456789abcdef');
    const write = async (name: string, body: string): Promise<void> =>
      await writeFile(join(root, 'few', name), body, 'utf8');
    await write('a.md', '# A\n\nAlpha body.\n');
    await write('b.md', `# B\n\nService token: ${value}\n`);
    await write('c.md', '# C\n\nCharlie body.\n');
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    // Every request the redaction component receives, by its body.
    const redacted: string[] = [];
    const origin = new URL(SPAN_MODEL_TEST_URL).origin;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const address = input instanceof Request ? input.url : String(input);
      if (new URL(address).origin === origin) redacted.push(String(init?.body ?? ''));
      return await redactorFetch(input, init);
    });
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Few',
      kind: 'folder',
      locator: 'few',
    });
    const sync = async (): Promise<void> => {
      redacted.length = 0;
      await harness.action(internal.docSyncActions.syncSource, { sourceId });
      await harness.finishAllScheduledFunctions(drainScheduled);
    };
    const stored = async () =>
      await harness.run(async (ctx) => ({
        pages: await ctx.db.query('docPages').collect(),
        blocks: await ctx.db.query('docBlocks').collect(),
        credentials: await ctx.db.query('credentials').collect(),
        runs: await ctx.db.query('docSyncRuns').collect(),
      }));
    await sync();
    expect(redacted.length).toBeGreaterThan(0);
    const first = await stored();
    expect(first.pages.every((page) => page.contentHash !== undefined)).toBe(true);
    expect(first.blocks.map((block) => block.text).sort()).toEqual([
      'Alpha body.',
      'Charlie body.',
      'Service token: <credential: linear service token, stored>',
    ]);

    await sync();
    expect(redacted).toEqual([]);
    const second = await stored();
    expect(second.pages).toEqual(first.pages);
    expect(second.blocks).toEqual(first.blocks);
    expect(second.credentials).toEqual(first.credentials);
    const runs = second.runs.sort((left, right) => left.createdAt - right.createdAt);
    expect(runs.map((run) => [run.state, run.pageCount, run.redactionCount])).toEqual([
      ['completed', 3, 1],
      ['completed', 3, 1],
    ]);

    await write('a.md', '# A\n\nAlpha body, edited.\n');
    await sync();
    expect(redacted.length).toBeGreaterThan(0);
    expect(redacted.join('\n')).toContain('Alpha body, edited.');
    expect(redacted.join('\n')).not.toContain('Charlie body.');
    expect(redacted.join('\n')).not.toContain('Service token');
    const third = await stored();
    expect(third.blocks.map((block) => block.text).sort()).toEqual([
      'Alpha body, edited.',
      'Charlie body.',
      'Service token: <credential: linear service token, stored>',
    ]);
    const unchangedBlock = (rows: typeof first.blocks) =>
      rows.find((block) => block.pageRef.endsWith('c.md'));
    expect(unchangedBlock(third.blocks)).toEqual(unchangedBlock(first.blocks));
    expect(third.credentials.map((row) => row.status ?? null)).toEqual([null]);
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

  it('reads a source whose every page is unread and none stored as not read, counting no page (W14-R11)', async (): Promise<void> => {
    const root = temporary('day0-sync-none-stored-');
    await mkdir(join(root, 'none'));
    await writeFile(
      join(root, 'none', 'tile.md'),
      `# Tile runbook\n\n${'Step.\n'.repeat(160_000)}`,
      'utf8',
    );
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'None',
      kind: 'folder',
      locator: 'none',
    });
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    const { run, source } = await harness.run(async (ctx) => ({
      run: await ctx.db.query('docSyncRuns').order('desc').first(),
      source: await ctx.db.get(sourceId),
    }));
    expect(run).toMatchObject({ state: 'completed', summary: { pagesKept: 0 } });
    // The chip reads an `error` source as "Could not read" (`app/documentation/source-status.ts`).
    expect(source?.status).toBe('error');
    expect(source?.lastError).toMatch(
      /^1 page could not be read, and nothing from this source is stored yet: tile\.md: The page is \d+ KiB, larger than the 768 KiB Day0 stores\. Day0 reads it again at the next sync; a page it refuses stays unread until the page or its address changes\.$/,
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
    expect(completed).toMatchObject({ state: 'completed', pageCount: 500, pagesListed: 500 });
    // The resumed run carries the failed run's listing, so the pages it read before stay.
    expect(completed.listing).toBe(failed.listing);
    const listings = await harness.run(
      async (ctx) => await ctx.db.query('docPageListings').collect(),
    );
    expect(new Set(listings.map((row) => row.ref)).size).toBe(500);
    expect(listings.every((row) => row.seenBy === completed.listing)).toBe(true);
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
    // The removed page was missed by one complete walk, so it is kept until a second misses it
    // too (14-D's ruling 1 (b)); no page the restart listed was lost.
    expect(state.pages.map((page) => page.ref).sort()).toEqual(
      Array.from({ length: 100 }, (_value, index) => name(index + 1)),
    );
    expect(state.runs[0]).toMatchObject({ state: 'completed', pageCount: 99 });
    expect(state.runs[1]).toMatchObject({ state: 'superseded' });
    expect(state.runs[1].reason).toContain('the listing changed under its cursor');

    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    await harness.finishAllScheduledFunctions(drainScheduled);
    const pruned = await harness.run(
      async (ctx) =>
        await ctx.db
          .query('docPages')
          .withIndex('by_source', (index) => index.eq('sourceId', sourceId))
          .collect(),
    );
    expect(pruned.map((page) => page.ref).sort()).toEqual(
      Array.from({ length: 100 }, (_value, index) => name(index + 1)).filter(
        (ref) => ref !== name(10),
      ),
    );
  });

  it('ends a sync whose listing keeps changing after three restarts, with its reason on the source (M19)', async (): Promise<void> => {
    const root = temporary('day0-sync-changing-');
    await mkdir(join(root, 'changing'));
    for (let index = 1; index <= 30; index += 1) {
      await writeFile(
        join(root, 'changing', `page-${String(index).padStart(2, '0')}.md`),
        `# Page ${index}\n`,
        'utf8',
      );
    }
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Changing',
      kind: 'folder',
      locator: 'changing',
    });
    // An author renames a page between every first batch and the next, as a folder written
    // into all day would change under each sync.
    const read = FolderReader.prototype.listPageBatch;
    let renames = 0;
    vi.spyOn(FolderReader.prototype, 'listPageBatch').mockImplementation(async function (
      this: FolderReader,
      ...args
    ) {
      if (args[2] !== undefined) {
        const from = renames === 0 ? 'page-01.md' : `renamed-${renames}.md`;
        renames += 1;
        await rename(join(root, 'changing', from), join(root, 'changing', `renamed-${renames}.md`));
      }
      return await read.apply(this, args);
    });

    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    await harness.finishAllScheduledFunctions(drainScheduled);

    const state = await harness.run(async (ctx) => ({
      source: await ctx.db.get(sourceId),
      runs: await ctx.db.query('docSyncRuns').order('desc').collect(),
    }));
    expect(state.runs.map((run) => [run.state, run.restarts])).toEqual([
      ['error', 3],
      ['superseded', 2],
      ['superseded', 1],
      ['superseded', undefined],
    ]);
    expect(state.runs[0].reason?.split('\n')[0]).toBe(LISTING_RESTARTS_REASON);
    expect(state.source).toMatchObject({ status: 'error', lastError: LISTING_RESTARTS_REASON });
    expect(state.source?.activeSyncId).toBeUndefined();
    expect(await scheduled(harness)).toEqual([]);
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
      // Re-pinned at 13-K: the run carries the listing every run since 0.6.0 is given when it
      // begins, which the retired lazy listing of a run before 0.6.0 used to make up.
      const runId = await ctx.db.insert('docSyncRuns', {
        sourceId,
        cursor: FINISHING_CURSOR,
        listing: 1,
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
    // The wiki is reached through the reader's own connection (R9); the in-process redactor
    // keeps the global fetch.
    __setPageConnectionForTest({
      resolve: async (): Promise<string[]> => ['93.184.215.14'],
      dial:
        () =>
        async (input: URL, init?: RequestInit): Promise<Response> => {
          seen.push(new Headers(init?.headers).get('authorization'));
          if (input.href.endsWith('/two')) {
            // A failure that echoes the secret across where a 200-character cut once fell.
            throw new Error(`${'refused by the wiki gateway; '.repeat(6)}token ${secret} rejected`);
          }
          return new Response('# One', { headers: { 'content-type': 'text/markdown' } });
        },
      privateHosts: privateHostAllowlist(''),
    });
    try {
      await expect(
        harness.action(internal.docSyncActions.syncSource, { sourceId }),
      ).resolves.toMatchObject({ ok: true, pages: 1, complete: true });
    } finally {
      __setPageConnectionForTest(undefined);
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
