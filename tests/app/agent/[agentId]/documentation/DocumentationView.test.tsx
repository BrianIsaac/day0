/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
  /** The pages each source's paginated read answers, by source id. */
  pages: {} as Record<string, unknown[]>,
  /** Every paginated read asked for, by source id. */
  paged: [] as string[],
}));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  usePaginatedQuery: (_reference: unknown, args: { sourceId: string }) => {
    backend.paged.push(args.sourceId);
    return {
      results: backend.pages[args.sourceId] ?? [],
      status: 'Exhausted',
      isLoading: false,
      loadMore: (): void => undefined,
    };
  },
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import { DocumentationView } from '../../../../../app/agent/[agentId]/documentation/DocumentationView';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { asEmployee, EMPLOYEE_ROW } from '../../../../fixtures/dom/employee';
import { mount, press } from '../../../../fixtures/dom/press';

/** Two linked sources, the second left out when the employee was deployed. */
const SOURCES = [
  {
    _id: 'source-wiki',
    _creationTime: 1,
    userId: 'owner',
    label: 'RevOps team wiki',
    kind: 'folder',
    locator: '.',
    status: 'synced',
    lastSyncAt: Date.UTC(2026, 8, 29, 14, 5),
    lastCompletedSyncId: 'run-1',
    createdAt: 1,
    updatedAt: 1,
    pageCount: 2,
  },
  {
    _id: 'source-guides',
    _creationTime: 2,
    userId: 'owner',
    label: 'How-to guides',
    kind: 'git',
    locator: 'https://git.example/guides#main',
    status: 'error',
    lastError: 'the repository refused the token',
    credentialId: 'credential-1',
    createdAt: 2,
    updatedAt: 2,
    pageCount: 1,
  },
];

/** The wiki's two stored pages, one the last sync could not read. */
const WIKI_PAGES = [
  {
    _id: 'page-1',
    ref: 'overview.md',
    title: 'Team overview',
    url: 'https://wiki.example/overview',
    updatedAt: Date.UTC(2026, 8, 25, 9, 0),
  },
  {
    _id: 'page-2',
    ref: 'escalation.md',
    title: 'Escalation paths',
    updatedAt: Date.UTC(2026, 8, 26, 9, 10),
    unreadReason: 'the page timed out',
  },
];

/** The employee, who left the how-to guides out at deploy. */
const READER = { ...EMPLOYEE_ROW, excludedDocSourceIds: ['source-guides'] } as Doc<'agents'>;

/** The tab in real mode with both sources, the wiki's pages and its read state loaded. */
function populated(): void {
  backend.queries = {
    'docSources:listMine': SOURCES,
    'docPages:readState': {
      completedAt: Date.UTC(2026, 8, 29, 14, 5),
      unreadCount: 1,
      unreadNamed: 1,
    },
  };
  backend.pages = {
    'source-wiki': WIKI_PAGES,
    'source-guides': [
      { _id: 'page-3', ref: 'sheets.md', title: 'Spreadsheet guide', updatedAt: 1 },
    ],
  };
}

afterEach((): void => {
  backend.queries = {};
  backend.pages = {};
  backend.paged = [];
  document.body.replaceChildren();
});

describe('DocumentationView', () => {
  it('sends real mode to the Documentation page and the Docs on the Surfaces tab', () => {
    const html = renderToStaticMarkup(asEmployee(<DocumentationView />, { surfaceMode: 'real' }));
    expect(html).toContain('href="/documentation"');
    expect(html).toContain('href="/agent/agent-1/surfaces"');
  });

  it('says the hosted office reads its own wiki, and links no page mock mode does not have', () => {
    const html = renderToStaticMarkup(asEmployee(<DocumentationView />));
    expect(html).toContain('reads the office&#x27;s wiki and how-to guides');
    expect(html).not.toContain('href="/documentation"');
    expect(html).not.toContain('Link a location');
  });

  it('lists every linked source with its state and whether this employee reads it', () => {
    populated();
    const view = mount(asEmployee(<DocumentationView />, { agent: READER, surfaceMode: 'real' }));
    // Each source is a row group: its facts, then its controls.
    const rows = view.container.querySelectorAll(
      'section[aria-label="Linked documentation"] tbody',
    );
    const text = [...rows].map((row) => row.textContent ?? '');

    expect(text[0]).toContain('RevOps team wiki');
    expect(text[0]).toContain('Last read 29 Sep 2026, 14:05');
    expect(text[0]).toContain('Yes');
    expect(text[1]).toContain('How-to guides');
    expect(text[1]).toContain('Could not read');
    expect(text[1]).toContain('the repository refused the token');
    expect(text[1]).toContain('No, left out at deploy');
    expect(view.container.textContent).toContain('Read by Mira');
    view.unmount();
  });

  it("lists the first source's pages, marking the one the last sync could not read, until another is picked", async () => {
    populated();
    const view = mount(asEmployee(<DocumentationView />, { agent: READER, surfaceMode: 'real' }));

    expect(view.container.textContent).toContain('Pages · RevOps team wiki');
    expect(view.container.textContent).toContain(
      'Last sync finished 29 Sep 2026, 14:05. 1 page it listed could not be read, and keeps its earlier version, marked below.',
    );
    const link = view.container.querySelector<HTMLAnchorElement>(
      'a[href="https://wiki.example/overview"]',
    );
    expect(link?.textContent).toBe('Team overview');
    expect(view.container.textContent).toContain('Not read: the page timed out');

    await press(view.container, 'Show the pages of How-to guides');
    expect(view.container.textContent).toContain('Pages · How-to guides');
    expect(view.container.textContent).toContain('Spreadsheet guide');
    expect(backend.paged.at(-1)).toBe('source-guides');
    view.unmount();
  });

  it('offers the link form in the kinds the backend reads', () => {
    populated();
    const html = renderToStaticMarkup(asEmployee(<DocumentationView />, { surfaceMode: 'real' }));
    for (const kind of ['folder', 'git', 'urls', 'mcp']) expect(html).toContain(`value="${kind}"`);
    expect(html).toContain('Link a location');
  });

  it('draws no trust, no decider and no relation card, which have no records behind them', () => {
    populated();
    const html = renderToStaticMarkup(asEmployee(<DocumentationView />, { surfaceMode: 'real' }));
    expect(html).not.toMatch(/Trust|Decided by|versions of the same runbook/);
  });

  it('has no axe violation and gives every control a 44 px target with both tables populated', async () => {
    populated();
    const view = mount(asEmployee(<DocumentationView />, { agent: READER, surfaceMode: 'real' }));
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    for (const control of view.container.querySelectorAll('button, input, select, textarea')) {
      expect(control.className, control.outerHTML.slice(0, 80)).toMatch(/\bmin-h-11\b/);
    }
    view.unmount();
  });
});
