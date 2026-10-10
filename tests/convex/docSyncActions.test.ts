/** @vitest-environment node */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { convexTest, type TestConvex } from 'convex-test';
import { afterAll, beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeSpanModelFetch, SPAN_MODEL_TEST_URL } from '../fixtures/redaction-double';
import { api, internal } from '../../convex/_generated/api';
import { MAX_SYNC_BATCHES } from '../../src/docs/listing-bounds';
import type { DocumentationReader } from '../../src/docs/readers/batch';
import { ConfluenceDataCenterReader } from '../../src/docs/readers/confluence-dc';
import { ConfluenceCloudReader } from '../../src/docs/readers/confluence-v2';
import { GoogleDriveReader } from '../../src/docs/readers/drive';
import { FolderReader } from '../../src/docs/readers/folder';
import { SharePointReader } from '../../src/docs/readers/sharepoint';
import { YuqueReader } from '../../src/docs/readers/yuque';
import { sharePointReaderSecret } from '../../src/docs/sharepoint-source';
import { UrlsReader, __setPageConnectionForTest } from '../../src/docs/readers/urls';
import { privateHostAllowlist } from '../../src/lib/private-hosts';
import { RedactorUnavailableError } from '../../src/redaction/client';
import type { ActionCtx } from '../../convex/_generated/server';
import type { Doc, Id } from '../../convex/_generated/dataModel';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import { managerIdentity } from './fakes/manager-identity';
import { LINEAR_TOKEN_PLACEHOLDER, notionPageTemplate } from '../fixtures/notion-pages';
import {
  LISTING_RESTARTS_REASON,
  SYNC_BATCH_SIZE,
  categoryForPage,
  persistPageBatch,
  safeSyncError,
} from '../../convex/docSyncActions';
import type { DocPage, DocSourceRecord } from '../../src/docs/types';
import { MARKER_JUDGEMENTS_PER_SYNC, MARKER_JUDGING_BUDGET_MS } from '../../src/docs/status';
import { FINISHING_CURSOR } from '../../convex/docSources';
import {
  credentialValueFingerprint,
  encrypt,
  openOwnedCredential as openSpy,
} from '../../src/lib/credential-crypto';
import { credentialSourceRef } from '../../src/docs/credential-ref';
import { ownerValuesRef } from '../../src/redaction/known-values';
import { providerFake } from '../fixtures/readers/fake';
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

/**
 * The marker judgement's scripted model (15-A): each call's prompt, and the reply a test gives
 * for it. With no script the judgement fails, as a model that cannot be reached does.
 */
const markerModel = vi.hoisted(() => ({
  prompts: [] as string[],
  reply: undefined as ((prompt: string) => unknown) | undefined,
}));

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: schemaChecked((call) => {
    if (call.agent.name !== 'day0-doc-marker') return { systems: [] };
    markerModel.prompts.push(call.user);
    if (markerModel.reply === undefined) throw new Error('the marker model is not scripted');
    return markerModel.reply(call.user);
  }),
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

