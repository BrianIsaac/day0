import { describe, expect, it } from 'vitest';
import { splitPage } from '../../../src/docs/blocks';
import {
  BLOCKS_PER_PAGE_LIMIT,
  DOCUMENTATION_CHAR_LIMIT,
  SELECTED_BLOCK_LIMIT,
  SELECTED_PAGE_LIMIT,
  alwaysIncludedPages,
  documentationChars,
  pageBlocksOf,
  scoutQueries,
  selectDocumentation,
  selectionRequestFor,
  selectionSwitchedOff,
  type SelectablePage,
  type SelectableBlock,
  type SelectionRequest,
} from '../../../src/docs/select';
import { parseProcedureContract } from '../../../src/work/procedure-contract';

/** A page of the fixture handbook, keyed as a mirrored page is. */
function page(
  pageRef: string,
  title: string,
  body: string,
  category: SelectablePage['category'] = 'team-doc',
): SelectablePage {
  return {
    key: `source-1:${pageRef}`,
    slug: `doc-${pageRef.replace(/[^a-z0-9]+/gi, '-')}`,
    title,
    category,
    body,
    citeSource: 'Handbook',
    citePage: pageRef,
  };
}

/** Every block of the pages, with a stable fake id, as the scout would return them all. */
function everyBlock(pages: readonly SelectablePage[]): SelectableBlock[] {
  return pages.flatMap((entry) =>
    pageBlocksOf(entry).map((block) => ({ ...block, id: `${entry.key}#${block.index}` })),
  );
}

const ticketRunbook = page(
  'runbooks/update-ticket.md',
  'How to update a ticket',
  [
    '# How to update a ticket',
    '',
    '## Closing the loop',
    '',
    'When work originated in the ticket-queue, use ticket.update on the originating ticket.',
    'Set status: done for full completion and in-progress for partial completion.',
    'Add a one-line comment summarising the work.',
  ].join('\n'),
  'how-to-guide',
);

const tileRunbook = page(
  'runbooks/refresh-tile.md',
  'How to refresh the pipeline tile',
  [
    '# How to refresh the pipeline tile',
    '',
    '## Sign in',
    '',
    'Open the Looker pipeline tile and sign in with the stored account.',
    '',
    '## Refresh',
    '',
    'Press Refresh, then read back the coverage figure and the audit line.',
  ].join('\n'),
  'how-to-guide',
);

const holidays = page(
  'team/holidays.md',
  'Office holidays',
  ['# Office holidays', '', 'The office closes on the first Monday of August.'].join('\n'),
);

const request: SelectionRequest = {
  site: 'plan',
  title: 'Refresh the pipeline tile',
  summary: 'The coverage figure on the Looker pipeline tile is stale.',
  target: { slug: 'looker-pipeline-tile', displayName: 'Looker pipeline tile' },
  shape: { surfaceClass: 'analytics', operation: 'refresh-value' },
  roleFunction: 'Revenue operations coordination',
  requester: 'Priya Raman',
  writtenBrowserSurfaces: [],
};

