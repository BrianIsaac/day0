import { describe, expect, it } from 'vitest';
import {
  MARKER_EXCERPT_CHARS,
  MARKER_JUDGEMENT_INSTRUCTIONS,
  decidePageStatus,
  fileNativeStatus,
  frontMatterStatus,
  judgedMarkerStatus,
  markerCandidate,
  markerJudgementPrompt,
  markerJudgementSchema,
  MARKER_VOCABULARY,
  markerInForce,
  markerStands,
  markerToJudge,
  markerWordStatus,
  unmarkedTop,
  nativeStatusOfWord,
  notCurrentWord,
  pathStatus,
  withoutFrontMatter,
} from '../../../src/docs/status';

describe('a source’s own word for a page', (): void => {
  it('normalises a provider’s word to one of the four statuses, and an unknown word to none', (): void => {
    expect(nativeStatusOfWord('Archived')).toBe('archived');
    expect(nativeStatusOfWord('in_trash')).toBe('archived');
    expect(nativeStatusOfWord('trashed')).toBe('archived');
    expect(nativeStatusOfWord(' DRAFT ')).toBe('draft');
    expect(nativeStatusOfWord('deprecated')).toBe('superseded');
    expect(nativeStatusOfWord('current')).toBe('active');
    expect(nativeStatusOfWord('已归档')).toBe('archived');
    expect(nativeStatusOfWord('草稿')).toBe('draft');
    expect(nativeStatusOfWord('已废止')).toBe('superseded');
    expect(nativeStatusOfWord('reviewed')).toBeUndefined();
    expect(nativeStatusOfWord('')).toBeUndefined();
  });
});

describe('what a provider says of a page it no longer serves as current', (): void => {
  it('is its word when that is not current, and nothing for an ordinary page', (): void => {
    expect(notCurrentWord('archived')).toBe('archived');
    expect(notCurrentWord('trashed')).toBe('archived');
    expect(notCurrentWord('draft')).toBe('draft');
    // A provider calls every ordinary page current: saying so of each would stand over a marker
    // and a confirmed relation, which only an author's explicit word should.
    expect(notCurrentWord('current')).toBeUndefined();
    expect(notCurrentWord('unknown-word')).toBeUndefined();
    expect(notCurrentWord(undefined)).toBeUndefined();
    expect(notCurrentWord(42)).toBeUndefined();
  });
});

describe('front matter', (): void => {
  it('reads a status and the pages a page supersedes, and leaves the body', (): void => {
    const page = [
      '---',
      'title: Pipeline runbook, version 2',
      'status: active',
      'supersedes: pipeline-runbook',
      '---',
      '# Pipeline runbook, version 2',
      '',
      'Refresh the tile twice.',
    ].join('\n');
    expect(frontMatterStatus(page)).toEqual({
      status: 'active',
      supersedes: ['pipeline-runbook'],
      supersededBy: [],
    });
    expect(withoutFrontMatter(page)).toBe(
      '# Pipeline runbook, version 2\n\nRefresh the tile twice.',
    );
  });

  it('reads quoted values, lists, flags and the key in either spelling', (): void => {
    expect(
      frontMatterStatus(
        [
          '---',
          'Status: "Deprecated"  ',
          'superseded-by: [runbooks/v2.md, "Runbook v3"]',
          '---',
        ].join('\n'),
      ),
    ).toEqual({
      status: 'superseded',
      supersedes: [],
      supersededBy: ['runbooks/v2.md', 'Runbook v3'],
    });
    expect(
      frontMatterStatus(
        ['---', 'draft: true', 'supersedes:', '  - old-a.md', '  - old-b.md', '---'].join('\n'),
      ),
    ).toEqual({ status: 'draft', supersedes: ['old-a.md', 'old-b.md'], supersededBy: [] });
    expect(frontMatterStatus('---\narchived: true\n---\n# Old').status).toBe('archived');
    expect(frontMatterStatus('---\ndraft: false\n---\n# Live').status).toBeUndefined();
  });

  it('states nothing for a word it does not know, a page with no block, or a page that opens with a rule', (): void => {
    expect(frontMatterStatus('---\nstatus: reviewed\n---\n# Page')).toEqual({
      supersedes: [],
      supersededBy: [],
    });
    expect(frontMatterStatus('# Page\n\nstatus: archived')).toEqual({
      supersedes: [],
      supersededBy: [],
    });
    const ruled = '---\n# Notes\n\nThe status: archived line below a rule is prose.\n---\nMore.';
    expect(frontMatterStatus(ruled).status).toBeUndefined();
    expect(withoutFrontMatter(ruled)).toBe(ruled);
    expect(frontMatterStatus('---\nstatus: draft\n# never closed').status).toBeUndefined();
  });
});

