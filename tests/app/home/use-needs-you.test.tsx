/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** What each page answers by its cursor, and every set of pages the hook asked for. */
const read = vi.hoisted(() => ({
  pages: new Map<string | null, unknown>(),
  asked: [] as Array<Array<{ name: string; cursor: string | null; numItems: number }>>,
}));

vi.mock('convex/react', () => ({
  useQueries: (
    queries: Record<
      string,
      { query: unknown; args: { paginationOpts: { cursor: string | null; numItems: number } } }
    >,
  ) => {
    read.asked.push(
      Object.values(queries).map(({ query, args }) => ({
        name: getFunctionName(query as never),
        cursor: args.paginationOpts.cursor,
        numItems: args.paginationOpts.numItems,
      })),
    );
    return Object.fromEntries(
      Object.entries(queries).map(([key, { args }]) => [
        key,
        read.pages.get(args.paginationOpts.cursor),
      ]),
    );
  },
}));

import { needsYouCursors, useNeedsYou, type NeedsYouPage } from '../../../app/home/use-needs-you';
import { mount, type Mounted } from '../../fixtures/dom/press';

/** One entry waiting on an employee since a moment. */
const entry = (agentId: string, since: number) => ({
  kind: 'plan',
  key: `plan:${agentId}`,
  agentId,
  employeeName: agentId,
  subject: `Plan of ${agentId}`,
  waitingSince: since,
  waitingAtLeast: false,
  workItemId: `item-${agentId}`,
  questions: 0,
});

/** A page of employees, each with one entry waiting since its number. */
function page(ids: readonly number[], isDone: boolean, continueCursor: string): NeedsYouPage {
  // Ids that name nobody: the stub's employees are strings, not rows.
  return {
    entries: ids.map((id) => entry(`e${id}`, id)),
    total: ids.length,
    waitingByEmployee: ids.map((id) => ({ agentId: `e${id}`, waiting: 1 })),
    isDone,
    continueCursor,
  } as unknown as NeedsYouPage;
}

/** The inbox as a page reads it: its count and its first entries, or "loading", or the error. */
function Probe() {
  const inbox = useNeedsYou();
  return (
    <p>
      {inbox === undefined
        ? 'loading'
        : inbox instanceof Error
          ? `error: ${inbox.message}`
          : `${inbox.total}: ${inbox.entries
              .slice(0, 3)
              .map((one) => one.agentId)
              .join(' ')}`}
    </p>
  );
}

/** Draw the probe again, with the pages as they now stand. */
function drawn(view: Mounted): string {
  act((): void => view.root.render(<Probe />));
  return view.container.textContent ?? '';
}

afterEach((): void => {
  read.pages = new Map();
  read.asked = [];
});

/** The newest twenty, then the five older ones: twenty-five employees, the oldest wait e1's. */
const NEWEST = Array.from({ length: 20 }, (_, index) => 25 - index);
const OLDER = [5, 4, 3, 2, 1];

describe('the home’s inbox, read by pages to its end (wave 18, 18-F)', (): void => {
  it('lists every employee’s entries past twenty, asking twenty at a time from the first page', (): void => {
    const view = mount(<Probe />);
    expect(read.asked[0]).toEqual([{ name: 'work:needsYou', cursor: null, numItems: 20 }]);
    expect(drawn(view)).toBe('loading');

    read.pages.set(null, page(NEWEST, false, 'after-20'));
    // The newest twenty are not shown as the whole of what waits.
    expect(drawn(view)).toBe('loading');
    expect(read.asked.at(-1)?.map((asked) => asked.cursor)).toEqual([null, 'after-20']);

    read.pages.set('after-20', page(OLDER, true, 'end'));
    expect(drawn(view)).toBe('25: e1 e2 e3');
    view.unmount();
  });

  it('answers the error a page was refused with, so the list says it could not be read', (): void => {
    read.pages.set(null, page(NEWEST, false, 'after-20'));
    read.pages.set('after-20', new Error('Server Error: too many documents read'));
    const view = mount(<Probe />);
    expect(drawn(view)).toBe('error: Server Error: too many documents read');
    view.unmount();
  });

  it('keeps the inbox it had while a page whose start moved is read again, then shows the new one', (): void => {
    read.pages.set(null, page(NEWEST, false, 'after-20'));
    read.pages.set('after-20', page(OLDER, true, 'end'));
    const view = mount(<Probe />);
    drawn(view);
    expect(drawn(view)).toBe('25: e1 e2 e3');

    // An employee deployed since: the first page ends one employee earlier.
    read.pages.set(null, page([26, ...NEWEST.slice(0, 19)], false, 'after-19'));
    expect(drawn(view)).toBe('25: e1 e2 e3');
    read.pages.set('after-19', page([6, ...OLDER], true, 'end'));
    drawn(view);
    expect(drawn(view)).toBe('26: e1 e2 e3');
    expect(read.asked.at(-1)?.map((asked) => asked.cursor)).toEqual([null, 'after-19']);
    view.unmount();
  });
});

describe('the walk of the inbox’s pages', (): void => {
  it('ends with an error when a page answers a cursor the walk already read', (): void => {
    const pages = [page([3], false, 'a'), page([2], false, 'a')];
    expect(needsYouCursors([null, 'a'], pages)).toEqual(
      new Error('the inbox answered the same page twice'),
    );
  });

  it('drops the pages after one whose continuation moved, and stops at a page on its way', (): void => {
    expect(
      needsYouCursors([null, 'a', 'b'], [page([3], false, 'a2'), page([2], false, 'b')]),
    ).toEqual([null, 'a2']);
    expect(needsYouCursors([null, 'a'], [page([3], false, 'a'), undefined])).toEqual([null, 'a']);
    expect(needsYouCursors([null, 'a'], [page([3], true, 'end'), page([2], true, 'end')])).toEqual([
      null,
    ]);
  });
});