describe('scoutQueries', (): void => {
  it('writes one query a field: the item, the target surface, the shape, the role and the requester', (): void => {
    const queries = scoutQueries(request, [ticketRunbook, tileRunbook, holidays]);
    expect(queries).toHaveLength(5);
    expect(queries[1].split(' ').sort()).toEqual(['looker', 'pipeline', 'tile']);
    expect(queries[4].split(' ').sort()).toEqual(['priya', 'raman']);
  });

  it('cuts a query to 16 terms, rarest first, and puts a term no page holds last', (): void => {
    const common = page('team/common.md', 'Common', 'alpha beta gamma');
    const pages = [
      common,
      page('team/a.md', 'A', 'alpha beta'),
      page('team/b.md', 'B', 'alpha'),
      page('team/c.md', 'C', 'delta'),
    ];
    const words = [
      'alpha',
      'beta',
      'gamma',
      'nothere',
      ...Array.from({ length: 20 }, (_unused, index) => `filler${index}`),
    ];
    const [query] = scoutQueries({ ...request, title: words.join(' '), summary: 'delta' }, pages);
    const terms = query.split(' ');
    expect(terms).toHaveLength(16);
    // gamma and delta are on one page each, beta on two, alpha on three; the rest on none.
    expect(terms.slice(0, 4)).toEqual(['gamma', 'delta', 'beta', 'alpha']);
    expect(terms.slice(4)).toEqual(['nothere', ...words.slice(4, 15)]);
  });

  it('writes a Chinese query as the bigrams the index holds', (): void => {
    const chinese = page(
      'team/zh.md',
      '刷新指南',
      '每个季度结束时请刷新管道看板然后在频道里发布结果',
    );
    const [query] = scoutQueries({ ...request, title: '刷新管道看板', summary: '' }, [chinese]);
    expect(query.split(' ').sort()).toEqual(['刷新', '新管', '看板', '管道', '道看'].sort());
  });
});

describe('alwaysIncludedPages', (): void => {
  it('keeps every page that yields a procedure trail, whatever the item says', (): void => {
    const always = alwaysIncludedPages([holidays, ticketRunbook, tileRunbook], {
      ...request,
      target: undefined,
      shape: undefined,
    });
    expect(always).toEqual([ticketRunbook.key]);
  });

  it('keeps a how-to guide that names the target surface and the shape’s operation', (): void => {
    expect(alwaysIncludedPages([holidays, tileRunbook], request)).toEqual([tileRunbook.key]);
  });

  it('does not keep a team page that names the target surface', (): void => {
    const notes = page(
      'team/tile-notes.md',
      'Tile notes',
      'The Looker pipeline tile is refreshed weekly.',
    );
    expect(alwaysIncludedPages([notes], request)).toEqual([]);
  });

  it('keeps a page documenting the form of a browser-driven surface the plan writes', (): void => {
    const form = page(
      'systems/tile-form.md',
      'Tile form',
      [
        '# Tile form',
        '',
        '```json',
        JSON.stringify({
          tool: 'mcp.call',
          args: {
            surface: 'looker-pipeline-tile',
            tool: 'browser_fill_form',
            toolArgsJson: JSON.stringify({ fields: [{ name: 'Coverage', value: '74%' }] }),
          },
        }),
        '```',
      ].join('\n'),
    );
    expect(alwaysIncludedPages([form], { ...request, shape: undefined })).toEqual([]);
    expect(
      alwaysIncludedPages([form], {
        ...request,
        shape: undefined,
        writtenBrowserSurfaces: ['looker-pipeline-tile'],
      }),
    ).toEqual([form.key]);
  });
});