describe('a path', (): void => {
  it('files a page under archive, old or drafts as archived or a draft, at any depth', (): void => {
    expect(pathStatus('archive/2024/close.md')).toBe('archived');
    expect(pathStatus('runbooks/old/refresh.md')).toBe('archived');
    expect(pathStatus('Archived/refresh.md')).toBe('archived');
    expect(pathStatus('drafts/refresh-v2.md')).toBe('draft');
    expect(pathStatus('https://wiki.acme.test/handbook/drafts/refresh?from=archive/')).toBe(
      'draft',
    );
  });

  it('reads the directories only, never the page’s own name or a look-alike directory', (): void => {
    expect(pathStatus('runbooks/archive.md')).toBeUndefined();
    expect(pathStatus('old-runbooks/refresh.md')).toBeUndefined();
    expect(pathStatus('bold/drafting/refresh.md')).toBeUndefined();
    expect(pathStatus('refresh.md')).toBeUndefined();
  });

  it('gives a file its front matter’s status before its directory’s', (): void => {
    expect(fileNativeStatus('drafts/refresh.md', '---\nstatus: active\n---\n# Refresh')).toBe(
      'active',
    );
    expect(fileNativeStatus('drafts/refresh.md', '# Refresh')).toBe('draft');
    expect(fileNativeStatus('runbooks/refresh.md', '# Refresh')).toBeUndefined();
  });
});

describe('the marker pre-filter', (): void => {
  it('finds a marker word in the title or the first 300 characters, in English and Chinese, with its lines', (): void => {
    expect(markerCandidate('Close checklist (DEPRECATED)', '# Close checklist\n\nSteps.')).toEqual({
      excerpt: 'Close checklist (DEPRECATED)\n# Close checklist\n\nSteps.',
      quote: 'Close checklist (DEPRECATED)',
    });
    expect(
      markerCandidate(
        '月结流程',
        '# 月结流程\n\n本文件已废止,请参阅《月结流程(2026版)》。\n\n步骤如下。',
      ),
    ).toEqual({
      excerpt: '月结流程\n# 月结流程\n\n本文件已废止,请参阅《月结流程(2026版)》。\n\n步骤如下。',
      quote: '本文件已废止,请参阅《月结流程(2026版)》。',
    });
    expect(markerCandidate('Onboarding', '> 草稿:尚未批准\n\n# Onboarding')?.quote).toBe(
      '> 草稿:尚未批准',
    );
  });

  it('finds no marker past the first 300 characters, in front matter, or inside another word', (): void => {
    const late = `# Refresh\n\n${'Press refresh. '.repeat(30)}\n\nDEPRECATED`;
    expect(late.indexOf('DEPRECATED')).toBeGreaterThan(MARKER_EXCERPT_CHARS);
    expect(markerCandidate('Refresh', late)).toBeUndefined();
    expect(
      markerCandidate('Refresh', '---\nstatus: draft\n---\n# Refresh\n\nPress refresh.'),
    ).toBeUndefined();
    expect(
      markerCandidate('Drafting a reply', '# Drafting a reply\n\nRedrafted weekly.'),
    ).toBeUndefined();
  });

  it('hits on a page that only writes about archiving, which is why a hit alone decides nothing', (): void => {
    const candidate = markerCandidate(
      'How to archive a ticket',
      '# How to archive a ticket\n\nAn archived ticket leaves the board.',
    );
    expect(candidate?.quote).toBe('An archived ticket leaves the board.');
  });
});

