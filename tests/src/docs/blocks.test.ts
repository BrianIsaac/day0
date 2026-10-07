import { describe, expect, it } from 'vitest';
import {
  BLOCK_WINDOW_CHARS,
  MAX_BLOCKS_PER_PAGE,
  SEARCH_TERM_LIMIT,
  blockSearchQuery,
  cjkBigrams,
  searchTerms,
  searchTextOf,
  splitPage,
} from '../../../src/docs/blocks';
import { sha256OfText } from '../../../src/lib/sha256';

/** A paragraph of `words` distinct words, each five characters, one space between. */
function paragraph(prefix: string, words: number): string {
  return Array.from(
    { length: words },
    (_unused, index) => `${prefix}${String(index).padStart(4, '0')}`,
  ).join(' ');
}

describe('splitPage', (): void => {
  it('splits at headings and records the heading path of each block', (): void => {
    const blocks = splitPage(
      [
        'Read this first.',
        '',
        '# Refreshing the tile',
        '',
        'Open the dashboard.',
        '',
        '## When it is stale',
        '',
        'Press Refresh twice.',
        '',
        '# Posting the result',
        '',
        'Post in the channel.',
      ].join('\n'),
    );
    expect(blocks.map((block) => [block.headingPath, block.text])).toEqual([
      [[], 'Read this first.'],
      [['Refreshing the tile'], 'Open the dashboard.'],
      [['Refreshing the tile', 'When it is stale'], 'Press Refresh twice.'],
      [['Posting the result'], 'Post in the channel.'],
    ]);
    expect(blocks.map((block) => block.index)).toEqual([0, 1, 2, 3]);
    expect(blocks.every((block) => block.kind === 'text')).toBe(true);
  });

  it('packs the paragraphs of one section together up to the window', (): void => {
    const blocks = splitPage(['# One', '', 'First paragraph.', '', 'Second paragraph.'].join('\n'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('cuts a long section into windows on paragraph boundaries', (): void => {
    // Each paragraph is 120 words: 719 characters, so no two fit one window.
    const paragraphs = ['a', 'b', 'c', 'd'].map((prefix) => paragraph(prefix, 120));
    const blocks = splitPage(
      ['# Long', '', ...paragraphs.flatMap((text) => [text, ''])].join('\n'),
    );
    expect(blocks.map((block) => block.text)).toEqual(paragraphs);
    expect(blocks.every((block) => block.chars <= BLOCK_WINDOW_CHARS)).toBe(true);
    expect(blocks.every((block) => block.headingPath[0] === 'Long')).toBe(true);
  });

  it('cuts a paragraph longer than the window at word boundaries, losing no word', (): void => {
    const long = paragraph('w', 400);
    const blocks = splitPage(long);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.every((block) => block.chars <= BLOCK_WINDOW_CHARS)).toBe(true);
    expect(blocks.map((block) => block.text).join(' ')).toBe(long);
  });

  it('keeps a table as one block of kind table', (): void => {
    const table = [
      '| Step | Who |',
      '| --- | --- |',
      '| Refresh | RevOps |',
      '| Post | Finance |',
    ].join('\n');
    const blocks = splitPage(
      ['# Owners', '', 'Who does what:', '', table, '', 'Ask if unsure.'].join('\n'),
    );
    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ['text', 'Who does what:'],
      ['table', table],
      ['text', 'Ask if unsure.'],
    ]);
  });

  it('keeps a fenced code block whole, blank lines and hashes included, as kind code', (): void => {
    const code = ['```sh', '# not a heading', '', 'pnpm refresh --tile pipeline', '```'].join('\n');
    const blocks = splitPage(['# Run it', '', code, '', 'Then check.'].join('\n'));
    expect(blocks.map((block) => [block.kind, block.headingPath, block.text])).toEqual([
      ['code', ['Run it'], code],
      ['text', ['Run it'], 'Then check.'],
    ]);
  });

  it('keeps a list, loose or tight, as one block of kind list', (): void => {
    const list = [
      '1. Open the tile.',
      '   Wait for it to load.',
      '',
      '2. Press Refresh.',
      '- Then post.',
    ].join('\n');
    const blocks = splitPage(['# Steps', '', list, '', 'Done.'].join('\n'));
    expect(blocks.map((block) => [block.kind, block.text])).toEqual([
      ['list', list],
      ['text', 'Done.'],
    ]);
  });

  it('splits a page with no Latin character and writes its bigrams for search', (): void => {
    const blocks = splitPage(
      [
        '# 刷新看板',
        '',
        '每个季度结束时请刷新管道看板。',
        '',
        '## 发布',
        '',
        '在频道里发布结果。',
      ].join('\n'),
    );
    expect(blocks.map((block) => [block.headingPath, block.text])).toEqual([
      [['刷新看板'], '每个季度结束时请刷新管道看板。'],
      [['刷新看板', '发布'], '在频道里发布结果。'],
    ]);
    expect(blocks[0].chars).toBe(15);
    expect(blocks[0].searchText).toContain('管道 道看 看板');
    expect(blocks[1].searchText).toContain('频道');
  });

  it('gives each block the hash of its heading path, kind and text', (): void => {
    const [block] = splitPage('# Tile\n\nRefresh it.');
    expect(block.hash).toBe(sha256OfText(JSON.stringify([['Tile'], 'text', 'Refresh it.'])));
    expect(splitPage('# Tile\n\nRefresh it.')[0].hash).toBe(block.hash);
    expect(splitPage('# Tile\n\nRefresh it now.')[0].hash).not.toBe(block.hash);
  });

  it('answers no block for an empty page or one of headings only', (): void => {
    expect(splitPage('')).toEqual([]);
    expect(splitPage('# Only\n\n## Headings\n')).toEqual([]);
  });

  it('falls back to windows across headings when the page would pass the block bound', (): void => {
    const markdown = Array.from(
      { length: MAX_BLOCKS_PER_PAGE + 10 },
      (_unused, index) => `# H${index}\n\nline ${index}`,
    ).join('\n\n');
    const blocks = splitPage(markdown);
    expect(blocks.length).toBeLessThanOrEqual(MAX_BLOCKS_PER_PAGE);
    expect(blocks.every((block) => block.chars <= BLOCK_WINDOW_CHARS)).toBe(true);
    expect(blocks.map((block) => block.text).join('\n\n')).toContain(
      `line ${MAX_BLOCKS_PER_PAGE + 9}`,
    );
  });

  it('splits the largest page Day0 stores, one line or many headings, within the bound', (): void => {
    const oneLine = paragraph('x', (768 * 1024) / 6);
    const headings = Array.from(
      { length: 40_000 },
      (_unused, index) => `## ${index}\n\n- item`,
    ).join('\n\n');
    for (const markdown of [oneLine, headings]) {
      const blocks = splitPage(markdown);
      expect(blocks.length).toBeLessThanOrEqual(MAX_BLOCKS_PER_PAGE);
      expect(blocks.every((block) => block.chars <= BLOCK_WINDOW_CHARS)).toBe(true);
    }
  });

  it('counts characters, not UTF-16 units', (): void => {
    expect(splitPage('Ship it 🚢')[0].chars).toBe(9);
  });
});

describe('searchTerms (the CJK-aware tokeniser)', (): void => {
  it('splits Latin text on anything not a letter or a digit, in lower case', (): void => {
    expect(searchTerms('Refresh the Pipeline-tile, then post_it (v2).')).toEqual([
      'refresh',
      'the',
      'pipeline',
      'tile',
      'then',
      'post',
      'it',
      'v2',
    ]);
  });

  it('writes every run of Chinese, Japanese or Korean characters as overlapping bigrams', (): void => {
    expect(searchTerms('刷新管道看板')).toEqual(['刷新', '新管', '管道', '道看', '看板']);
    expect(searchTerms('カタカナ')).toEqual(['カタ', 'タカ', 'カナ']);
    expect(searchTerms('한국어')).toEqual(['한국', '국어']);
    expect(searchTerms('看')).toEqual(['看']);
    expect(searchTerms('refresh 看板 now')).toEqual(['refresh', '看板', 'now']);
    expect(searchTerms('请在Slack里发布')).toEqual(['请在', 'slack', '里发', '发布']);
  });

  it('drops a term the index would not keep (32 UTF-8 bytes or more)', (): void => {
    expect(searchTerms(`${'a'.repeat(31)} ${'b'.repeat(32)} ok`)).toEqual(['a'.repeat(31), 'ok']);
  });

  it('cjkBigrams answers the run itself when it is one character', (): void => {
    expect(cjkBigrams('看')).toEqual(['看']);
    expect(cjkBigrams('看板')).toEqual(['看板']);
  });
});

describe('searchTextOf', (): void => {
  it('carries the heading path, the text and the bigrams of every CJK run', (): void => {
    expect(searchTextOf(['刷新看板'], '请刷新管道看板')).toBe(
      '刷新看板\n请刷新管道看板\n刷新 新看 看板 请刷 刷新 新管 管道 道看 看板',
    );
    expect(searchTextOf(['Tile'], 'Refresh it.')).toBe('Tile\nRefresh it.');
  });

  it('writes a Latin word set against a CJK run as a term of its own', (): void => {
    expect(searchTextOf([], '请在Slack里发布')).toBe('请在Slack里发布\n请在 slack 里发 发布');
  });
});

describe('blockSearchQuery', (): void => {
  it('keeps the first sixteen distinct terms, since the backend silently drops the rest', (): void => {
    const words = Array.from({ length: 40 }, (_unused, index) => `w${index}`);
    const query = blockSearchQuery([...words, 'w0', 'w1'].join(' '));
    expect(query.split(' ')).toEqual(words.slice(0, SEARCH_TERM_LIMIT));
  });

  it('spends one term per bigram of a Chinese query', (): void => {
    expect(blockSearchQuery('刷新管道看板 refresh')).toBe('刷新 新管 管道 道看 看板 refresh');
  });

  it('answers an empty query for text with no term', (): void => {
    expect(blockSearchQuery('  -- !! ')).toBe('');
  });
});
