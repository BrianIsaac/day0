import { describe, expect, it } from 'vitest';
import { splitPage } from '../../../src/docs/blocks';
import {
  DATED_SUCCESSOR_GAP_MS,
  RELATION_EVIDENCE_BLOCKS,
  RELATION_MEASURES,
  RELATION_PROPOSALS_PER_SYNC,
  SHARED_TEXT_DUPLICATE,
  headingFigures,
  measureRelation,
  namedSuccessor,
  relationWords,
  sharedText,
  titleVersion,
  type MeasuredPage,
} from '../../../src/docs/relations';

/** A page as the measures read it, its blocks split as the store splits them. */
function page(
  key: string,
  title: string,
  markdown: string,
  updatedAt = 1,
  edited = true,
): MeasuredPage {
  return {
    key,
    ref: key.split(':').pop() ?? key,
    title,
    markdown,
    updatedAt,
    edited,
    blocks: splitPage(markdown).map((block) => ({
      hash: block.hash,
      headingPath: block.headingPath,
      text: block.text,
    })),
  };
}

const ESCALATION = [
  '# Escalation paths',
  '',
  'Who to call when a close slips.',
  '',
  '## First line',
  '',
  'Page the revenue operations lead.',
  '',
  '## Thresholds',
  '',
  'Escalate any variance above 5,000 USD to the finance lead.',
  '',
  '## After hours',
  '',
  'Use the on-call rota in the handbook.',
].join('\n');

describe('the relation measures and their caps', (): void => {
  it('are five, named for the card, with the caps a sync and a row keep to', (): void => {
    // `edit-dates` joined in wave 16 (16-FD, RM19 (a)): the dated successor between copies.
    expect(RELATION_MEASURES).toEqual([
      'shared-text',
      'title-version',
      'names-successor',
      'heading-figures',
      'edit-dates',
    ]);
    expect(DATED_SUCCESSOR_GAP_MS).toBe(24 * 60 * 60 * 1000);
    expect(RELATION_PROPOSALS_PER_SYNC).toBe(50);
    expect(RELATION_EVIDENCE_BLOCKS).toBe(8);
    expect(SHARED_TEXT_DUPLICATE).toBe(60);
  });
});

describe('sharedText', (): void => {
  it('finds the text two pages share under different titles, as a percent of the text either holds', (): void => {
    const wiki = page('wiki:escalation.md', 'Escalation paths', ESCALATION);
    const copy = page(
      'guides:escalation-v2.md',
      'Escalation paths, draft v2',
      `${ESCALATION.replace('# Escalation paths', '# Escalation paths, draft v2')}\n\n## Duty phone\n\nOr call the duty phone.`,
    );
    // No block hash is shared: every heading path opens with the page's own title.
    expect(
      wiki.blocks.some((block) => copy.blocks.some((other) => other.hash === block.hash)),
    ).toBe(false);
    const shared = sharedText(wiki, copy);
    // Four blocks of 159 characters are shared; the copy holds 23 more of its own.
    expect(shared.share).toBe(87);
    expect(shared.blockRefs).toHaveLength(8);
    expect(shared.blockRefs.slice(0, 2)).toEqual([wiki.blocks[0].hash, copy.blocks[0].hash]);
  });

  it('is 100 for the same text twice, 0 for unrelated pages, and keeps at most eight block hashes', (): void => {
    const wiki = page('wiki:escalation.md', 'Escalation paths', ESCALATION);
    expect(sharedText(wiki, page('other:copy.md', 'Copy', ESCALATION)).share).toBe(100);
    expect(
      sharedText(wiki, page('other:holidays.md', 'Holidays', '# Holidays\n\nClosed in August.'))
        .share,
    ).toBe(0);
    const long = Array.from(
      { length: 12 },
      (_unused, index) => `## Part ${index}\n\nText ${index}.`,
    ).join('\n\n');
    expect(
      sharedText(page('a:long.md', 'Long', long), page('b:long.md', 'Long', long)).blockRefs,
    ).toHaveLength(RELATION_EVIDENCE_BLOCKS);
    expect(sharedText({ blocks: [] }, { blocks: [] })).toEqual({ share: 0, blockRefs: [] });
  });
});