describe('selectDocumentation', (): void => {
  it('always includes every procedure contract for the target surface', (): void => {
    const pages = [holidays, tileRunbook, ticketRunbook];
    const selection = selectDocumentation({
      request: { ...request, title: 'Office holidays in August', summary: 'When does it close?' },
      pages,
      scouted: everyBlock([holidays]),
    });
    expect(parseProcedureContract(selection)).toEqual(
      parseProcedureContract({
        howToGuides: pages.filter((entry) => entry.category === 'how-to-guide'),
        teamDocs: pages.filter((entry) => entry.category === 'team-doc'),
      }),
    );
    expect(selection.howToGuides.map((guide) => guide.slug)).toEqual([
      tileRunbook.slug,
      ticketRunbook.slug,
    ]);
  });

  it('assembles each page’s blocks in document order under a cite line, and maps each cite to its blocks', (): void => {
    const selection = selectDocumentation({
      request: { ...request, shape: undefined, target: undefined },
      pages: [tileRunbook],
      scouted: everyBlock([tileRunbook]).reverse(),
    });
    expect(selection.howToGuides).toEqual([
      {
        slug: tileRunbook.slug,
        title: tileRunbook.title,
        body: [
          '[cite: Handbook/runbooks/refresh-tile.md#How to refresh the pipeline tile > Sign in]',
          'Open the Looker pipeline tile and sign in with the stored account.',
          '',
          '[cite: Handbook/runbooks/refresh-tile.md#How to refresh the pipeline tile > Refresh]',
          'Press Refresh, then read back the coverage figure and the audit line.',
        ].join('\n'),
      },
    ]);
    expect(selection.citations).toEqual([
      {
        label: 'Handbook/runbooks/refresh-tile.md#How to refresh the pipeline tile > Sign in',
        blockIds: [`${tileRunbook.key}#0`],
      },
      {
        label: 'Handbook/runbooks/refresh-tile.md#How to refresh the pipeline tile > Refresh',
        blockIds: [`${tileRunbook.key}#1`],
      },
    ]);
    expect(selection.blockIds).toEqual([`${tileRunbook.key}#0`, `${tileRunbook.key}#1`]);
    expect(selection.chars).toBe(documentationChars(selection));
  });

  it('ranks the blocks that answer the item above the rest', (): void => {
    const selection = selectDocumentation({
      request: { ...request, shape: undefined, target: undefined },
      pages: [holidays, tileRunbook],
      scouted: everyBlock([holidays, tileRunbook]),
    });
    expect(selection.ranked[0]).toBe(`${tileRunbook.key}#1`);
  });

  it('picks at most 6 pages and 12 blocks, at most 4 a page', (): void => {
    const pages = Array.from({ length: 9 }, (_unused, pageIndex) =>
      page(
        `team/page-${pageIndex}.md`,
        `Page ${pageIndex}`,
        Array.from(
          { length: 6 },
          (_unused, section) =>
            `## Section ${section}\n\nThe pipeline tile note ${pageIndex}.${section}.`,
        ).join('\n\n'),
      ),
    );
    const selection = selectDocumentation({
      request: { ...request, shape: undefined, target: undefined },
      // A page that shares no word with them, so the tile's words still tell pages apart.
      pages: [...pages, holidays],
      scouted: everyBlock(pages),
    });
    const perPage = new Map<string, number>();
    for (const id of selection.picked) {
      const key = id.slice(0, id.indexOf('#'));
      perPage.set(key, (perPage.get(key) ?? 0) + 1);
    }
    expect(selection.picked).toHaveLength(SELECTED_BLOCK_LIMIT);
    expect(perPage.size).toBeLessThanOrEqual(SELECTED_PAGE_LIMIT);
    expect(Math.max(...perPage.values())).toBeLessThanOrEqual(BLOCKS_PER_PAGE_LIMIT);
  });

  it('carries at most 24,000 characters of documentation, guides first', (): void => {
    const long = (word: string): string =>
      Array.from(
        { length: 6 },
        (_unused, section) =>
          `## ${word} ${section}\n\n${`${word} Looker pipeline tile refresh coverage `.repeat(30)}`,
      ).join('\n\n');
    const guides = Array.from({ length: 6 }, (_unused, index) =>
      page(
        `runbooks/g${index}.md`,
        `How to refresh ${index}`,
        long(`guide${index}`),
        'how-to-guide',
      ),
    );
    const docs = Array.from({ length: 6 }, (_unused, index) =>
      page(`team/d${index}.md`, `Team ${index}`, long(`team${index}`)),
    );
    const pages = [...docs, ...guides];
    const selection = selectDocumentation({ request, pages, scouted: everyBlock(pages) });
    expect(selection.chars).toBeLessThanOrEqual(DOCUMENTATION_CHAR_LIMIT);
    expect(documentationChars(selection)).toBe(selection.chars);
    // Every guide names the target surface and its operation, so the guides fill the budget first.
    expect(selection.howToGuides.length).toBeGreaterThan(0);
    expect(selection.teamDocs).toEqual([]);
  });

  it('ranks no block that shares only a function word with the item', (): void => {
    const selection = selectDocumentation({
      request: { ...request, shape: undefined, target: undefined },
      pages: [holidays, tileRunbook],
      scouted: everyBlock([holidays, tileRunbook]),
    });
    // "The office closes on the first Monday" shares "on" and "the" with the item's summary.
    expect(selection.ranked.some((key) => key.startsWith(holidays.key))).toBe(false);
  });

  it('drops a scouted block whose page is no longer readable', (): void => {
    const selection = selectDocumentation({
      request: { ...request, shape: undefined, target: undefined },
      pages: [holidays],
      scouted: everyBlock([holidays, tileRunbook]),
    });
    expect(selection.howToGuides).toEqual([]);
    expect(selection.blockIds.every((id) => id.startsWith(holidays.key))).toBe(true);
  });

  it('finds a block in unspaced Chinese text through its bigrams', (): void => {
    const chinese = page(
      'team/zh.md',
      '季度流程',
      '# 季度流程\n\n每个季度结束时请刷新管道看板然后在频道里发布结果',
    );
    const selection = selectDocumentation({
      request: {
        ...request,
        title: '管道看板',
        summary: '',
        shape: undefined,
        target: undefined,
        roleFunction: '',
        requester: undefined,
      },
      pages: [holidays, chinese],
      scouted: everyBlock([holidays, chinese]),
    });
    expect(selection.ranked[0]).toBe(`${chinese.key}#0`);
    expect(selection.teamDocs.map((doc) => doc.slug)).toEqual([chinese.slug]);
  });
});