describe('the status phase of a finishing sync (15-A; N20)', (): void => {
  const CLOSE = '# 月结流程\n\n本文件已废止,请参阅《月结流程(2026版)》。\n\n## 步骤\n\n关账。\n';
  const ARCHIVING = '# How to archive a ticket\n\nAn archived ticket leaves the board.\n';

  beforeEach((): void => {
    vi.useFakeTimers();
    vi.stubEnv('DAY0_CREDENTIAL_KEY', Buffer.alloc(32, 9).toString('base64'));
    markerModel.prompts.length = 0;
    // The model as a careful reader: only a page that says of itself that it is void is superseded.
    markerModel.reply = (prompt: string): unknown =>
      prompt.includes('本文件已废止')
        ? { status: 'superseded', quote: '本文件已废止' }
        : prompt.includes('DRAFT')
          ? { status: 'draft', quote: 'DRAFT' }
          : { status: 'active', quote: '' };
  });

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    markerModel.reply = undefined;
  });

  /** A folder source over `files`, linked for the owner. */
  async function folderOf(
    files: Readonly<Record<string, string>>,
  ): Promise<{ harness: TestConvex<typeof schema>; sourceId: Id<'docSources'>; root: string }> {
    const root = temporary('day0-sync-status-');
    for (const [name, body] of Object.entries(files)) {
      await mkdir(join(root, 'docs', name, '..'), { recursive: true });
      await writeFile(join(root, 'docs', name), body, 'utf8');
    }
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Handbook',
      kind: 'folder',
      locator: 'docs',
    });
    return { harness, sourceId, root };
  }

  /** Run one whole sync of the source. */
  async function sync(harness: TestConvex<typeof schema>, sourceId: Id<'docSources'>) {
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    await harness.finishAllScheduledFunctions(drainScheduled);
    return await harness.query(internal.docSources.syncReport, { sourceId });
  }

  /** Each stored page's status, what decided it and its marker's status (null: none), by ref. */
  async function statuses(harness: TestConvex<typeof schema>) {
    return await harness.run(async (ctx) =>
      Object.fromEntries(
        (await ctx.db.query('docPages').collect()).map((page) => [
          page.ref,
          [page.status ?? null, page.statusSource ?? null, page.marker?.status ?? null],
        ]),
      ),
    );
  }

  it('judges a Chinese marker and supersedes its page with its blocks, and decides nothing on a hit the model reads as the page’s subject', async (): Promise<void> => {
    const { harness, sourceId } = await folderOf({
      'finance/close.md': CLOSE,
      'howto/archive-a-ticket.md': ARCHIVING,
      'plain.md': '# Holidays\n\nThe office closes in August.\n',
    });
    expect(await sync(harness, sourceId)).toMatchObject({ status: 'synced', pageCount: 3 });
    expect(await statuses(harness)).toEqual({
      'finance/close.md': ['superseded', 'marker', 'superseded'],
      // The pre-filter hit on "archived"; the judgement said the page is about archiving.
      'howto/archive-a-ticket.md': [null, null, 'active'],
      'plain.md': [null, null, null],
    });
    expect(markerModel.prompts).toHaveLength(2);
    const blocks = await harness.run(async (ctx) => await ctx.db.query('docBlocks').collect());
    expect(
      blocks.filter((block) => block.pageRef === 'finance/close.md').map((block) => block.status),
    ).toEqual(['superseded', 'superseded']);
    expect(
      blocks.filter((block) => block.pageRef !== 'finance/close.md').map((block) => block.status),
    ).toEqual(['active', 'active']);
  }, 30_000);

  it('asks the model once a page and text: a second sync asks nothing, and a page whose top changed is asked again', async (): Promise<void> => {
    const { harness, sourceId, root } = await folderOf({
      'finance/close.md': CLOSE,
      'howto/archive-a-ticket.md': ARCHIVING,
    });
    await sync(harness, sourceId);
    expect(markerModel.prompts).toHaveLength(2);
    await sync(harness, sourceId);
    expect(markerModel.prompts).toHaveLength(2);
    // The page is reinstated at its source: its top no longer says it is void.
    await writeFile(
      join(root, 'docs', 'finance/close.md'),
      CLOSE.replace('本文件已废止,请参阅《月结流程(2026版)》。', '本文件替代已废止的旧版。'),
      'utf8',
    );
    markerModel.reply = (): unknown => ({ status: 'active', quote: '' });
    await sync(harness, sourceId);
    expect(markerModel.prompts).toHaveLength(3);
    expect((await statuses(harness))['finance/close.md']).toEqual(['active', 'default', 'active']);
  }, 30_000);

  it('leaves a page as it was when the model cannot answer, and the sync still completes: a hit alone decides nothing', async (): Promise<void> => {
    const { harness, sourceId } = await folderOf({ 'finance/close.md': CLOSE });
    markerModel.reply = undefined;
    expect(await sync(harness, sourceId)).toMatchObject({ status: 'synced', pageCount: 1 });
    expect(markerModel.prompts).toHaveLength(1);
    expect(await statuses(harness)).toEqual({
      'finance/close.md': [null, null, null],
    });
  }, 30_000);

  it('keeps a page as last judged when its marker line is edited and the model cannot answer', async (): Promise<void> => {
    // The second pass's minor 10: the edit dropped the judgement, so with the model down the
    // deprecated page was current, and citable, until a later sync could ask.
    const { harness, sourceId, root } = await folderOf({ 'finance/close.md': CLOSE });
    await sync(harness, sourceId);
    expect((await statuses(harness))['finance/close.md']).toEqual([
      'superseded',
      'marker',
      'superseded',
    ]);
    await writeFile(
      join(root, 'docs', 'finance/close.md'),
      CLOSE.replace('2026版', '2027版'),
      'utf8',
    );
    markerModel.reply = undefined;
    expect(await sync(harness, sourceId)).toMatchObject({ status: 'synced', pageCount: 1 });
    expect(markerModel.prompts).toHaveLength(2);
    expect((await statuses(harness))['finance/close.md']).toEqual([
      'superseded',
      'marker',
      'superseded',
    ]);
  }, 30_000);

  it('keeps a deprecated page out when its notice is reworded with no vocabulary word, asks the model of its top, and lets it back only on the answer (D-1 (c); W15-R27)', async (): Promise<void> => {
    const DEPRECATED =
      '# Pipeline runbook\n\nDEPRECATED: use the v2 runbook instead.\n\n## Steps\n\nRefresh.\n';
    const { harness, sourceId, root } = await folderOf({ 'pipeline.md': DEPRECATED });
    markerModel.reply = (prompt: string): unknown =>
      prompt.includes('DEPRECATED')
        ? { status: 'superseded', quote: 'DEPRECATED: use the v2 runbook instead.' }
        : prompt.includes('replaced with the v2 runbook')
          ? { status: 'superseded', quote: 'replaced with the v2 runbook' }
          : { status: 'active', quote: '' };
    await sync(harness, sourceId);
    expect((await statuses(harness))['pipeline.md']).toEqual([
      'superseded',
      'marker',
      'superseded',
    ]);
    // The notice is reworded: no line of the top holds a vocabulary word any more.
    const reworded = DEPRECATED.replace(
      'DEPRECATED: use the v2 runbook instead.',
      'This runbook has been replaced with the v2 runbook.',
    );
    await writeFile(join(root, 'docs', 'pipeline.md'), reworded, 'utf8');
    const asked = markerModel.prompts.length;
    await sync(harness, sourceId);
    // On the base the page was current here and the model was never asked.
    expect(markerModel.prompts).toHaveLength(asked + 1);
    expect(markerModel.prompts.at(-1)).toContain(
      'This runbook has been replaced with the v2 runbook.',
    );
    expect((await statuses(harness))['pipeline.md']).toEqual([
      'superseded',
      'marker',
      'superseded',
    ]);
    // Judged of that top, it is asked nothing more while the top stands.
    await sync(harness, sourceId);
    expect(markerModel.prompts).toHaveLength(asked + 1);
    // The notice is lifted in earnest, with the model down: the page stays out until it answers.
    await writeFile(
      join(root, 'docs', 'pipeline.md'),
      reworded.replace(
        'This runbook has been replaced with the v2 runbook.',
        'How the tile is refreshed.',
      ),
      'utf8',
    );
    markerModel.reply = undefined;
    await sync(harness, sourceId);
    expect((await statuses(harness))['pipeline.md']).toEqual([
      'superseded',
      'marker',
      'superseded',
    ]);
    markerModel.reply = (): unknown => ({ status: 'active', quote: '' });
    await sync(harness, sourceId);
    expect((await statuses(harness))['pipeline.md']).toEqual(['active', 'default', null]);
  }, 60_000);

  it('holds a page judged current out once its top gains a marker line, until the model answers, and "This is current" overrules at once (D-1 (c); W15-R27)', async (): Promise<void> => {
    const { harness, sourceId, root } = await folderOf({ 'howto/archive-a-ticket.md': ARCHIVING });
    await sync(harness, sourceId);
    expect((await statuses(harness))['howto/archive-a-ticket.md']).toEqual([null, null, 'active']);
    // The page itself is archived at its source, by a line at its top; the model cannot be asked.
    await writeFile(
      join(root, 'docs', 'howto/archive-a-ticket.md'),
      ARCHIVING.replace('\n\n', '\n\nARCHIVED: kept for the record only.\n\n'),
      'utf8',
    );
    markerModel.reply = undefined;
    await sync(harness, sourceId);
    // On the base the stale judgement kept the page current until a later sync could ask.
    expect((await statuses(harness))['howto/archive-a-ticket.md']).toEqual([
      'archived',
      'marker',
      'active',
    ]);
    const blocks = await harness.run(async (ctx) => await ctx.db.query('docBlocks').collect());
    expect(new Set(blocks.map((block) => block.status))).toEqual(new Set(['archived']));
    const [page] = await harness.run(async (ctx) => await ctx.db.query('docPages').collect());
    await harness
      .withIdentity(managerIdentity())
      .mutation(api.docStatus.setPageStatus, { pageId: page._id, status: 'active' });
    expect((await statuses(harness))['howto/archive-a-ticket.md']?.slice(0, 2)).toEqual([
      'active',
      'manager',
    ]);
    // Cleared, it falls back to being held out; the model's answer then decides.
    await harness
      .withIdentity(managerIdentity())
      .mutation(api.docStatus.clearPageStatus, { pageId: page._id });
    markerModel.reply = (): unknown => ({
      status: 'archived',
      quote: 'ARCHIVED: kept for the record only.',
    });
    await sync(harness, sourceId);
    expect((await statuses(harness))['howto/archive-a-ticket.md']).toEqual([
      'archived',
      'marker',
      'archived',
    ]);
  }, 60_000);

  it('stops asking once a finish has spent its time on judgements, and asks the rest at the next sync', async (): Promise<void> => {
    // The second pass's minor 10: twenty judgements at thirty seconds each, one after another,
    // is the whole of an action's ten minutes, and nothing stopped the asking.
    expect(MARKER_JUDGING_BUDGET_MS).toBe(180_000);
    const { harness, sourceId } = await folderOf(
      Object.fromEntries(
        Array.from({ length: 6 }, (_unused, index) => [
          `notes/idea-${index}.md`,
          `# Idea ${index}\n\nDRAFT\n\nBody ${index}.\n`,
        ]),
      ),
    );
    // A slow model: each answer takes a minute.
    markerModel.reply = (): unknown => {
      vi.setSystemTime(Date.now() + 60_000);
      return { status: 'draft', quote: 'DRAFT' };
    };
    expect(await sync(harness, sourceId)).toMatchObject({ status: 'synced', pageCount: 6 });
    expect(markerModel.prompts).toHaveLength(3);
    await sync(harness, sourceId);
    expect(markerModel.prompts).toHaveLength(6);
  }, 60_000);

  it('asks about at most twenty pages a sync, and the rest at the next', async (): Promise<void> => {
    expect(MARKER_JUDGEMENTS_PER_SYNC).toBe(20);
    const { harness, sourceId } = await folderOf(
      Object.fromEntries(
        Array.from({ length: 23 }, (_unused, index) => [
          `notes/idea-${String(index).padStart(2, '0')}.md`,
          `# Idea ${index}\n\nDRAFT\n\nBody ${index}.\n`,
        ]),
      ),
    );
    await sync(harness, sourceId);
    expect(markerModel.prompts).toHaveLength(20);
    const drafts = async (): Promise<number> =>
      Object.values(await statuses(harness)).filter(([status]) => status === 'draft').length;
    expect(await drafts()).toBe(20);
    await sync(harness, sourceId);
    expect(markerModel.prompts).toHaveLength(23);
    expect(await drafts()).toBe(23);
  }, 60_000);
});

