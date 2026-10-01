import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  usePaginatedQuery: () => ({
    results: [],
    status: 'Exhausted',
    isLoading: false,
    loadMore: () => undefined,
  }),
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import { RecordView } from '../../../../../app/agent/[agentId]/record/RecordView';
import { asEmployee } from '../../../../fixtures/dom/employee';

afterEach((): void => {
  backend.queries = {};
});

describe('RecordView', () => {
  it('sets the record with its filters and Export beside what the employee knows, its figures and its files', () => {
    backend.queries = {
      'memoryProjection:forAgent': { text: 'Charter 0.1', cut: false },
      'workspace:read': { 'AGENTS.md': '' },
      'managerTransfers:earlierManagers': [],
    };
    const html = renderToStaticMarkup(asEmployee(<RecordView />));
    expect(html).toContain('>Every event</h2>');
    expect(html).toContain('Refused and withheld');
    expect(html).toContain('>Export</button>');
    expect(html).toContain('>What Mira knows</h2>');
    expect(html).toContain('>So far</h2>');
    expect(html).toContain('>Mira&#x27;s files</h2>');
    expect(html).toContain('Times in UTC, dated');
    // The record, its projection, its figures and its files, in that order.
    const order = ['Every event', 'What Mira knows', 'So far', 'Mira&#x27;s files'].map((title) =>
      html.indexOf(`>${title}</h2>`),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
