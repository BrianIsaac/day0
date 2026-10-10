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
  /** Every mutation called, by function name. */
  calls: [] as Array<{ name: string; args: unknown }>,
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
  useMutation:
    (reference: unknown) =>
    async (args: unknown): Promise<void> => {
      backend.calls.push({ name: getFunctionName(reference as never), args });
    },
  useAction: () => async (): Promise<void> => undefined,
}));

import { DocumentationView } from '../../../../../app/agent/[agentId]/documentation/DocumentationView';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { asEmployee, EMPLOYEE_ROW } from '../../../../fixtures/dom/employee';
import { choose, mount, press, said, settle } from '../../../../fixtures/dom/press';

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

/**
 * The wiki's two stored pages, one the last sync could not read. Each row carries its status and
 * what decided it since 15-A (A5): the first as the manager marked it, the second with a
 * relation still to answer.
 */
const WIKI_PAGES = [
  {
    _id: 'page-1',
    ref: 'overview.md',
    title: 'Team overview',
    url: 'https://wiki.example/overview',
    updatedAt: Date.UTC(2026, 8, 25, 9, 0),
    status: 'active',
    statusSource: 'default',
  },
  {
    _id: 'page-2',
    ref: 'escalation.md',
    title: 'Escalation paths',
    updatedAt: Date.UTC(2026, 8, 26, 9, 10),
    unreadReason: 'the page timed out',
    status: 'active',
    statusSource: 'default',
    possiblySuperseded: true,
  },
];

/** The two relations the manager has still to answer: a later version, and a confirmed conflict. */
const RELATIONS = [
  {
    _id: 'relation-1',
    kind: 'possible_successor',
    status: 'proposed',
    from: {
      sourceId: 'source-guides',
      ref: 'escalation-v2.md',
      title: 'Escalation paths, draft v2',
      source: 'How-to guides',
      updatedAt: Date.UTC(2026, 8, 26, 9, 10),
    },
    to: {
      sourceId: 'source-wiki',
      ref: 'escalation.md',
      title: 'Escalation paths',
      source: 'RevOps team wiki',
      updatedAt: Date.UTC(2026, 8, 25, 9, 0),
    },
    evidence: [{ measure: 'shared-text', value: 78 }],
    offered: ['supersedes', 'keep-both', 'not-the-same'],
  },
  {
    _id: 'relation-2',
    kind: 'possible_conflict',
    status: 'confirmed',
    from: {
      sourceId: 'source-guides',
      ref: 'finance.md',
      title: 'Finance escalation',
      source: 'How-to guides',
      updatedAt: 2,
    },
    to: {
      sourceId: 'source-wiki',
      ref: 'close.md',
      title: 'Close checklist',
      source: 'RevOps team wiki',
      updatedAt: 1,
    },
    evidence: [{ measure: 'heading-figures', value: 1 }],
    disagreement: { heading: 'Thresholds', figures: { from: '10,000', to: '5,000' } },
    offered: ['from-is-right', 'to-is-right', 'both-hold'],
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
      {
        _id: 'page-3',
        ref: 'sheets.md',
        title: 'Spreadsheet guide',
        updatedAt: 1,
        status: 'active',
        statusSource: 'default',
      },
    ],
  };
}