describe('the marker judgement', (): void => {
  const candidate = markerCandidate(
    '月结流程',
    '# 月结流程\n\n本文件已废止,请参阅《月结流程(2026版)》。',
  )!;

  it('asks about the page’s top alone and takes a status and a quote back', (): void => {
    expect(markerJudgementPrompt(candidate)).toContain(candidate.excerpt);
    expect(MARKER_JUDGEMENT_INSTRUCTIONS).toContain('已废止');
    expect(MARKER_JUDGEMENT_INSTRUCTIONS).toContain('describes its subject, not the page');
    expect(markerJudgementSchema.parse({ status: 'superseded', quote: '本文件已废止' })).toEqual({
      status: 'superseded',
      quote: '本文件已废止',
    });
    expect(markerJudgementSchema.safeParse({ status: 'gone', quote: '' }).success).toBe(false);
  });

  it('takes the model’s status when its quote is words the page holds, in Chinese as in English', (): void => {
    expect(judgedMarkerStatus({ status: 'superseded', quote: '本文件已废止' }, candidate)).toBe(
      'superseded',
    );
    const english = markerCandidate('Close checklist', 'DRAFT   for comment\n\n# Close checklist')!;
    expect(judgedMarkerStatus({ status: 'draft', quote: 'DRAFT for comment' }, english)).toBe(
      'draft',
    );
  });

  it('decides nothing on a quote the page does not hold, an empty quote, or an active reply', (): void => {
    expect(
      judgedMarkerStatus({ status: 'superseded', quote: 'this page is obsolete' }, candidate),
    ).toBe('active');
    expect(judgedMarkerStatus({ status: 'archived', quote: '  ' }, candidate)).toBe('active');
    expect(judgedMarkerStatus({ status: 'active', quote: '本文件已废止' }, candidate)).toBe(
      'active',
    );
  });

  it('stands for a page while its marker lines are the ones judged, and not once they change', (): void => {
    const marker = { status: 'superseded' as const, quote: candidate.quote };
    expect(markerStands(marker, candidate)).toBe(true);
    const edited = markerCandidate(
      '月结流程',
      '# 月结流程\n\n本文件已废止,请参阅《月结流程(2027版)》。',
    );
    expect(markerStands(marker, edited)).toBe(false);
    expect(markerStands(marker, undefined)).toBe(false);
    expect(markerStands(undefined, candidate)).toBe(false);
  });

  it('keeps the last judgement in force while the page holds any marker line, and none once it holds none', (): void => {
    // The second pass's minor 10: an edit to a marker line dropped the judgement at once, so the
    // page was current again until the model answered, and for good while it could not.
    const marker = { status: 'superseded' as const, quote: candidate.quote };
    const edited = markerCandidate(
      '月结流程',
      '# 月结流程\n\n本文件已废止,请参阅《月结流程(2027版)》。',
    );
    expect(markerInForce(marker, candidate)).toBe(marker);
    expect(markerInForce(marker, edited)).toBe(marker);
    // Re-pinned for D-1 (c) (W15-R27): a judgement that the page is not current holds once its
    // line is gone too, until the model reads the page again; it used to end at once.
    expect(markerInForce(marker, undefined)).toBe(marker);
    expect(markerInForce(undefined, candidate)).toBeUndefined();
  });
});