describe('titleVersion', (): void => {
  it('orders two titles that are one title but for a version, a year or a draft word', (): void => {
    expect(titleVersion('Escalation paths', 'Escalation paths, draft v2')).toBe('right');
    expect(titleVersion('Pipeline runbook v2', 'Pipeline runbook v1')).toBe('left');
    expect(titleVersion('Close checklist 2025', 'Close checklist 2026')).toBe('right');
    expect(titleVersion('Onboarding (old)', 'Onboarding')).toBe('right');
    expect(titleVersion('月结流程(2026版)', '月结流程(旧版)')).toBe('left');
    expect(titleVersion('月结流程 第2版', '月结流程 第3版')).toBe('right');
  });

  it('says nothing of two titles that differ in more than a version, or do not differ', (): void => {
    expect(titleVersion('Escalation paths', 'Escalation contacts')).toBeUndefined();
    expect(titleVersion('Pipeline runbook', 'Pipeline runbook')).toBeUndefined();
    expect(titleVersion('Runbook v2', 'Runbook v2')).toBeUndefined();
    expect(titleVersion('2026', 'v2')).toBeUndefined();
  });
});

describe('namedSuccessor', (): void => {
  const v1 = page(
    'wiki:runbooks/pipeline-runbook.md',
    'Pipeline runbook',
    '# Pipeline runbook\n\nRefresh once.',
  );

  it('reads a page whose front matter names the other by file name, ref or title as the later', (): void => {
    const byFile = page(
      'official:pipeline-runbook-v2.md',
      'Pipeline runbook',
      '---\nsupersedes: pipeline-runbook\n---\n# Pipeline runbook\n\nRefresh twice.',
    );
    expect(namedSuccessor(byFile, v1)).toBe('left');
    expect(namedSuccessor(v1, byFile)).toBe('right');
    const byRef = {
      ...byFile,
      markdown: '---\nsupersedes: runbooks/pipeline-runbook.md\n---\n# P',
    };
    expect(namedSuccessor(byRef, v1)).toBe('left');
    const byTitle = { ...byFile, markdown: '---\nsupersedes: "Pipeline Runbook"\n---\n# P' };
    expect(namedSuccessor(byTitle, v1)).toBe('left');
  });

  it('reads the page another says it was superseded by as the later, and nothing for a page neither names', (): void => {
    const old = {
      ...v1,
      markdown: '---\nsuperseded_by: pipeline-runbook-v2.md\n---\n# Pipeline runbook',
    };
    const v2 = page(
      'official:pipeline-runbook-v2.md',
      'Pipeline runbook',
      '# Pipeline runbook\n\nTwice.',
    );
    expect(namedSuccessor(old, v2)).toBe('right');
    expect(namedSuccessor(v1, v2)).toBeUndefined();
    expect(
      namedSuccessor({ ...v2, markdown: '---\nsupersedes: escalation-paths\n---\n# P' }, v1),
    ).toBeUndefined();
  });
});

