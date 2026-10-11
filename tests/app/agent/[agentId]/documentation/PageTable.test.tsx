/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  readState: undefined as unknown,
  pages: [] as unknown[],
  calls: [] as Array<{ name: string; args: unknown }>,
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
  // The page's own controls (15-A).
  useMutation:
    (reference: unknown) =>
    async (args: unknown): Promise<null> => {
      backend.calls.push({ name: getFunctionName(reference as never), args });
      return null;
    },
}));

import {
  PageTable,
  decidedByWords,
  readStateLine,
  statusChip,
} from '../../../../../app/agent/[agentId]/documentation/PageTable';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { mount, press, settle } from '../../../../fixtures/dom/press';
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

afterEach((): void => {
  backend.calls = [];
  document.body.replaceChildren();
});

describe('PageTable', (): void => {
  // Re-pinned by 15-A: every row carries its status and what decided it (A5), so each row's
  // chips now open with its status chip, before the chip that says whether the sync read it.
  const undecided = { status: 'active', statusSource: 'default' };
  const pages = [
    { _id: 'p1', ref: 'a.md', title: 'Team overview', updatedAt: 1, ...undecided },
    {
      _id: 'p2',
      ref: 'b.md',
      title: 'Escalation paths',
      updatedAt: 1,
      unreadReason: 'timed out',
      ...undecided,
    },
  ];

  it('calls no page read while the first sync of its source has not finished', (): void => {
    backend.pages = pages;
    backend.readState = null;
    expect(chips()).toEqual(['Active', 'Active', 'Earlier version']);
  });

  it('calls a page read once the last sync named every page it could not read', (): void => {
    backend.pages = pages;
    backend.readState = { completedAt: 1, unreadCount: 1, unreadNamed: 1 };
    expect(chips()).toEqual(['Active', 'Read', 'Active', 'Earlier version']);
  });

  it('calls no unmarked page read when the sync could not read more pages than it named', (): void => {
    backend.pages = pages;
    backend.readState = { completedAt: 1, unreadCount: 14, unreadNamed: 10 };
    expect(chips()).toEqual(['Active', 'Active', 'Earlier version']);
  });
});

