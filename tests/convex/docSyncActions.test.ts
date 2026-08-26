/** @vitest-environment node */

import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
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

/** Build a token-shaped value at runtime so no fixture stores one verbatim. */
function token(parts: string[], separator: string, suffix: string): string {
  return `${parts.join(separator)}${separator}${suffix}`;
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
    expect(categoryForPage({ title: 'Team overview', markdown: '# Team overview' })).toBe(
      'team-doc',
    );
    expect(SYNC_BATCH_SIZE).toBe(25);
  });

  it('redacts explicit and recognisable credential values from errors', (): void => {
    expect(safeSyncError(new Error('failed token-value'), 'token-value')).toBe('failed <redacted>');
    expect(safeSyncError(new Error(`failed xox${'b'}-contract-value`))).toBe('failed <redacted>');
    expect(safeSyncError(new Error(`failed ${token(['secret'], '_', 'contract-value')}`))).toBe(
      'failed <redacted>',
    );
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
    const mutationCalls: unknown[] = [];
    const ctx = {
      runAction: async (_reference: unknown, args: unknown): Promise<Id<'credentials'>> => {
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

    expect(result).toEqual({
      refs: pages.map((page: DocPage): string => page.ref),
      credentialRefs: pages.map((page: DocPage): string => page.ref),
      pages: pages.length,
      redactions: values.length,
    });
    expect(actionCalls).toHaveLength(values.length);
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
    const root = await mkdtemp(join(tmpdir(), 'day0-sync-batch-'));
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
    expect(pending[0].args).toEqual([{ sourceId, runId: expect.any(String), cursor: '25' }]);
    expect(JSON.stringify(pending)).not.toContain(value);
    await expect(
      harness.query(internal.docSources.syncReport, { sourceId }),
    ).resolves.toMatchObject({ status: 'linking', running: true, pageCount: 25 });
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
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
    const pages = await harness.query(internal.docSources.pagesForSourceInternal, { sourceId });
    expect(pages).toHaveLength(60);
    expect(JSON.stringify(pages)).not.toContain(value);
    expect(pages.find((page) => page.ref === 'page-30.md')?.markdown).toContain(
      '<credential: linear service token, stored>',
    );
    const credentials = await harness.run(
      async (ctx) => await ctx.db.query('credentials').collect(),
    );
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ source: { sourceId, ref: 'page-30.md' } });
    await expect(
      harness.action(internal.credentials.decrypt, { credentialId: credentials[0]._id }),
    ).resolves.toBe(value);
  });

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
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
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
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    await expect(
      harness.query(internal.docSources.syncReport, { sourceId }),
    ).resolves.toMatchObject({ status: 'error', running: false, pageCount: 25 });
    const source = await harness.query(internal.docSources.getInternal, { sourceId });
    expect(source?.lastError).toMatch(/ENOENT|no such file/i);
    expect(source).not.toHaveProperty('activeSyncId');
  });
});