describe('pageBlocksOf', (): void => {
  it('splits a page as the store splits it', (): void => {
    expect(pageBlocksOf(tileRunbook).map((block) => block.text)).toEqual(
      splitPage(tileRunbook.body).map((block) => block.text),
    );
  });
});

describe('selectionRequestFor', (): void => {
  const surfaces = [
    { slug: 'linear', displayName: 'Linear', class: 'kanban', path: 'mcp' },
    {
      slug: 'looker-pipeline-tile',
      displayName: 'Looker pipeline tile',
      class: 'analytics',
      path: 'browser-driven',
    },
  ];
  const candidate = {
    title: 'Refresh the Looker pipeline tile',
    contentSummary: 'The coverage figure is stale.',
    sourceSystem: 'linear',
    requesterLabel: 'Priya',
  };

  it('asks for the surface the work acts on, its shape, the role and the requester', (): void => {
    expect(
      selectionRequestFor({
        site: 'execute',
        candidate,
        roleFunction: 'Revenue operations coordination',
        surfaces,
        obligations: { steps: [{ kind: 'write', reads: [], writes: ['looker-pipeline-tile'] }] },
      }),
    ).toEqual({
      site: 'execute',
      title: 'Refresh the Looker pipeline tile',
      summary: 'The coverage figure is stale.',
      target: { slug: 'looker-pipeline-tile', displayName: 'Looker pipeline tile' },
      shape: { surfaceClass: 'analytics', operation: 'refresh-value' },
      roleFunction: 'Revenue operations coordination',
      requester: 'Priya',
      writtenBrowserSurfaces: ['looker-pipeline-tile'],
    });
  });

  it('names no browser surface before a plan declares its writes', (): void => {
    expect(
      selectionRequestFor({ site: 'plan', candidate, roleFunction: '', surfaces })
        .writtenBrowserSurfaces,
    ).toEqual([]);
  });
});

describe('selectionSwitchedOff', (): void => {
  it('turns the selection off only when the test switch reads 1', (): void => {
    expect(selectionSwitchedOff({ DAY0_TEST_WHOLE_DOCUMENTATION: '1' })).toBe(true);
    expect(selectionSwitchedOff({ DAY0_TEST_WHOLE_DOCUMENTATION: '' })).toBe(false);
    expect(selectionSwitchedOff({ DAY0_TEST_WHOLE_DOCUMENTATION: 'true' })).toBe(false);
    expect(selectionSwitchedOff({})).toBe(false);
  });
});
