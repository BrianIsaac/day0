import { describe, expect, it } from 'vitest';
import { splitPage } from '../../../src/docs/blocks';
import {
  BLOCKS_PER_PAGE_LIMIT,
  DOCUMENTATION_CHAR_LIMIT,
  PICK_FLOOR_CHARS,
  SELECTED_BLOCK_LIMIT,
  SELECTED_PAGE_LIMIT,
  alwaysIncludedPages,
  documentationChars,
  pageBlocksOf,
  scoutQueries,
  selectDocumentation,
  selectionRequestFor,
  selectionSwitchedOff,
  carriesCiteLines,
  withoutCiteLines,
  type SelectablePage,
  type SelectableBlock,
  type SelectionRequest,
} from '../../../src/docs/select';
import { parseProcedureContract } from '../../../src/work/procedure-contract';
import { planUserPrompt } from '../../../src/work/plan';
import { planObligationsPrompt } from '../../../src/work/plan-obligations';
import { executorInstructions } from '../../../src/work/execute-skill';
import { renderHowTos, renderTeamDocs } from '../../../src/work/documents';
import type { Charter } from '../../../src/agent/charter';
import type { MockSurfaceSnapshot } from '../../../src/work/types';

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

/** The closing section of a ticket runbook: the paragraph a procedure contract is parsed from. */
const TICKET_CLOSING = [
  '## Closing the loop',
  '',
  'When work originated in the ticket-queue, use ticket.update on the originating ticket.',
  'Set status: done for full completion and in-progress for partial completion.',
  'Add a one-line comment summarising the work.',
].join('\n');

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
    // The contract's page spends the budget first, then the target surface's guide.
    expect(selection.howToGuides.map((guide) => guide.slug)).toEqual([
      ticketRunbook.slug,
      tileRunbook.slug,
    ]);
  });

  it('keeps every procedure contract when the pages always included outgrow the bound', (): void => {
    const filler = (word: string): string =>
      Array.from(
        { length: 9 },
        (_unused, section) =>
          `## ${word} part ${section}\n\n${`${word} Looker pipeline tile refresh coverage note. `.repeat(30)}`,
      ).join('\n\n');
    // A guide that fills most of the budget first, then a runbook whose contract is its last section.
    const bigGuide = page(
      'runbooks/big.md',
      'How to refresh the tile, in full',
      filler('big'),
      'how-to-guide',
    );
    const contractLast = page(
      'runbooks/update-ticket-long.md',
      'How to update a ticket, in full',
      `${filler('ticket')}\n\n${TICKET_CLOSING}`,
      'how-to-guide',
    );
    const pages = [bigGuide, contractLast];
    const whole = parseProcedureContract({ howToGuides: pages, teamDocs: [] });
    expect(whole.trails).toHaveLength(1);
    const selection = selectDocumentation({ request, pages, scouted: everyBlock(pages) });
    expect(selection.chars).toBeLessThanOrEqual(DOCUMENTATION_CHAR_LIMIT);
    expect(bigGuide.body.length + contractLast.body.length).toBeGreaterThan(
      DOCUMENTATION_CHAR_LIMIT,
    );
    expect(parseProcedureContract(selection).trails.map((trail) => trail.effect)).toEqual(
      whole.trails.map((trail) => trail.effect),
    );
  });

  it("keeps every page's contract when one contract page alone fills the bound, its needed blocks spent first (W14-R3)", (): void => {
    // Reader 2's pair: a ticket runbook of about 24,000 characters whose contract is its last
    // section, beside a short page whose contract posts the recap to the manager.
    const long = page(
      'runbooks/update-ticket-long.md',
      'How to update a ticket, in full',
      `${Array.from(
        { length: 16 },
        (_unused, section) =>
          `## Ticket part ${section}\n\n${'Ticket Looker pipeline tile refresh coverage note. '.repeat(30)}`,
      ).join('\n\n')}\n\n${TICKET_CLOSING}`,
      'how-to-guide',
    );
    const recap = page(
      'runbooks/post-recap.md',
      'How to post the recap',
      [
        '# How to post the recap',
        '',
        '## Recap to the manager',
        '',
        "Post the recap with slack.postMessage to the manager's private channel: put `manager-dm` in channelSlug and the recap text in `body`.",
      ].join('\n'),
      'how-to-guide',
    );
    const pages = [long, recap];
    const whole = parseProcedureContract({ howToGuides: pages, teamDocs: [] });
    expect(whole.trails.map((trail) => trail.effect.tool).sort()).toEqual([
      'slack.postMessage',
      'ticket.update',
    ]);
    expect(long.body.length).toBeGreaterThan(DOCUMENTATION_CHAR_LIMIT - 1_000);
    const selection = selectDocumentation({ request, pages, scouted: everyBlock(pages) });
    expect(selection.chars).toBeLessThanOrEqual(DOCUMENTATION_CHAR_LIMIT);
    expect(
      parseProcedureContract(selection)
        .trails.map((trail) => trail.effect.tool)
        .sort(),
    ).toEqual(['slack.postMessage', 'ticket.update']);
  });

  it('takes the pages always included as given, so the caller works them out once (W14-R4)', (): void => {
    const pages = [holidays, tileRunbook, ticketRunbook];
    const asked = { request, pages, scouted: everyBlock(pages) };
    const given = selectDocumentation({ ...asked, always: [holidays.key] });
    expect(given.always).toEqual([holidays.key]);
    expect(selectDocumentation(asked).always).toEqual(alwaysIncludedPages(pages, request));
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
        blocks: [{ id: `${tileRunbook.key}#0` }],
      },
      {
        label: 'Handbook/runbooks/refresh-tile.md#How to refresh the pipeline tile > Refresh',
        blocks: [{ id: `${tileRunbook.key}#1` }],
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

  it('ranks an official page above a team page above a personal one when they answer the item alike (A5)', (): void => {
    const body = '# Tile notes\n\nRefresh the Looker pipeline tile coverage figure every Monday.';
    const personal = {
      ...page('mine/tile.md', 'Tile notes', body),
      authority: 'personal' as const,
    };
    const team = { ...page('team/tile.md', 'Tile notes', body), authority: 'team' as const };
    const official = {
      ...page('official/tile.md', 'Tile notes', body),
      authority: 'official' as const,
    };
    // The mirror lists the personal page first: trust, not place, orders the three.
    const pages = [personal, team, official, holidays];
    const selection = selectDocumentation({
      request: { ...request, shape: undefined, target: undefined },
      pages,
      scouted: everyBlock(pages),
    });
    expect(selection.ranked.slice(0, 3)).toEqual([
      `${official.key}#0`,
      `${team.key}#0`,
      `${personal.key}#0`,
    ]);
  });

  it('reads a page with no trust as a team page, between official and personal', (): void => {
    const body = '# Tile notes\n\nRefresh the Looker pipeline tile coverage figure every Monday.';
    const personal = {
      ...page('mine/tile.md', 'Tile notes', body),
      authority: 'personal' as const,
    };
    const untold = page('team/tile.md', 'Tile notes', body);
    const official = {
      ...page('official/tile.md', 'Tile notes', body),
      authority: 'official' as const,
    };
    const pages = [personal, untold, official, holidays];
    const selection = selectDocumentation({
      request: { ...request, shape: undefined, target: undefined },
      pages,
      scouted: everyBlock(pages),
    });
    expect(selection.ranked.slice(0, 3)).toEqual([
      `${official.key}#0`,
      `${untold.key}#0`,
      `${personal.key}#0`,
    ]);
  });

  it('lets recency order only pages of equal trust that answer alike, and never over trust', (): void => {
    const body = '# Tile notes\n\nRefresh the Looker pipeline tile coverage figure every Monday.';
    const older = { ...page('team/tile-a.md', 'Tile notes', body), updatedAt: 1 };
    const newer = { ...page('team/tile-b.md', 'Tile notes', body), updatedAt: 2 };
    const newestButPersonal = {
      ...page('mine/tile.md', 'Tile notes', body),
      authority: 'personal' as const,
      updatedAt: 3,
    };
    const pages = [older, newer, newestButPersonal, holidays];
    const selection = selectDocumentation({
      request: { ...request, shape: undefined, target: undefined },
      pages,
      scouted: everyBlock(pages),
    });
    expect(selection.ranked.slice(0, 3)).toEqual([
      `${newer.key}#0`,
      `${older.key}#0`,
      `${newestButPersonal.key}#0`,
    ]);
  });

  it('weighs trust, it does not sort by it: a team page that answers the item stays above an official page that barely does', (): void => {
    const answer = page(
      'team/tile.md',
      'Tile notes',
      '# Tile notes\n\nRefresh the Looker pipeline tile: the coverage figure is stale after the standup.',
    );
    const barely = {
      ...page(
        'official/glossary.md',
        'Glossary',
        '# Glossary\n\nA figure is a number in a report.',
      ),
      authority: 'official' as const,
    };
    const pages = [barely, answer, holidays];
    const selection = selectDocumentation({
      request: { ...request, shape: undefined, target: undefined },
      pages,
      scouted: everyBlock(pages),
    });
    expect(selection.ranked[0]).toBe(`${answer.key}#0`);
  });

  it('keeps a floor of the budget for the ranked pick when the pages always included would fill it (D-3)', (): void => {
    // A guide for the target surface, always included, longer than the whole budget.
    const guide = page(
      'runbooks/long.md',
      'How to refresh the tile',
      Array.from(
        { length: 40 },
        (_unused, section) =>
          `## Looker tile refresh, part ${section}\n\n${`Refresh the Looker pipeline tile. `.repeat(25)}`,
      ).join('\n\n'),
      'how-to-guide',
    );
    const answer = page(
      'team/coverage.md',
      'Coverage figure',
      '# Coverage figure\n\nThe coverage figure on the pipeline tile is stale until the nightly load finishes at six.',
    );
    const pages = [guide, answer, holidays];
    const selection = selectDocumentation({ request, pages, scouted: everyBlock(pages) });
    expect(selection.always).toEqual([guide.key]);
    expect(selection.chars).toBeLessThanOrEqual(DOCUMENTATION_CHAR_LIMIT);
    // The always-included guide is cut to leave the pick its floor, and the answer is carried.
    expect(selection.teamDocs.map((doc) => doc.title)).toEqual(['Coverage figure']);
    expect(selection.howToGuides).toHaveLength(1);
    expect(PICK_FLOOR_CHARS).toBe(6_000);
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

describe('selectDocumentation and a passage two pages disagree on (15-A)', (): void => {
  it('tags the cite line of a disputed block [conflict], and no other, with what it disputes on its citation', (): void => {
    const blocks = everyBlock([tileRunbook, holidays]).map((block) => ({
      ...block,
      hash: `hash-${block.id}`,
    }));
    const disputed = blocks.find((block) => block.text.includes('Press Refresh'))!;
    const conflict = {
      relationId: 'relation-1',
      heading: 'Refresh',
      pages: [
        { title: 'How to refresh the pipeline tile', source: 'Handbook' },
        { title: 'Tile notes', source: 'Team wiki' },
      ],
    } as const;
    const selection = selectDocumentation({
      request,
      pages: [tileRunbook, holidays],
      scouted: blocks,
      pageBlocks: new Map([[tileRunbook.key, blocks.filter((b) => b.pageKey === tileRunbook.key)]]),
      conflicts: new Map([[disputed.hash, conflict]]),
    });
    const lines = selection.howToGuides[0].body
      .split('\n')
      .filter((line) => line.startsWith('[cite: '));
    expect(lines).toEqual([
      '[cite: Handbook/runbooks/refresh-tile.md#How to refresh the pipeline tile > Sign in]',
      '[cite: Handbook/runbooks/refresh-tile.md#How to refresh the pipeline tile > Refresh] [conflict]',
    ]);
    expect(selection.citations.map((citation) => citation.conflict)).toEqual([undefined, conflict]);
    // A tagged line is still a cite line: found as one, and never part of what a message quotes.
    expect(carriesCiteLines(selection.howToGuides[0].body)).toBe(true);
    expect(withoutCiteLines(selection.howToGuides[0].body)).not.toContain('[conflict]');
    expect(selection.chars).toBe(documentationChars(selection));
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

describe('the four prompts that carry documentation', (): void => {
  const charter: Charter = {
    version: '0.0',
    source: 'day-1 manager 1:1',
    whyThisHire: 'Keep the pipeline current.',
    proposedFunction: 'Revenue operations coordination',
    evidence: [],
    shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
    proposedBoundaries: { willDo: ['Refresh the tile.'], willNotDo: [], escalationTriggers: [] },
    namedCollaborators: [],
    namedSystems: [],
    priorityReading: [],
    adjacentRoles: [],
    approvalChain: { boss: 'Manager', confidence: 'high' },
    openQuestions: [],
    createdAt: '2026-10-08T00:00:00.000Z',
  };
  /** A handbook of 40 pages of 6,000 characters, every one about the tile, far past the bound. */
  const handbook = Array.from({ length: 40 }, (_unused, index) =>
    page(
      `team/page-${index}.md`,
      `Pipeline notes ${index}`,
      Array.from(
        { length: 5 },
        (_unused, section) =>
          `## Part ${section}\n\n${`Looker pipeline tile coverage figure note ${index} ${section}. `.repeat(24)}`,
      ).join('\n\n'),
      index % 2 === 0 ? 'how-to-guide' : 'team-doc',
    ),
  );

  it('carry at most 24,000 characters of documentation, and only the selection', (): void => {
    const selection = selectDocumentation({
      request,
      pages: handbook,
      scouted: everyBlock(handbook),
    });
    const documents: Pick<MockSurfaceSnapshot, 'howToGuides' | 'teamDocs'> = {
      howToGuides: selection.howToGuides,
      teamDocs: selection.teamDocs,
    };
    expect(handbook.reduce((total, entry) => total + entry.body.length, 0)).toBeGreaterThan(
      200_000,
    );
    expect(selection.chars).toBeLessThanOrEqual(DOCUMENTATION_CHAR_LIMIT);
    const guides = renderHowTos(documents.howToGuides);
    const team = renderTeamDocs(documents.teamDocs);
    const planner = planUserPrompt({
      candidate: {
        sourceCategory: 'ticket-queue',
        sourceSystem: 'linear',
        externalId: 'REVOPS-1',
        title: request.title,
        contentSummary: request.summary,
        contentRefs: [],
        observedAt: new Date(0),
        priority: 'P2',
      },
      charter,
      surfaceMode: 'real',
      documents,
    });
    const obligations = planObligationsPrompt({
      plan: { summary: 'Refresh.', steps: ['Refresh the tile.'], expectedOutputType: 'message' },
      charter,
      surfaces: [],
      documents,
      now: 0,
    });
    const system = executorInstructions({
      mode: 'real',
      autonomousActions: false,
      skillBody: '# Skill',
      surfaces: [],
      mockEnv: { ...documents, spreadsheets: [], slackChannels: [], tweets: [], tickets: [] },
      now: 0,
    });
    for (const prompt of [planner, obligations]) {
      expect(prompt).toContain(guides);
      expect(prompt).toContain(team);
    }
    // The executor's system prompt carries the guides, and both phases' user prompts the team
    // documents as renderTeamDocs writes them.
    expect(system).toContain(guides);
    expect(guides.length + team.length).toBeLessThanOrEqual(DOCUMENTATION_CHAR_LIMIT);
    const unselected = handbook.filter(
      (entry) =>
        !selection.howToGuides.some((guide) => guide.slug === entry.slug) &&
        !selection.teamDocs.some((doc) => doc.slug === entry.slug),
    );
    expect(unselected.length).toBeGreaterThan(0);
    for (const prompt of [planner, obligations, system]) {
      for (const entry of unselected) expect(prompt).not.toContain(`--- ${entry.title} ---`);
    }
  });
});

describe('cite lines', (): void => {
  const body = [
    '[cite: Handbook/runbooks/refresh-tile.md#Sign in]',
    'Open the tile.',
    '',
    '[cite: Handbook/runbooks/refresh-tile.md#Refresh]',
    'Press Refresh.',
  ].join('\n');

  it('are found in assembled documentation and not in a page as written', (): void => {
    expect(carriesCiteLines(body)).toBe(true);
    expect(carriesCiteLines(tileRunbook.body)).toBe(false);
    expect(carriesCiteLines('See [cite: inline] in a sentence.')).toBe(false);
  });

  it('leave the text a message may quote, from one block into the next', (): void => {
    expect(withoutCiteLines(body)).toBe('Open the tile.\n\nPress Refresh.');
  });
});
