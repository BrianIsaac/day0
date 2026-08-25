/** @vitest-environment node */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../convex/_generated/server';
import type { Doc, Id } from '../../convex/_generated/dataModel';
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
    const values = [
      token(['ntn'], '_', 'contract-value'),
      token(['lin', 'api'], '_', 'contract-value'),
      `xox${'b'}-contract-value`,
      `xox${'p'}-contract-value`,
      `xox${'a'}-contract-value`,
      token(['secret'], '_', 'contract-value'),
      'generic-contract-value',
    ];
    const linearTemplate = readFileSync(
      'docs/submission/notion-pages/linear-automation.md',
      'utf8',
    ).replace('PASTE_LINEAR_API_KEY_HERE', values[1]);
    const bodies = [
      `# Notion\n\nValue: ${values[0]}`,
      linearTemplate,
      `# Slack bot\n\nValue: ${values[2]}`,
      `# Slack user\n\nValue: ${values[3]}`,
      `# Slack app\n\nValue: ${values[4]}`,
      `# Secret\n\nValue: ${values[5]}`,
      `# Billing\n\nAPI key: ${values[6]}`,
    ];
    const pages: DocPage[] = bodies.map(
      (markdown: string, index: number): DocPage => ({
        sourceId: source()._id,
        ref: `page-${index}`,
        title: `Page ${index}`,
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
    expect(persisted).toContain('body');
    expect(persisted).toContain('markdown');
    expect(persisted).not.toContain('events');
  });
});
