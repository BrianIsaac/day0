import { describe, expect, it } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  isProviderFailure,
  readProviderPage,
  splitPageReads,
  unreadReason,
} from '../../../../src/docs/readers/batch';
import type { DocPage } from '../../../../src/docs/types';
import { TransientProviderError } from '../../../../src/lib/transport-error';

const page: DocPage = {
  sourceId: 'source-1' as Id<'docSources'>,
  ref: 'page-1',
  title: 'Page',
  markdown: '# Page',
  updatedAt: 1,
};

describe('one page a reader could not read (P5-11)', (): void => {
  it('records a failure that is the page’s own, and keeps its reason on one bounded line', async (): Promise<void> => {
    await expect(
      readProviderPage('page-2', async (): Promise<DocPage> => {
        throw new Error('Notion page Markdown\nwas truncated.');
      }),
    ).resolves.toEqual({ ref: 'page-2', reason: 'Notion page Markdown was truncated.' });
    expect(unreadReason(new Error('x'.repeat(500)))).toHaveLength(200);
    expect(unreadReason('')).toBe('the page could not be read');
  });

  it('leaves a transient answer or a transport failure to the batch, whose retry is for it', async (): Promise<void> => {
    const limited = new TransientProviderError('The provider was rate limited (HTTP 429).');
    const reset = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
    for (const failure of [limited, reset]) {
      expect(isProviderFailure(failure)).toBe(true);
      await expect(
        readProviderPage('page-2', async (): Promise<DocPage> => {
          throw failure;
        }),
      ).rejects.toBe(failure);
    }
    expect(isProviderFailure(new Error('Notion page Markdown is unavailable.'))).toBe(false);
  });

  it('splits the reads into pages and unread records, in listing order', (): void => {
    expect(
      splitPageReads([page, { ref: 'page-2', reason: 'HTTP 404' }, { ...page, ref: 'page-3' }]),
    ).toEqual({
      pages: [page, { ...page, ref: 'page-3' }],
      unread: [{ ref: 'page-2', reason: 'HTTP 404' }],
    });
  });
});