describe('headingFigures', (): void => {
  const handbook = page('handbook:close.md', 'Close checklist', ESCALATION);
  const finance = page(
    'finance:escalation.md',
    'Finance escalation',
    [
      '# Finance escalation',
      '',
      '## Thresholds',
      '',
      'Escalate any variance above 10,000 USD to the finance lead.',
      '',
      '## First line',
      '',
      'Page the controller.',
    ].join('\n'),
  );

  it('finds the sentence two pages say with other figures under one heading, whatever their titles', (): void => {
    const [conflict, ...rest] = headingFigures(handbook, finance);
    expect(rest).toEqual([]);
    expect(conflict).toEqual({
      heading: 'Thresholds',
      left: '5,000',
      right: '10,000',
      blocks: [
        handbook.blocks.find((block) => block.text.includes('5,000'))!.hash,
        finance.blocks.find((block) => block.text.includes('10,000'))!.hash,
      ],
    });
  });

  it('finds none where the figures agree, the sentences differ in words, or the heading does', (): void => {
    expect(headingFigures(handbook, handbook)).toEqual([]);
    const reworded = page(
      'finance:other.md',
      'Other',
      '# Other\n\n## Thresholds\n\nAnything over 10,000 USD goes to the finance lead.',
    );
    expect(headingFigures(handbook, reworded)).toEqual([]);
    const elsewhere = page(
      'finance:limits.md',
      'Limits',
      '# Limits\n\n## Limits\n\nEscalate any variance above 10,000 USD to the finance lead.',
    );
    expect(headingFigures(handbook, elsewhere)).toEqual([]);
  });

  it('passes over a line that only dates or versions its page', (): void => {
    const a = page(
      'a:p.md',
      'P',
      '# P\n\n## Notes\n\nLast updated 2026-09-01.\nVersion 3 of this page.',
    );
    const b = page(
      'b:p.md',
      'P',
      '# P\n\n## Notes\n\nLast updated 2026-10-01.\nVersion 4 of this page.',
    );
    expect(headingFigures(a, b)).toEqual([]);
  });

  /** Two pages that say one line under "Review window" with other figures. */
  const window = (left: string, right: string): [MeasuredPage, MeasuredPage] => [
    page(
      'policies:review.md',
      'Close review window',
      `# Close review window\n\n## Review window\n\n${left}`,
    ),
    page(
      'revops:review.md',
      'Close review window',
      `# Close review window\n\n## Review window\n\n${right}`,
    ),
  ];

  it('reads a date word in a sentence that states a figure as part of the sentence: the joins’ review window is a conflict (W3c)', (): void => {
    // The joins' walk: this pair was proposed a duplicate, "reviewed" passing its line over.
    const [conflict, ...rest] = headingFigures(
      ...window(
        'A Q3 close ticket is reviewed within 2 working days of its audit comment.',
        'A Q3 close ticket is reviewed within 5 working days of its audit comment.',
      ),
    );
    expect(rest).toEqual([]);
    expect(conflict).toMatchObject({ heading: 'Review window', left: '3 2', right: '3 5' });
    for (const [left, right] of [
      [
        'A refund is effective within 3 working days.',
        'A refund is effective within 5 working days.',
      ],
      ['Updated figures are posted by 9:00.', 'Updated figures are posted by 10:00.'],
      ['As of the close, 2 approvers sign.', 'As of the close, 3 approvers sign.'],
      ['退款在 3 个工作日内生效。', '退款在 5 个工作日内生效。'],
    ]) {
      expect(headingFigures(...window(left, right)), left).toHaveLength(1);
    }
  });

  it('reads a year-shaped amount beside a date word as an amount: “above 2000 USD” is no date (17-FD’s second pass, item 7)', (): void => {
    for (const [left, right] of [
      [
        'Effective now, escalate any variance above 2000 USD.',
        'Effective now, escalate any variance above 3000 USD.',
      ],
      [
        'Updated policy: refunds above 2000 USD need two approvers.',
        'Updated policy: refunds above 2050 USD need two approvers.',
      ],
      ['As of the close, the cap is $2000.', 'As of the close, the cap is $2500.'],
      [
        'Reviewed monthly: at most 1999 rows a load.',
        'Reviewed monthly: at most 2020 rows a load.',
      ],
      ['更新：超过 2000 元的退款需两人审批。', '更新：超过 3000 元的退款需两人审批。'],
    ]) {
      expect(headingFigures(...window(left, right)), left).toHaveLength(1);
    }
  });

  it('still passes over a date word beside a date, a date alone and a version beside its number (W3c)', (): void => {
    for (const [left, right] of [
      ['Last reviewed 3 October 2026.', 'Last reviewed 9 October 2026.'],
      ['Reviewed on Oct 3, 2026 by the controller.', 'Reviewed on Oct 9, 2026 by the controller.'],
      ['Effective from 1 January 2027.', 'Effective from 1 March 2027.'],
      ['Updated 3/10/26.', 'Updated 9/10/26.'],
      ['As of 2025.', 'As of 2026.'],
      ['Copyright 2025 Kestrel Supply Co.', 'Copyright 2026 Kestrel Supply Co.'],
      ['Synced 2026-10-01.', 'Synced 2026-10-09.'],
      ['Revision 7.', 'Revision 8.'],
      ['更新于 2026年10月3日。', '更新于 2026年10月9日。'],
      ['版本 3', '版本 4'],
      // The second pass: a full-width colon, a day and month with no year, a dotted date.
      ['版本：3', '版本：4'],
      ['Updated: 12/10', 'Updated: 14/10'],
      ['Reviewed 3.10.2026 by the controller.', 'Reviewed 9.10.2026 by the controller.'],
    ]) {
      expect(headingFigures(...window(left, right)), left).toEqual([]);
    }
  });
});

