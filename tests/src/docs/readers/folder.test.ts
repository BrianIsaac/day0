import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  FolderReader,
  markdownPageTitle,
  resolveFolderLocator,
} from '../../../../src/docs/readers/folder';
import type { DocSourceRecord } from '../../../../src/docs/types';

const temporaryDirectories: string[] = [];

/** Root reads a file whatever its mode, so no file can be made unreadable to it. */
const RUNS_AS_ROOT = process.getuid?.() === 0;

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
    const { pages } = await new FolderReader(root).listPageBatch(source, undefined, undefined, 25);
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

  it.skipIf(RUNS_AS_ROOT)(
    'names a file it cannot read and reads the rest, so one file never fails the source (P5-11)',
    async (): Promise<void> => {
      const root = await mkdtemp(join(tmpdir(), 'day0-folder-unread-'));
      try {
        await writeFile(join(root, 'a.md'), '# A');
        await writeFile(join(root, 'b.md'), '# B');
        await chmod(join(root, 'a.md'), 0o000);
        const batch = await new FolderReader(root).listPageBatch(
          {
            _id: 'source-folder' as Id<'docSources'>,
            label: 'Folder',
            kind: 'folder',
            locator: '.',
          },
          undefined,
          undefined,
          25,
        );
        expect(batch.pages.map((page) => page.ref)).toEqual(['b.md']);
        expect(batch.unread).toEqual([{ ref: 'a.md', reason: expect.stringContaining('EACCES') }]);
        expect(batch.unread[0]?.reason).toContain("'a.md'");
        expect(batch.unread[0]?.reason).not.toContain(root);
        expect(batch.nextCursor).toBeUndefined();
      } finally {
        await chmod(join(root, 'a.md'), 0o600);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('refuses absolute and escaping locators', (): void => {
    expect((): string => resolveFolderLocator('/docs', '/etc')).toThrow('must be relative');
    expect((): string => resolveFolderLocator('/docs', '../private')).toThrow('must stay inside');
  });
});

describe('the title a folder page is given', (): void => {
  it('never takes a heading from inside a fenced code block', (): void => {
    expect(
      markdownPageTitle(
        ['```bash', '# rotate the key first', 'rotate --all', '```', '', '# Key rotation'].join(
          '\n',
        ),
        'fallback.md',
      ),
    ).toBe('Key rotation');
    expect(markdownPageTitle(['~~~', '# Example page', '~~~'].join('\n'), 'fallback.md')).toBe(
      'fallback.md',
    );
  });
});