describe('a page’s status and who decided it (15-A; the wave file’s section 8)', (): void => {
  const at = Date.UTC(2026, 8, 26, 9, 10);
  const row = (fields: Record<string, unknown>) =>
    ({ _id: 'p1', ref: 'a.md', title: 'A', updatedAt: 1, ...fields }) as never;

  it('says each status on its chip, and Possibly superseded for a current page a relation proposes another for', (): void => {
    expect(statusChip({ status: 'active' })).toEqual({ text: 'Active', tone: 'ok' });
    expect(statusChip({ status: 'draft' }).text).toBe('Draft');
    expect(statusChip({ status: 'superseded' }).text).toBe('Superseded');
    expect(statusChip({ status: 'archived' }).text).toBe('Archived');
    expect(statusChip({ status: 'active', possiblySuperseded: true })).toEqual({
      text: 'Possibly superseded',
      tone: 'warn',
    });
  });

  it('says who or what decided it in the column’s words', (): void => {
    const words = (fields: Record<string, unknown>): string =>
      decidedByWords(row({ status: 'active', statusSource: 'default', ...fields }), 'UTC');
    expect(words({})).toBe('default');
    expect(words({ statusSource: 'manager', decidedByYou: true, decidedAt: at })).toBe(
      'you, 26 Sep 2026, 09:10',
    );
    expect(
      words({
        statusSource: 'manager',
        decidedByYou: false,
        decidedBy: 'earlier@acme.test',
        decidedAt: at,
      }),
    ).toBe('earlier@acme.test, 26 Sep 2026, 09:10');
    expect(words({ statusSource: 'source-native' })).toBe('the source');
    expect(words({ statusSource: 'marker' })).toBe('a marker in the page');
    expect(words({ statusSource: 'relation' })).toBe('a relation you confirmed');
    expect(words({ possiblySuperseded: true })).toBe('relation, above');
    // The manager's own word is named first (W15-R46): a page pinned current by hand read
    // "relation, above" while a relation still proposed another page as its later version.
    expect(
      words({
        possiblySuperseded: true,
        statusSource: 'manager',
        decidedByYou: true,
        decidedAt: at,
      }),
    ).toBe('you, 26 Sep 2026, 09:10');
  });

  const listed = [
    {
      _id: 'p1',
      ref: 'pipeline-runbook.md',
      title: 'Pipeline runbook',
      updatedAt: 1,
      status: 'superseded',
      statusSource: 'manager',
      decidedByYou: true,
      decidedAt: at,
      supersededBy: 'Pipeline runbook, version 2',
    },
    {
      _id: 'p2',
      ref: 'pipeline-runbook-v2.md',
      title: 'Pipeline runbook, version 2',
      updatedAt: 2,
      status: 'active',
      statusSource: 'default',
    },
  ];

  it('draws the Status and Decided by columns, what superseded a page, and each page’s controls', (): void => {
    backend.pages = listed;
    backend.readState = null;
    const view = mount(<PageTable source={SOURCE} zone="UTC" />);
    const headers = [...view.container.querySelectorAll('th[scope="col"]')].map(
      (header) => header.textContent,
    );
    expect(headers).toEqual(['Page', 'Status', 'Decided by', 'As of', 'Last sync']);
    const text = view.container.textContent ?? '';
    expect(text).toContain('Superseded by “Pipeline runbook, version 2”');
    expect(text).toContain('you, 26 Sep 2026, 09:10');
    const labels = [...view.container.querySelectorAll('button')].map(
      (button) => button.getAttribute('aria-label') ?? button.textContent,
    );
    // Clear is offered only where the manager decided the status by hand. Re-pinned by the
    // second pass's minor 11: each name now opens with the words its button shows.
    expect(labels).toEqual([
      'Mark superseded: Pipeline runbook, by the chosen page',
      'Mark archived: Pipeline runbook',
      'This is a draft: Pipeline runbook',
      'This is current: Pipeline runbook',
      'Clear your status for Pipeline runbook',
      'Mark superseded: Pipeline runbook, version 2, by the chosen page',
      'Mark archived: Pipeline runbook, version 2',
      'This is a draft: Pipeline runbook, version 2',
    ]);
    view.unmount();
  });

  it('marks a page archived, a draft, or back to what its source says, and says each outcome', async (): Promise<void> => {
    backend.pages = listed;
    backend.readState = null;
    const view = mount(<PageTable source={SOURCE} zone="UTC" />);
    await press(view.container, 'Mark archived: Pipeline runbook, version 2');
    await settle();
    await press(view.container, 'This is a draft: Pipeline runbook, version 2');
    await settle();
    await press(view.container, 'Clear your status for Pipeline runbook');
    await settle();
    expect(backend.calls).toEqual([
      { name: 'docStatus:setPageStatus', args: { pageId: 'p2', status: 'archived' } },
      { name: 'docStatus:setPageStatus', args: { pageId: 'p2', status: 'draft' } },
      { name: 'docStatus:clearPageStatus', args: { pageId: 'p1' } },
    ]);
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(
      '“Pipeline runbook” is back to what the page and its source say.',
    );
    view.unmount();
  });

  it('offers "This is current" on a page that is not current, whatever decided it, and on no current page', async (): Promise<void> => {
    // The second pass's major 1: a page a marker, a relation or its source took out of the
    // employee's reading had no control that put it back.
    backend.pages = [
      { ...listed[0], statusSource: 'relation', decidedByYou: undefined, decidedAt: undefined },
      listed[1],
    ];
    backend.readState = null;
    const view = mount(<PageTable source={SOURCE} zone="UTC" />);
    const current = [...view.container.querySelectorAll('button')].filter(
      (button) => button.textContent === 'This is current',
    );
    expect(current.map((button) => button.getAttribute('aria-label'))).toEqual([
      'This is current: Pipeline runbook',
    ]);
    await press(view.container, 'This is current: Pipeline runbook');
    await settle();
    expect(backend.calls).toEqual([
      { name: 'docStatus:setPageStatus', args: { pageId: 'p1', status: 'active' } },
    ]);
    expect(view.container.querySelector('[role="status"]')?.textContent).toBe(
      '“Pipeline runbook” is current, on your word. Clear takes that back.',
    );
    view.unmount();
  });

  it('marks a page superseded only once a page is chosen to take its place', async (): Promise<void> => {
    backend.pages = listed;
    backend.readState = null;
    const view = mount(<PageTable source={SOURCE} zone="UTC" />);
    const mark = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Mark superseded: Pipeline runbook, version 2, by the chosen page"]',
    )!;
    expect(mark.disabled).toBe(true);
    const picker = view.container.querySelector<HTMLSelectElement>('#successor-p2')!;
    expect([...picker.options].map((option) => option.textContent)).toEqual([
      'Choose a page',
      'Pipeline runbook',
    ]);
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    const { act } = await import('react');
    act((): void => {
      setter?.call(picker, 'p1');
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await press(view.container, 'Mark superseded: Pipeline runbook, version 2, by the chosen page');
    await settle();
    expect(backend.calls).toEqual([
      {
        name: 'docStatus:setPageStatus',
        args: { pageId: 'p2', status: 'superseded', supersededBy: 'p1' },
      },
    ]);
    view.unmount();
  });

  it('names every control with the words it shows, so the name a voice says is the one on the button (WCAG 2.5.3)', (): void => {
    // The second pass's minor 11: "Mark archived" was named "Mark Pipeline runbook archived" and
    // "This is a draft" was named "Pipeline runbook is a draft", so saying the words on the
    // button found no control.
    backend.pages = listed;
    backend.readState = null;
    const view = mount(<PageTable source={SOURCE} zone="UTC" />);
    const named = [...view.container.querySelectorAll('button[aria-label]')];
    expect(named.length).toBeGreaterThan(0);
    for (const button of named) {
      const shown = (button.textContent ?? '').trim();
      const name = button.getAttribute('aria-label') ?? '';
      expect(name.startsWith(shown), `"${shown}" is named "${name}"`).toBe(true);
    }
    view.unmount();
  });

  it('has no axe violation and gives every control a 44 px target', async (): Promise<void> => {
    backend.pages = listed;
    backend.readState = { completedAt: 1, unreadCount: 0, unreadNamed: 0 };
    const view = mount(<PageTable source={SOURCE} zone="UTC" />);
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    for (const control of view.container.querySelectorAll('button, input, select, textarea')) {
      expect(control.className, control.outerHTML.slice(0, 80)).toMatch(/\bmin-h-11\b/);
    }
    view.unmount();
  });
});