describe('measureRelation', (): void => {
  const wiki = page('wiki:escalation.md', 'Escalation paths', ESCALATION, 25);

  it('proposes a later version as the successor of the earlier, by its title or by its front matter', (): void => {
    const v2 = page(
      'guides:escalation-v2.md',
      'Escalation paths, draft v2',
      ESCALATION.replace('# Escalation paths', '# Escalation paths, draft v2'),
      26,
    );
    const proposed = measureRelation(wiki, v2);
    expect(proposed).toMatchObject({
      kind: 'possible_successor',
      from: 'guides:escalation-v2.md',
      to: 'wiki:escalation.md',
    });
    expect(proposed?.evidence.map((entry) => entry.measure)).toEqual([
      'title-version',
      'shared-text',
    ]);
    // The same pair the other way round is the same proposal.
    expect(measureRelation(v2, wiki)).toMatchObject({
      from: 'guides:escalation-v2.md',
      to: 'wiki:escalation.md',
    });
    const named = page(
      'official:pipeline-runbook-v2.md',
      'Refreshing the tile',
      '---\nsupersedes: escalation.md\n---\n# Refreshing the tile\n\nPress refresh.',
    );
    expect(measureRelation(wiki, named)).toMatchObject({
      kind: 'possible_successor',
      from: 'official:pipeline-runbook-v2.md',
      to: 'wiki:escalation.md',
      evidence: [{ measure: 'names-successor', value: 1 }],
    });
  });

  it('proposes two pages that disagree on a figure as a conflict, with the two blocks as its evidence', (): void => {
    const finance = page(
      'finance:escalation.md',
      'Finance escalation',
      '# Finance escalation\n\n## Thresholds\n\nEscalate any variance above 10,000 USD to the finance lead.',
      30,
    );
    const proposed = measureRelation(wiki, finance);
    expect(proposed).toMatchObject({ kind: 'possible_conflict' });
    expect(proposed?.evidence[0]).toMatchObject({ measure: 'heading-figures', value: 1 });
    expect(proposed?.evidence[0].blockRefs).toHaveLength(2);
  });

  it('proposes the same text under another title as a duplicate, the page its source had later second, and never orders a status by it', (): void => {
    const copy = page(
      'personal:escalation-notes.md',
      'My escalation notes',
      ESCALATION.replace('# Escalation paths', '# My escalation notes'),
      40,
    );
    expect(measureRelation(wiki, copy)).toMatchObject({
      kind: 'possible_duplicate',
      from: 'personal:escalation-notes.md',
      to: 'wiki:escalation.md',
      evidence: [{ measure: 'shared-text', value: 100 }],
    });
  });

  // RM19 (a), the operator's remark of 11 October: a copy its source dated a day or more later is
  // proposed as the successor, both dates on the card, and only the manager's answer applies it.
  it('proposes a copy its source edited a day or more later as the successor, with the days between on its evidence', (): void => {
    const day = DATED_SUCCESSOR_GAP_MS;
    const older = page('wiki:escalation.md', 'Escalation paths', ESCALATION, 10 * day);
    const newer = page(
      'handbook:escalation-paths.md',
      'Escalation paths for the close',
      ESCALATION.replace('# Escalation paths', '# Escalation paths for the close'),
      13 * day + 5,
    );
    const proposed = measureRelation(older, newer);
    expect(proposed).toMatchObject({
      kind: 'possible_successor',
      from: 'handbook:escalation-paths.md',
      to: 'wiki:escalation.md',
    });
    expect(proposed?.evidence.map(({ measure, value }) => ({ measure, value }))).toEqual([
      { measure: 'shared-text', value: 100 },
      { measure: 'edit-dates', value: 3 },
    ]);
    // The same pair the other way round is the same proposal.
    expect(measureRelation(newer, older)).toMatchObject({
      kind: 'possible_successor',
      from: 'handbook:escalation-paths.md',
      to: 'wiki:escalation.md',
    });
    // Exactly a day apart is a day.
    expect(measureRelation(older, { ...newer, updatedAt: 11 * day })?.evidence.at(-1)).toEqual({
      measure: 'edit-dates',
      value: 1,
    });
  });

  it('keeps a copy a duplicate when the two were edited under a day apart, or either time is when it was read', (): void => {
    const day = DATED_SUCCESSOR_GAP_MS;
    const older = page('wiki:escalation.md', 'Escalation paths', ESCALATION, 10 * day);
    const copy = (updatedAt: number, edited = true): MeasuredPage =>
      page(
        'links:escalation-notes',
        'My escalation notes',
        ESCALATION.replace('# Escalation paths', '# My escalation notes'),
        updatedAt,
        edited,
      );
    for (const other of [copy(11 * day - 1), copy(20 * day, false)]) {
      expect(measureRelation(older, other)).toMatchObject({
        kind: 'possible_duplicate',
        evidence: [{ measure: 'shared-text', value: 100 }],
      });
    }
    // A page read from a list of URLs carries when it was read, whichever side it is on.
    expect(measureRelation({ ...older, edited: false }, copy(20 * day))?.kind).toBe(
      'possible_duplicate',
    );
  });

  it('dates only a near-identical pair: a conflict stays a conflict, and pages that share little are nothing', (): void => {
    const day = DATED_SUCCESSOR_GAP_MS;
    const wiki = page('wiki:escalation.md', 'Escalation paths', ESCALATION, 1);
    const changed = page(
      'handbook:escalation.md',
      'Close escalation',
      ESCALATION.replace('# Escalation paths', '# Close escalation').replace('5,000', '50,000'),
      30 * day,
    );
    expect(measureRelation(wiki, changed)?.kind).toBe('possible_conflict');
    expect(
      measureRelation(
        wiki,
        page(
          'wiki:holidays.md',
          'Office holidays',
          '# Office holidays\n\nClosed in August.',
          30 * day,
        ),
      ),
    ).toBeUndefined();
  });

  it('proposes nothing for two pages that share little and name no version of each other', (): void => {
    expect(
      measureRelation(
        wiki,
        page('wiki:holidays.md', 'Office holidays', '# Office holidays\n\nClosed in August.'),
      ),
    ).toBeUndefined();
  });
});

describe('relationWords', (): void => {
  it('says each measure as the card says it', (): void => {
    expect(relationWords([{ measure: 'shared-text', value: 78 }])).toBe(
      'share 78 percent of their text',
    );
    expect(relationWords([{ measure: 'title-version', value: 1 }])).toBe(
      'have the same title but for a version',
    );
    expect(
      relationWords([
        { measure: 'title-version', value: 1 },
        { measure: 'shared-text', value: 78 },
      ]),
    ).toBe('have the same title but for a version and share 78 percent of their text');
    expect(relationWords([{ measure: 'heading-figures', value: 1 }], 'Thresholds')).toBe(
      'say different figures under "Thresholds"',
    );
    expect(relationWords([{ measure: 'names-successor', value: 1 }])).toBe(
      'one names the other as the page it replaces',
    );
  });
});
