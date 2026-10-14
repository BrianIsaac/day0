/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** What the paginated read answers, what it was asked, and the pages it was asked to load. */
const read = vi.hoisted(() => ({
  results: [] as Array<{ agentId: string }>,
  status: 'LoadingFirstPage' as 'LoadingFirstPage' | 'CanLoadMore' | 'LoadingMore' | 'Exhausted',
  asked: [] as Array<{ name: string; args: unknown; options: unknown }>,
  loaded: [] as number[],
}));

vi.mock('convex/react', () => ({
  usePaginatedQuery: (reference: unknown, args: unknown, options: unknown) => {
    read.asked.push({ name: getFunctionName(reference as never), args, options });
    return {
      results: read.results,
      status: read.status,
      isLoading: read.status !== 'Exhausted' && read.status !== 'CanLoadMore',
      loadMore: (count: number): void => {
        read.loaded.push(count);
      },
    };
  },
}));

import { useRoster } from '../../../app/home/use-roster';
import { mount, type Mounted } from '../../fixtures/dom/press';

/** The roster as a page reads it: the employees' ids, or "loading". */
function Probe({ now }: { now: number }) {
  const roster = useRoster(now);
  return <p>{roster === undefined ? 'loading' : roster.map((row) => row.agentId).join(' ')}</p>;
}

const NOW = Date.parse('2026-10-13T15:50:00Z');

/** Draw the probe again at a moment, with the read as it now stands. */
function drawn(view: Mounted, now = NOW): string {
  act((): void => view.root.render(<Probe now={now} />));
  return view.container.textContent ?? '';
}

afterEach((): void => {
  read.results = [];
  read.status = 'LoadingFirstPage';
  read.asked = [];
  read.loaded = [];
});

describe('the home’s roster, read by pages to its end (wave 17, 17-F)', (): void => {
  it('asks for twenty at a time at the quarter hour of the page’s clock', (): void => {
    const view = mount(<Probe now={NOW} />);
    expect(read.asked[0]).toEqual({
      name: 'roster:page',
      args: { at: Date.parse('2026-10-13T15:45:00Z') },
      options: { initialNumItems: 20 },
    });
    view.unmount();
  });

  it('answers nothing until every page is in, asking for the next while there is one', (): void => {
    const view = mount(<Probe now={NOW} />);
    expect(drawn(view)).toBe('loading');

    read.results = [{ agentId: 'e51' }, { agentId: 'e50' }];
    read.status = 'CanLoadMore';
    // A part of the company is not shown as the whole of it.
    expect(drawn(view)).toBe('loading');
    expect(read.loaded).toEqual([20]);

    read.results = [{ agentId: 'e51' }, { agentId: 'e50' }, { agentId: 'e1' }];
    read.status = 'Exhausted';
    expect(drawn(view)).toBe('e51 e50 e1');
    view.unmount();
  });

  it('keeps the rows it had while the read starts again past the quarter hour, then shows the new ones', (): void => {
    read.results = [{ agentId: 'e2' }, { agentId: 'e1' }];
    read.status = 'Exhausted';
    const view = mount(<Probe now={NOW} />);
    expect(drawn(view)).toBe('e2 e1');

    // Midnight in Singapore: the clock's step turns and the paginated read starts from nothing.
    const later = Date.parse('2026-10-13T16:01:00Z');
    read.results = [];
    read.status = 'LoadingFirstPage';
    expect(drawn(view, later)).toBe('e2 e1');
    expect(read.asked.at(-1)?.args).toEqual({ at: Date.parse('2026-10-13T16:00:00Z') });

    read.results = [{ agentId: 'e3' }, { agentId: 'e2' }, { agentId: 'e1' }];
    read.status = 'Exhausted';
    expect(drawn(view, later)).toBe('e3 e2 e1');
    view.unmount();
  });

  it('shows an owner who holds nobody an empty roster, not a loading one', (): void => {
    read.status = 'Exhausted';
    const view = mount(<Probe now={NOW} />);
    expect(drawn(view)).toBe('');
    view.unmount();
  });

  it('asks nothing at a non-finite clock and keeps the rows it had (W17-R28)', (): void => {
    read.results = [{ agentId: 'e2' }, { agentId: 'e1' }];
    read.status = 'Exhausted';
    const view = mount(<Probe now={NOW} />);
    expect(drawn(view)).toBe('e2 e1');

    read.results = [];
    read.status = 'LoadingFirstPage';
    expect(drawn(view, Number.NaN)).toBe('e2 e1');
    expect(read.asked.at(-1)?.args).toBe('skip');
    view.unmount();
  });
});