describe('the relations a finishing sync proposes (15-A)', (): void => {
  beforeEach((): void => {
    vi.useFakeTimers();
    vi.stubEnv('DAY0_CREDENTIAL_KEY', Buffer.alloc(32, 9).toString('base64'));
  });

  afterEach((): void => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  /** Run one whole sync of a source. */
  async function sync(harness: TestConvex<typeof schema>, sourceId: Id<'docSources'>) {
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    await harness.finishAllScheduledFunctions(drainScheduled);
    return await harness.query(internal.docSources.syncReport, { sourceId });
  }

  it('proposes a later version stored by this sync as the successor of the page it names, once, and supersedes nothing by itself', async (): Promise<void> => {
    const root = temporary('day0-sync-relations-');
    await mkdir(join(root, 'wiki', 'runbooks'), { recursive: true });
    await mkdir(join(root, 'official'));
    await writeFile(
      join(root, 'wiki', 'runbooks', 'pipeline-runbook.md'),
      '# Pipeline runbook\n\n## Refresh\n\nPress Refresh once.\n',
      'utf8',
    );
    await writeFile(
      join(root, 'official', 'pipeline-runbook-v2.md'),
      '---\nsupersedes: pipeline-runbook\n---\n# Pipeline runbook\n\n## Refresh\n\nPress Refresh twice.\n',
      'utf8',
    );
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const harness = convexTest(schema, allConvexModules());
    const link = async (label: string, locator: string) =>
      await harness.mutation(internal.docSources.createSource, {
        userId: 'owner',
        label,
        kind: 'folder',
        locator,
      });
    const wiki = await link('Team wiki', 'wiki');
    const official = await link('Official runbooks', 'official');
    expect(await sync(harness, wiki)).toMatchObject({ status: 'synced', pageCount: 1 });
    const relations = async () =>
      await harness.run(async (ctx) => await ctx.db.query('docRelations').collect());
    // The wiki's own page relates to nothing yet.
    expect(await relations()).toEqual([]);
    expect(await sync(harness, official)).toMatchObject({ status: 'synced', pageCount: 1 });
    expect(await relations()).toMatchObject([
      {
        kind: 'possible_successor',
        status: 'proposed',
        from: { sourceId: official, ref: 'pipeline-runbook-v2.md' },
        to: { sourceId: wiki, ref: 'runbooks/pipeline-runbook.md' },
      },
    ]);
    const pages = await harness.run(async (ctx) => await ctx.db.query('docPages').collect());
    expect(pages.map((page) => page.status ?? 'none')).toEqual(['none', 'none']);
    // Neither source changed: the next syncs measure the same pages and propose nothing more.
    await sync(harness, official);
    await sync(harness, wiki);
    expect(await relations()).toHaveLength(1);
  }, 30_000);
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

  it('gives each scheduled sync after the cap one fresh start of its own, not three more, until a walk completes (W14-R33)', async (): Promise<void> => {
    const root = temporary('day0-sync-changing-again-');
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
    // The review's input: a listing that changes inside every walk, sync after sync.
    const read = FolderReader.prototype.listPageBatch;
    let renames = 0;
    let changing = true;
    vi.spyOn(FolderReader.prototype, 'listPageBatch').mockImplementation(async function (
      this: FolderReader,
      ...args
    ) {
      if (changing && args[2] !== undefined) {
        const from = renames === 0 ? 'page-01.md' : `renamed-${renames}.md`;
        renames += 1;
        await rename(join(root, 'changing', from), join(root, 'changing', `renamed-${renames}.md`));
      }
      return await read.apply(this, args);
    });
    const sync = async (fresh?: true): Promise<Array<[string, number | undefined]>> => {
      const before = await harness.run(
        async (ctx) => (await ctx.db.query('docSyncRuns').collect()).length,
      );
      await harness.action(internal.docSyncActions.syncSource, {
        sourceId,
        ...(fresh ? { fresh } : {}),
      });
      await harness.finishAllScheduledFunctions(drainScheduled);
      const runs = await harness.run(async (ctx) => await ctx.db.query('docSyncRuns').collect());
      return runs.slice(before).map((run) => [run.state, run.restarts]);
    };
    expect(await sync()).toEqual([
      ['superseded', undefined],
      ['superseded', 1],
      ['superseded', 2],
      ['error', 3],
    ]);
    // The next scheduled syncs carry the count, less one: two runs each, where there were four.
    expect(await sync()).toEqual([
      ['superseded', 2],
      ['error', 3],
    ]);
    expect(await sync()).toEqual([
      ['superseded', 2],
      ['error', 3],
    ]);
    // A re-read by hand starts over, as a person asked for it.
    expect((await sync(true)).map(([, restarts]) => restarts)).toEqual([undefined, 1, 2, 3]);
    // The source goes quiet: the walk completes, and the sync after it owes nothing.
    changing = false;
    const quiet = await sync();
    expect(quiet.at(-1)?.[0]).toBe('completed');
    expect(await sync()).toEqual([['completed', undefined]]);
  }, 30_000);

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

  it('stores the pages of a Confluence Cloud space, each read with its revision and its own status (15-X)', async (): Promise<void> => {
    const token = 'fixture-confluence-token';
    const key = process.env.DAY0_CREDENTIAL_KEY ?? '';
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await harness.run(async (ctx) => {
      const credentialId = await ctx.db.insert('credentials', {
        userId: 'owner',
        kind: 'value',
        label: 'Ops wiki API token',
        source: 'entered',
        createdAt: 1,
        ...encrypt(token, key),
      });
      return await ctx.db.insert('docSources', {
        userId: 'owner',
        label: 'Ops wiki',
        kind: 'confluence-v2',
        locator:
          'https://api.atlassian.com/ex/confluence/1a11d016-8984-4c3e-b9ab-142dd06acb1b/wiki/spaces/OPS',
        credentialId,
        status: 'linking',
        createdAt: 1,
        updatedAt: 1,
      });
    });
    // Atlassian's gateway is answered from the fixtures; the in-process redactor keeps the rest.
    const site = providerFake('confluence-v2');
    vi.stubGlobal('fetch', async (input: URL | string | Request, init?: RequestInit) =>
      new URL(input instanceof Request ? input.url : input).host === 'api.atlassian.com'
        ? await site.fetch(input, init)
        : await redactorFetch(input, init),
    );
    await expect(
      harness.action(internal.docSyncActions.syncSource, { sourceId }),
    ).resolves.toMatchObject({ ok: true, pages: 3, complete: false });
    await harness.finishAllScheduledFunctions(drainScheduled);
    const stored = await harness.run(async (ctx) => ({
      source: await ctx.db.get(sourceId),
      pages: await ctx.db.query('docPages').collect(),
      runs: await ctx.db.query('docSyncRuns').collect(),
    }));
    // A reader's revision and status ride beside the page's hash, never through the page store,
    // whose validator takes neither: before 15-X's line every page here was refused by it.
    expect(stored.runs[0].unread?.pages.map((page) => page.ref)).toEqual(['98315']);
    expect(stored.pages.map((page) => [page.ref, page.title])).toEqual([
      ['98311', 'Close the quarter'],
      ['98312', 'Escalation paths (2024)'],
      ['98313', '运维手册'],
      ['98314', '刷新看板'],
      ['98316', 'Runbook index'],
    ]);
    // The join with 15-A, which 15-X's handover asked for: what each page's source says of it
    // is on its row beside the hash (`docStatus.recordRead`). Every page carries the revision
    // Confluence numbers it by, and the one archived there is archived by its source's own word;
    // an ordinary page carries no status, so the later rules still reach it.
    expect(
      stored.pages.map((page) => [
        page.ref,
        page.sourceRevision,
        page.nativeStatus,
        page.status,
        page.statusSource,
      ]),
    ).toEqual([
      ['98311', '7', undefined, undefined, undefined],
      ['98312', '3', 'archived', 'archived', 'source-native'],
      ['98313', '2', undefined, undefined, undefined],
      ['98314', '1', undefined, undefined, undefined],
      ['98316', '12', undefined, undefined, undefined],
    ]);
    expect(stored.source).toMatchObject({ status: 'synced' });
    expect(JSON.stringify(stored)).not.toContain(token);
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

  /** A provider answer of reader 3's loops.mts. */
  function loopAnswer(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }

  /** A Confluence page as the probe listed it. */
  function loopPage(id: string): unknown {
    return {
      id,
      title: `T${id}`,
      status: 'current',
      body: { storage: { value: '<p>x</p>' } },
      version: { number: 1 },
    };
  }

  /** What each probe reader waits and reads the clock with: nothing waits. */
  const loopClock = { sleep: async (): Promise<void> => undefined, now: (): number => 1_000_000 };

  /** One provider whose listing never ends: its real reader over the probe's answers. */
  interface EndlessProvider {
    readonly reader: DocumentationReader;
    readonly record: Pick<DocSourceRecord, 'kind' | 'locator' | 'label'>;
    readonly secret: string;
  }

  /**
   * Reader 3's loops.mts (W15-R8), shape for shape: five providers that say more of a listing
   * follows for ever, each answered as the probe answered it and read by its own reader.
   */
  const ENDLESS_WITH_PAGES: Readonly<Record<string, () => EndlessProvider>> = {
    'a Confluence Cloud cursor that alternates A, B, A': () => {
      let call = 0;
      return {
        reader: new ConfluenceCloudReader({
          ...loopClock,
          fetch: async (url: URL): Promise<Response> => {
            if (url.pathname.endsWith('/spaces'))
              return loopAnswer(200, { results: [{ id: '10' }] });
            call += 1;
            return loopAnswer(
              200,
              { results: [loopPage(String(call % 2))] },
              {
                link: `<https://api.atlassian.com/ex/confluence/x/wiki/api/v2/spaces/10/pages?cursor=${call % 2 === 1 ? 'B' : 'A'}>; rel="next"`,
              },
            );
          },
        }),
        record: {
          kind: 'confluence-v2',
          label: 'Ops wiki',
          locator:
            'https://api.atlassian.com/ex/confluence/1a11d016-8984-4c3e-b9ab-142dd06acb1b/wiki/spaces/OPS',
        },
        secret: 'fixture-confluence-token',
      };
    },
    'a Confluence Data Center that ignores start and always names a next page': () => ({
      reader: new ConfluenceDataCenterReader({
        ...loopClock,
        fetch: async (url: URL): Promise<Response> =>
          url.pathname.includes('/rest/api/space/')
            ? loopAnswer(200, { key: 'OPS' })
            : loopAnswer(200, {
                results: [loopPage('1'), loopPage('2')],
                _links: { next: '/rest/api/content?start=2', base: 'https://wiki.acme.corp' },
              }),
      }),
      record: {
        kind: 'confluence-dc',
        label: 'Ops wiki',
        locator: 'https://wiki.acme.corp/display/OPS',
      },
      secret: 'fixture-confluence-pat',
    }),
    'a Yuque total of a million over one repeating page': () => ({
      reader: new YuqueReader({
        ...loopClock,
        fetch: async (url: URL): Promise<Response> =>
          /docs\/\d+$/.test(url.pathname)
            ? loopAnswer(200, {
                data: {
                  format: 'markdown',
                  body: 'x',
                  slug: 's',
                  status: 1,
                  content_updated_at: '2026-01-01T00:00:00Z',
                },
              })
            : loopAnswer(200, {
                data: [{ id: 1, title: 'a', type: 'Doc' }],
                meta: { total: 1_000_000 },
              }),
      }),
      record: { kind: 'yuque', label: 'Ops', locator: 'https://www.yuque.com/acme/ops' },
      secret: 'fixture-yuque-token',
    }),
    'a SharePoint next link that alternates A, B, A': () => {
      let call = 0;
      const graph = async (url: URL): Promise<Response> => {
        if (url.host === 'login.microsoftonline.com')
          return loopAnswer(200, { access_token: 'at' });
        if (url.pathname.endsWith('/content')) {
          return new Response(null, {
            status: 302,
            headers: { location: 'https://acme.sharepoint.com/dl' },
          });
        }
        if (url.pathname.startsWith('/v1.0/sites/acme.sharepoint.com')) {
          return loopAnswer(200, { id: 'site1' });
        }
        call += 1;
        return loopAnswer(200, {
          value: [{ id: `i${call % 2}`, name: 'a.md', size: 1, parentReference: { driveId: 'd' } }],
          '@odata.nextLink': `https://graph.microsoft.com/v1.0/sites/site1/drive/root/delta?token=${call % 2 === 1 ? 'B' : 'A'}`,
        });
      };
      return {
        reader: new SharePointReader({
          ...loopClock,
          fetch: graph,
          download: async (): Promise<Response> => new Response('# Hi', { status: 200 }),
        }),
        record: { kind: 'sharepoint', label: 'Site', locator: 'https://acme.sharepoint.com' },
        secret: sharePointReaderSecret({
          tenantId: '9188040d-6c67-4c5b-b112-36a304b66dad',
          clientId: '6731de76-14a6-49ae-97bc-6eba6914391e',
          clientSecret: 'fixture-client-secret',
        }),
      };
    },
  };

  /** A folder source whose reads are answered by an endless provider's own reader. */
  async function sourceOn(
    harness: TestConvex<typeof schema>,
    provider: EndlessProvider,
  ): Promise<Id<'docSources'>> {
    const root = temporary('day0-sync-endless-');
    await mkdir(join(root, 'endless'));
    vi.stubEnv('DAY0_DOCS_ROOT', root);
    const sourceId = await harness.mutation(internal.docSources.createSource, {
      userId: 'owner',
      label: 'Endless',
      kind: 'folder',
      locator: 'endless',
    });
    vi.spyOn(FolderReader.prototype, 'listPageBatch').mockImplementation(
      async (source, _secret, cursor, limit) =>
        await provider.reader.listPageBatch(
          { ...provider.record, _id: source._id },
          provider.secret,
          cursor,
          limit,
        ),
    );
    return sourceId;
  }

  /** Run the sync's scheduled batches, at most this many, and say how many are still waiting. */
  async function drainAtMost(harness: TestConvex<typeof schema>, rounds: number): Promise<number> {
    for (let round = 0; round < rounds && (await scheduled(harness)).length > 0; round += 1) {
      drainScheduled();
      await harness.finishInProgressScheduledFunctions();
    }
    return (await scheduled(harness)).length;
  }

  it.each(Object.keys(ENDLESS_WITH_PAGES))(
    'ends a sync whose listing never ends, with its reason on the source and its pages kept: %s (W15-R8)',
    async (shape: string): Promise<void> => {
      const harness = convexTest(schema, allConvexModules());
      const sourceId = await sourceOn(harness, ENDLESS_WITH_PAGES[shape]());
      await harness.action(internal.docSyncActions.syncSource, { sourceId });
      // On the base every one of these was still asking for its next batch after 300.
      expect(await drainAtMost(harness, 300)).toBe(0);
      const state = await harness.run(async (ctx) => ({
        source: await ctx.db.get(sourceId),
        runs: await ctx.db.query('docSyncRuns').order('desc').collect(),
        pages: await ctx.db.query('docPages').collect(),
      }));
      expect(state.source?.status).toBe('error');
      expect(state.source?.activeSyncId).toBeUndefined();
      expect(state.source?.lastError).toMatch(
        /^The source's listing did not end: it named 2\d\d pages this sync had already read, /,
      );
      expect(state.runs).toHaveLength(1);
      expect(state.runs[0].state).toBe('error');
      // What the listing did name stays stored.
      expect(state.pages.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it('ends a sync whose listing names no page and never ends, once it has asked as often as one sync may (W15-R8)', async (): Promise<void> => {
    // The probe's fifth shape: Google Drive's page token alternating P1, P2 over empty pages.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let call = 0;
    const harness = convexTest(schema, allConvexModules());
    const sourceId = await sourceOn(harness, {
      reader: new GoogleDriveReader({
        ...loopClock,
        fetch: async (url: URL): Promise<Response> => {
          if (url.host === 'oauth2.googleapis.com') return loopAnswer(200, { access_token: 'at' });
          if (/\/files\/[^/]+$/.test(url.pathname) && !url.searchParams.has('q')) {
            return loopAnswer(200, { id: 'F', mimeType: 'application/vnd.google-apps.folder' });
          }
          call += 1;
          return loopAnswer(200, { files: [], nextPageToken: call % 2 === 1 ? 'P1' : 'P2' });
        },
      }),
      record: {
        kind: 'drive',
        label: 'Drive',
        locator: `https://drive.google.com/drive/folders/${'a'.repeat(20)}`,
      },
      secret: JSON.stringify({
        client_email: 'reader@fixture.iam.gserviceaccount.com',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      }),
    });
    await harness.action(internal.docSyncActions.syncSource, { sourceId });
    expect(await drainAtMost(harness, 20)).toBe(1);
    const runId = await harness.run(async (ctx) => {
      const [run] = await ctx.db.query('docSyncRuns').collect();
      // The run counts what it has asked for: the first batch and twenty more.
      expect(run.batches).toBe(21);
      // As a run that has been asking all along stands just before its last allowed batch.
      await ctx.db.patch(run._id, { batches: MAX_SYNC_BATCHES - 2 });
      return run._id;
    });
    expect(await drainAtMost(harness, 20)).toBe(0);
    const state = await harness.run(async (ctx) => ({
      source: await ctx.db.get(sourceId),
      run: await ctx.db.get(runId),
    }));
    expect(state.run).toMatchObject({ state: 'error', batches: MAX_SYNC_BATCHES });
    expect(state.source?.status).toBe('error');
    expect(state.source?.lastError).toMatch(
      /^The source's listing did not end within the 4,000 parts Day0 reads of one listing in a sync, /,
    );
  }, 120_000);
});