afterEach((): void => {
  backend.queries = {};
  backend.pages = {};
  backend.paged = [];
  backend.calls = [];
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
    // Walk m3: the build dropped the space after the name ("Adareads").
    expect(html).toContain('In the hosted office Mira reads the office’s wiki and how-to guides');
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
      'Last sync finished 29 Sep 2026, 14:05. 1 page it listed could not be read; where an earlier version was stored, it is kept. It is marked in the table.',
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
    // Re-pinned by 15-A: the form offers Feishu too since 14-F, which the list here had not named.
    for (const kind of ['folder', 'git', 'urls', 'mcp', 'feishu']) {
      expect(html).toContain(`value="${kind}"`);
    }
    expect(html).toContain('Link a location');
  });

  // Re-pinned by 15-A: this test pinned the absence of trust, the decider and the relation card
  // "which have no records behind them". The records exist since 0.19.0 (A5), so it now pins
  // every state the prototype draws (`agent-documentation.html`).
  it('draws trust for each source, each page’s status with who decided it, and a card for each relation still to answer', () => {
    populated();
    backend.queries['docRelations:listOpen'] = RELATIONS;
    const view = mount(asEmployee(<DocumentationView />, { agent: READER, surfaceMode: 'real' }));
    const text = view.container.textContent ?? '';
    // The Sources card says the order, and each source has its Trust select; absent reads as team.
    expect(text).toContain(
      'official over team over personal; within a source a page’s status decides; recency only breaks ties',
    );
    const trust = view.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Trust for RevOps team wiki"]',
    );
    expect(trust?.value).toBe('team');
    expect([...(trust?.options ?? [])].map((option) => option.textContent)).toEqual([
      'Official',
      'Team',
      'Personal',
    ]);
    // The relation card, in the prototype's words, with the measure and the three answers.
    expect(text).toContain('These two look like versions of the same runbook');
    expect(text).toContain(
      '“Escalation paths” (RevOps team wiki, edited 25 Sep 2026, 09:00) and “Escalation paths, draft v2” (How-to guides, edited 26 Sep 2026, 09:10) share 78 percent of their text. Mira reads both until you say otherwise.',
    );
    expect(text).toContain('Keep both');
    expect(text).toContain('Not the same');
    // The conflict card for a confirmed conflict, in section 8's words.
    expect(text).toContain(
      '“Finance escalation” (How-to guides) and “Close checklist” (RevOps team wiki) disagree under “Thresholds”: 10,000 against 5,000. Mira holds any step that relies on it and asks you.',
    );
    expect(text).toContain('Both hold');
    // The page table's Status and Decided by columns.
    expect(text).toContain('Decided by');
    expect(text).toContain('Possibly superseded');
    expect(text).toContain('relation, above');
    view.unmount();
  });

  it('changes a source’s trust from its row and says so', async () => {
    populated();
    const view = mount(asEmployee(<DocumentationView />, { agent: READER, surfaceMode: 'real' }));
    const trust = view.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Trust for RevOps team wiki"]',
    )!;
    await choose(trust, 'official');
    await settle();
    expect(backend.calls).toEqual([
      {
        name: 'docStatus:setSourceAuthority',
        args: { sourceId: 'source-wiki', authority: 'official' },
      },
    ]);
    expect(said(view.container)).toContain('RevOps team wiki is now trusted as official.');
    view.unmount();
  });

  it('records the manager’s answer on a relation’s card and on a conflict’s', async () => {
    populated();
    backend.queries['docRelations:listOpen'] = RELATIONS;
    const view = mount(asEmployee(<DocumentationView />, { agent: READER, surfaceMode: 'real' }));
    await press(
      view.container,
      '“Escalation paths, draft v2” (How-to guides) supersedes “Escalation paths” (RevOps team wiki)',
    );
    await settle();
    await press(view.container, 'Both hold');
    await settle();
    expect(backend.calls).toEqual([
      { name: 'docRelations:decide', args: { relationId: 'relation-1', decision: 'supersedes' } },
      { name: 'docRelations:decide', args: { relationId: 'relation-2', decision: 'both-hold' } },
    ]);
    view.unmount();
  });

  it('draws a proposed conflict as one that may disagree and holds nothing, with the answer that confirms it', () => {
    populated();
    backend.queries['docRelations:listOpen'] = [
      {
        ...RELATIONS[1],
        status: 'proposed',
        offered: ['disagree', 'from-is-right', 'to-is-right', 'both-hold'],
      },
    ];
    const view = mount(asEmployee(<DocumentationView />, { agent: READER, surfaceMode: 'real' }));
    const text = view.container.textContent ?? '';
    expect(text).toContain('These two pages may disagree');
    expect(text).toContain(
      'may disagree under “Thresholds”: 10,000 against 5,000. Nothing is held until you say they disagree.',
    );
    expect(text).toContain('They disagree');
    view.unmount();
  });

  it('has no axe violation and gives every control a 44 px target with both tables and both cards populated', async () => {
    populated();
    backend.queries['docRelations:listOpen'] = RELATIONS;
    const view = mount(asEmployee(<DocumentationView />, { agent: READER, surfaceMode: 'real' }));
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    for (const control of view.container.querySelectorAll('button, input, select, textarea')) {
      expect(control.className, control.outerHTML.slice(0, 80)).toMatch(/\bmin-h-11\b/);
    }
    view.unmount();
  });
});