describe('a marker judgement held to a changed page (D-1 (c); W15-R27)', (): void => {
  const TITLE = 'Pipeline runbook';
  const DEPRECATED = 'DEPRECATED: use the v2 runbook instead.\n\nSteps...';
  const judged = {
    status: 'superseded' as const,
    quote: markerCandidate(TITLE, DEPRECATED)!.quote,
  };

  it('keeps a page not current while its notice is reworded with a vocabulary word, and asks the model again', (): void => {
    // The review's first input: the page is corrected, and stays out until the model reads it.
    const corrected = 'No longer deprecated: this runbook is current again.\n\nSteps...';
    expect(markerInForce(judged, markerCandidate(TITLE, corrected))).toBe(judged);
    expect(markerToJudge(judged, TITLE, corrected)).toEqual(markerCandidate(TITLE, corrected));
  });

  it('keeps a page not current when its notice is reworded with no vocabulary word, and puts its top to the model', (): void => {
    // The second input: this made the page current at once, with no model asked.
    const reworded = 'This runbook has been replaced with the v2 runbook.\n\nSteps...';
    expect(markerCandidate(TITLE, reworded)).toBeUndefined();
    expect(markerInForce(judged, undefined)).toBe(judged);
    const asked = markerToJudge(judged, TITLE, reworded);
    expect(asked).toEqual(unmarkedTop(TITLE, reworded));
    expect(asked?.excerpt).toBe(`${TITLE}\n${reworded}`);
    // Judged of that top, it is not asked again until the top changes.
    const answered = { status: 'superseded' as const, quote: asked!.quote };
    expect(markerToJudge(answered, TITLE, reworded)).toBeUndefined();
    expect(markerToJudge(answered, TITLE, `${reworded}\n\nMore.`)).toBeDefined();
  });

  it('holds a page judged current out, by the word its top gains, until the model answers', (): void => {
    // The third input: a page about archiving tickets, judged current, gains an ARCHIVED line.
    const about = 'An archived ticket leaves the board.\n\nSteps...';
    const current = {
      status: 'active' as const,
      quote: markerCandidate('How to archive a ticket', about)!.quote,
    };
    const gained = markerCandidate(
      'How to archive a ticket',
      `ARCHIVED: kept for the record only.\n\n${about}`,
    );
    expect(markerInForce(current, gained)).toEqual({ status: 'archived' });
    // A new word in a line already judged counts too, and says which status it would be.
    const drafted = markerCandidate(
      'How to archive a ticket',
      'DRAFT. An archived ticket leaves the board.\n\nSteps...',
    );
    expect(markerInForce(current, drafted)).toEqual({ status: 'draft' });
    const deprecated = markerCandidate('How to archive a ticket', `本文件已废止。\n\n${about}`);
    expect(markerInForce(current, deprecated)).toEqual({ status: 'superseded' });
  });

  it('leaves a page judged current as it is when a judged line is only edited, or its lines are fewer', (): void => {
    const about = 'An archived ticket leaves the board.\n\nSteps...';
    const current = {
      status: 'active' as const,
      quote: markerCandidate('How to archive a ticket', about)!.quote,
    };
    const typo = markerCandidate(
      'How to archive a ticket',
      'An archived ticket leaves the board at once.\n\nSteps...',
    );
    expect(markerInForce(current, typo)).toBe(current);
    expect(
      decidePageStatus({ marker: markerInForce(current, typo), defaultStatus: 'active' }),
    ).toEqual({ status: 'active', statusSource: 'default' });
    expect(markerInForce(current, undefined)).toBe(current);
    // Either way the edited page is put to the model again.
    expect(
      markerToJudge(
        current,
        'How to archive a ticket',
        'An archived ticket leaves the board at once.',
      ),
    ).toBeDefined();
  });

  it('never puts a page to the model that was never judged not current and holds no vocabulary word', (): void => {
    expect(markerToJudge(undefined, TITLE, 'Steps to refresh the tile.')).toBeUndefined();
    expect(
      markerToJudge({ status: 'active', quote: 'x' }, TITLE, 'Steps to refresh the tile.'),
    ).toBeUndefined();
  });

  it('gives every vocabulary word the status it would mean', (): void => {
    expect(MARKER_VOCABULARY).toHaveLength(36);
    for (const word of MARKER_VOCABULARY) {
      expect(['superseded', 'archived', 'draft'], word).toContain(markerWordStatus(word));
    }
    expect(markerWordStatus('retired')).toBe('archived');
    expect(markerWordStatus('征求意见稿')).toBe('draft');
    expect(markerWordStatus('do not use')).toBe('superseded');
  });
});

describe('the status rules', (): void => {
  const everything = {
    manager: 'draft',
    nativeStatus: 'archived',
    marker: { status: 'superseded' },
    superseded: true,
    defaultStatus: 'active',
  } as const;

  it('reads the manager first, then the source, a judged marker, a confirmed relation, the default', (): void => {
    expect(decidePageStatus(everything)).toEqual({ status: 'draft', statusSource: 'manager' });
    expect(decidePageStatus({ ...everything, manager: undefined })).toEqual({
      status: 'archived',
      statusSource: 'source-native',
    });
    expect(
      decidePageStatus({ marker: { status: 'draft' }, superseded: true, defaultStatus: 'active' }),
    ).toEqual({
      status: 'draft',
      statusSource: 'marker',
    });
    expect(decidePageStatus({ superseded: true, defaultStatus: 'active' })).toEqual({
      status: 'superseded',
      statusSource: 'relation',
    });
    expect(decidePageStatus({ defaultStatus: 'draft' })).toEqual({
      status: 'draft',
      statusSource: 'default',
    });
  });

  it('lets the source’s explicit word stand over a marker and a relation, active included', (): void => {
    expect(
      decidePageStatus({
        nativeStatus: 'active',
        marker: { status: 'superseded' },
        superseded: true,
        defaultStatus: 'draft',
      }),
    ).toEqual({ status: 'active', statusSource: 'source-native' });
  });

  it('reads a marker judged active as no marker', (): void => {
    expect(decidePageStatus({ marker: { status: 'active' }, defaultStatus: 'active' })).toEqual({
      status: 'active',
      statusSource: 'default',
    });
    expect(
      decidePageStatus({ marker: { status: 'active' }, superseded: true, defaultStatus: 'active' }),
    ).toEqual({ status: 'superseded', statusSource: 'relation' });
  });

  it('takes no time as an input, so recency alone never changes a status', (): void => {
    // The inputs' type holds no edit time: two pages that differ only in when they were edited
    // are the same input, and so the same status.
    const older = decidePageStatus({ defaultStatus: 'active' });
    const newer = decidePageStatus({ defaultStatus: 'active' });
    expect(newer).toEqual(older);
    expect(decidePageStatus.length).toBe(1);
  });
});
