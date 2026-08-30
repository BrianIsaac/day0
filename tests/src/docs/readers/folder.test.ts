import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { FolderReader, resolveFolderLocator } from '../../../../src/docs/readers/folder';
import type { DocSourceRecord } from '../../../../src/docs/types';

const temporaryDirectories: string[] = [];

/**
 * Create one isolated documentation tree.
 *
 * Returns:
 *   Absolute temporary root.
 */
async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'day0-folder-reader-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'team', 'runbooks'), { recursive: true });
  await writeFile(join(root, 'team', 'onboarding.md'), '# Onboarding\n\nWelcome.\n');
  await writeFile(join(root, 'team', 'runbooks', 'ticket.md'), 'No heading\n');
  await writeFile(join(root, 'team', 'ignore.txt'), 'not Markdown\n');
  return root;
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory: string): Promise<void> => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('folder documentation reader', (): void => {
  it('returns Markdown pages with stable relative references', async (): Promise<void> => {
    const root = await createFixture();
    const source: DocSourceRecord = {
      _id: 'source-folder' as Id<'docSources'>,
      label: 'Team folder',
      kind: 'folder',
      locator: 'team',
    };
    const pages = await new FolderReader(root).listPages(source);
    expect(pages.map((page) => ({ ref: page.ref, title: page.title }))).toEqual([
      { ref: 'onboarding.md', title: 'Onboarding' },
      { ref: 'runbooks/ticket.md', title: 'ticket' },
    ]);
  });

  it('reads deterministic bounded batches without loading later pages', async (): Promise<void> => {
    const root = await createFixture();
    const source: DocSourceRecord = {
      _id: 'source-folder' as Id<'docSources'>,
      label: 'Team folder',
      kind: 'folder',
      locator: 'team',
    };
    const reader = new FolderReader(root);
    const first = await reader.listPageBatch(source, undefined, undefined, 1);
    const second = await reader.listPageBatch(source, undefined, first.nextCursor, 1);
    expect(first.pages.map((page) => page.ref)).toEqual(['onboarding.md']);
    expect(second.pages.map((page) => page.ref)).toEqual(['runbooks/ticket.md']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('refuses absolute and escaping locators', (): void => {
    expect((): string => resolveFolderLocator('/docs', '/etc')).toThrow('must be relative');
    expect((): string => resolveFolderLocator('/docs', '../private')).toThrow('must stay inside');
  });
});
