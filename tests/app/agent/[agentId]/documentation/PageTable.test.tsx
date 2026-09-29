import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  readState: undefined as unknown,
  pages: [] as unknown[],
}));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown): unknown =>
    getFunctionName(reference as never) === 'docPages:readState' ? backend.readState : undefined,
  usePaginatedQuery: () => ({
    results: backend.pages,
    status: 'Exhausted',
    isLoading: false,
    loadMore: (): void => undefined,
  }),
}));

import {
  PageTable,
  readStateLine,
} from '../../../../../app/agent/[agentId]/documentation/PageTable';
import type { LinkedSource } from '../../../../../app/documentation/SourceTable';

/** A source being read for the first time: two pages stored, no sync finished. */
const SOURCE = {
  _id: 'source-1',
  label: 'RevOps team wiki',
  kind: 'folder',
  locator: '.',
  status: 'linking',
  pageCount: 2,
} as unknown as LinkedSource;

/** The table's chips, in row order. */
function chips(): string[] {
  const html = renderToStaticMarkup(<PageTable source={SOURCE} zone="UTC" />);
  return [...html.matchAll(/<span class="inline-flex h-\[22px\][^>]*>([^<]*)<\/span>/g)].map(
    (match) => match[1] ?? '',
  );
}

describe('readStateLine', (): void => {
  const completedAt = Date.UTC(2026, 8, 29, 14, 5);

  it('says a source has not been read before its first sync finishes', (): void => {
    expect(readStateLine(null, 'UTC')).toBe('No sync of this source has finished yet.');
  });

  it('says when the last sync finished and that it read everything it listed', (): void => {
    expect(readStateLine({ completedAt, unreadCount: 0, unreadNamed: 0 }, 'UTC')).toBe(
      'Last sync finished 29 Sep 2026, 14:05. It read every page it listed.',
    );
  });

  it('says how many pages keep an earlier version, and when only the first are marked', (): void => {
    expect(readStateLine({ completedAt, unreadCount: 2, unreadNamed: 2 }, 'UTC')).toBe(
      'Last sync finished 29 Sep 2026, 14:05. 2 pages it listed could not be read; where an earlier version was stored, it is kept. Each is marked in the table.',
    );
    expect(readStateLine({ completedAt, unreadCount: 14, unreadNamed: 10 }, 'UTC')).toBe(
      'Last sync finished 29 Sep 2026, 14:05. 14 pages it listed could not be read; where an earlier version was stored, it is kept. The first 10 are marked in the table.',
    );
  });
});

describe('PageTable', (): void => {
  const pages = [
    { _id: 'p1', ref: 'a.md', title: 'Team overview', updatedAt: 1 },
    { _id: 'p2', ref: 'b.md', title: 'Escalation paths', updatedAt: 1, unreadReason: 'timed out' },
  ];

  it('calls no page read while the first sync of its source has not finished', (): void => {
    backend.pages = pages;
    backend.readState = null;
    expect(chips()).toEqual(['Earlier version']);
  });

  it('calls a page read once the last sync named every page it could not read', (): void => {
    backend.pages = pages;
    backend.readState = { completedAt: 1, unreadCount: 1, unreadNamed: 1 };
    expect(chips()).toEqual(['Read', 'Earlier version']);
  });

  it('calls no unmarked page read when the sync could not read more pages than it named', (): void => {
    backend.pages = pages;
    backend.readState = { completedAt: 1, unreadCount: 14, unreadNamed: 10 };
    expect(chips()).toEqual(['Earlier version']);
  });
});
