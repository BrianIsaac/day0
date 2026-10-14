import type { RelationKind } from './authority';
import { SHARED_TEXT_DUPLICATE, type RelationMeasure } from './relation-words';
import { frontMatterStatus } from './status';

export {
  RELATION_MEASURES,
  SHARED_TEXT_DUPLICATE,
  relationWords,
  type RelationMeasure,
} from './relation-words';

/*
 * How two pages may relate (wave 15, 15-A; the wave file's section 6.2; K-9): the measures that
 * propose a relation between two stored pages, each a `proposed` row the manager confirms or
 * dismisses on a card. Nothing here decides anything: no relation is confirmed, and no page
 * merged, by code. Pure, over the pages' titles, front matter and stored blocks.
 */

/**
 * The most new proposals one source's finishing sync writes. The measuring stops there, and what
 * it had left to measure is kept on the source (`docSources.relationsOwed`) for the next sync's.
 */
export const RELATION_PROPOSALS_PER_SYNC = 50;

/**
 * How many pages one step of a finishing sync's measuring takes before it hands on to the next
 * step, which goes on from there until every page the sync has to measure was (W15-R5): a step
 * finishes the read of blocks it is in, so it may take a few more.
 */
export const RELATION_PAGES_PER_STEP = 100;

/**
 * How many times a page whose measure threw is tried before the measuring passes it over (wave 17,
 * 17-FD; W16-R34): a measure out of retries on a busy row passes at a later step, and one over a
 * read limit never does, so it is logged as not measured and the measuring goes on without it.
 */
export const RELATION_MEASURE_TRIES = 3;

/**
 * How long the measuring waits before it tries a page again: long enough for the writes a sync's
 * end makes to its source's row (discovery, the people extraction) to have landed.
 */
export const RELATION_MEASURE_RETRY_MS = 5_000;

/** The most other pages one page is measured against: the best of what its title and headings find. */
export const RELATION_CANDIDATES_PER_PAGE = 3;

/**
 * How far apart two copies' edit times in their sources must be for the later to be proposed as
 * the successor of the earlier (wave 16, 16-FD; RM19 (a)): a day, so two copies saved in one
 * sitting stay a duplicate.
 */
export const DATED_SUCCESSOR_GAP_MS = 24 * 60 * 60 * 1000;

/** The most block hashes one measure of a proposal keeps, so a relation row stays small. */
export const RELATION_EVIDENCE_BLOCKS = 8;

/** A stored block as the measures read it. */
export interface MeasuredBlock {
  /** The row's hash (`docBlocks.hash`), which a proposal's evidence keeps. */
  readonly hash: string;
  readonly headingPath: readonly string[];
  readonly text: string;
}

/** A stored page as the measures read it. */
export interface MeasuredPage {
  /** Unique across the owner's pages: its source and ref. */
  readonly key: string;
  readonly ref: string;
  readonly title: string;
  /** The page's Markdown as stored, for its front matter. */
  readonly markdown: string;
  readonly blocks: readonly MeasuredBlock[];
  /** When the source last had the page: orders a pair nothing else orders. */
  readonly updatedAt: number;
  /**
   * Whether `updatedAt` is when the source says the page was edited, rather than when its reader
   * read it: what the page's row says, and for a row that does not say, its source's kind (a
   * list of URLs, an MCP server, a git checkout). Only an edit time dates a successor (RM19 (a),
   * D-8 (a)).
   */
  readonly edited: boolean;
}

/** One measure's finding, as a relation row keeps it. */
export interface RelationEvidence {
  readonly measure: RelationMeasure;
  readonly value: number;
  /** The hashes of the blocks the measure read, on the two pages. */
  readonly blockRefs?: string[];
}

/** A relation the measures propose between two pages. */
export interface ProposedRelation {
  readonly kind: RelationKind;
  /** For a successor, the later version; otherwise the page the card names second. */
  readonly from: string;
  /** For a successor, the page it would supersede. */
  readonly to: string;
  readonly evidence: readonly RelationEvidence[];
}

/** Text as the shared-text measure compares it: case and white space set aside. */
function comparable(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The share of two pages' text they hold in common, as a whole percent: the characters of the
 * blocks whose text both hold, over the characters either holds. A block's heading is not part
 * of it, so a copy under another title still shares its text.
 *
 * @returns The percent, and the hashes of the shared blocks on both pages (the first page's
 *   first), at most `RELATION_EVIDENCE_BLOCKS`.
 */
export function sharedText(
  left: Pick<MeasuredPage, 'blocks'>,
  right: Pick<MeasuredPage, 'blocks'>,
): { share: number; blockRefs: string[] } {
  const unmatched = new Map<string, MeasuredBlock[]>();
  for (const block of right.blocks) {
    const text = comparable(block.text);
    unmatched.set(text, [...(unmatched.get(text) ?? []), block]);
  }
  let shared = 0;
  const blockRefs: string[] = [];
  for (const block of left.blocks) {
    const twin = unmatched.get(comparable(block.text))?.shift();
    if (twin === undefined) continue;
    shared += block.text.length;
    if (blockRefs.length + 2 <= RELATION_EVIDENCE_BLOCKS) blockRefs.push(block.hash, twin.hash);
  }
  const chars = (page: Pick<MeasuredPage, 'blocks'>): number =>
    page.blocks.reduce((total, block) => total + block.text.length, 0);
  const either = chars(left) + chars(right) - shared;
  return { share: either === 0 ? 0 : Math.round((100 * shared) / either), blockRefs };
}

/** A version, year or draft word in a title, and what each says of the page's place in a series. */
const VERSION_TOKENS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly rank: (match: RegExpExecArray) => number;
}> = [
  // "v2", "version 2.1", "V3": the number orders the series.
  {
    pattern: /\bv(?:ersion)?\s*(\d+(?:\.\d+)*)\b/gi,
    rank: (match) => 10 * Number(match[1].split('.')[0]) + Number(match[1].split('.')[1] ?? 0) / 10,
  },
  { pattern: /第\s*(\d+)\s*版/g, rank: (match) => 10 * Number(match[1]) },
  { pattern: /(\d{4})\s*年?版/g, rank: (match) => Number(match[1]) },
  // A year alone: "Close checklist 2026".
  { pattern: /\b((?:19|20)\d{2})\b/g, rank: (match) => Number(match[1]) },
  // Words for the newer of two.
  { pattern: /\b(?:draft|new|updated|revised|proposed)\b/gi, rank: () => 1_000_000 },
  { pattern: /新版|修订版|草稿|草案/g, rank: () => 1_000_000 },
  // Words for the older of two.
  { pattern: /\b(?:old|legacy|deprecated|obsolete|archived|previous)\b/gi, rank: () => -1_000_000 },
  { pattern: /旧版|已废止|已作废|已归档/g, rank: () => -1_000_000 },
];

/** A title with its version words taken out, and where they place it in its series. */
function titleSeries(title: string): { stem: string; rank: number | undefined } {
  let stem = title;
  let rank: number | undefined;
  for (const token of VERSION_TOKENS) {
    for (const match of title.matchAll(token.pattern)) {
      rank = (rank ?? 0) + token.rank(match);
    }
    stem = stem.replace(token.pattern, ' ');
  }
  return {
    stem: stem
      .replace(/[\s\p{P}\p{S}]+/gu, ' ')
      .trim()
      .toLowerCase(),
    rank,
  };
}

/**
 * Which of two titles is the later of one series: one title but for a version, a year or a draft
 * word, as "Escalation paths" and "Escalation paths, draft v2" are.
 *
 * @returns The later side, or undefined when the titles are not one series, or their version
 *   words say the same (two pages with one title say nothing of versions).
 */
export function titleVersion(left: string, right: string): 'left' | 'right' | undefined {
  const [a, b] = [titleSeries(left), titleSeries(right)];
  if (a.stem === '' || a.stem !== b.stem) return undefined;
  const [rankA, rankB] = [a.rank ?? 0, b.rank ?? 0];
  if (rankA === rankB) return undefined;
  return rankA > rankB ? 'left' : 'right';
}

/** A page's name as another page's front matter may write it: lower case, no `.md`, no path. */
function pageNames(page: Pick<MeasuredPage, 'ref' | 'title'>): Set<string> {
  const ref = page.ref.toLowerCase();
  const file = ref.split('/').pop() ?? ref;
  return new Set(
    [ref, ref.replace(/\.mdx?$/, ''), file, file.replace(/\.mdx?$/, ''), page.title.toLowerCase()]
      .map((name) => name.trim())
      .filter((name) => name !== ''),
  );
}

/**
 * Which of two pages the other's front matter names as its successor: a page whose
 * `supersedes:` names the other is the later, as is the page the other's `superseded_by:` names.
 * A page is named by its ref, its file name (with or without `.md`) or its title.
 */
export function namedSuccessor(
  left: Pick<MeasuredPage, 'ref' | 'title' | 'markdown'>,
  right: Pick<MeasuredPage, 'ref' | 'title' | 'markdown'>,
): 'left' | 'right' | undefined {
  const names = (
    page: Pick<MeasuredPage, 'markdown'>,
    other: Pick<MeasuredPage, 'ref' | 'title'>,
    key: 'supersedes' | 'supersededBy',
  ): boolean => {
    const known = pageNames(other);
    return frontMatterStatus(page.markdown)[key].some((name) => known.has(name.toLowerCase()));
  };
  if (names(left, right, 'supersedes') || names(right, left, 'supersededBy')) return 'left';
  if (names(right, left, 'supersedes') || names(left, right, 'supersededBy')) return 'right';
  return undefined;
}

/**
 * The kinds of source whose reader gives no edit time: a page's time is when it was read (a list
 * of URLs, an MCP server), or when a fresh checkout wrote its file (git), so it dates no successor
 * and its card says "last read". The rule for a page stored before 0.21.0, whose row does not say
 * which its time is ({@link editedAtSource}).
 */
export const KINDS_WITHOUT_EDIT_TIME: ReadonlySet<string> = new Set(['urls', 'mcp', 'git']);

/**
 * Whether a stored page's time is when its source says it was edited (wave 17, 17-FD; D-8 (a)):
 * what its row says (`datedBySource`, the reader's own word, false where it fell back to the time
 * it read the page; a folder's file time counts as its source's, X-3), and for a row that does
 * not say, the rule by its source's kind. Only an edit time dates a successor, and a card says
 * "edited" of nothing else.
 *
 * @param page - The stored page's word on its time, if it holds one.
 * @param source - Its source's kind.
 */
export function editedAtSource(
  page: { readonly datedBySource?: boolean },
  source: { readonly kind: string },
): boolean {
  return page.datedBySource ?? !KINDS_WITHOUT_EDIT_TIME.has(source.kind);
}

/** A figure in a line: a number with its separators, as written. */
const FIGURE = /\d+(?:[.,:]\d+)*/g;

/** A date written out in figures alone: ISO, or with slashes. */
const FIGURE_DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/;

/** A month by its English name, but for May, which is also a verb and is read by its capital. */
const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/**
 * A date that only a date word beside it makes one: a day beside a month's name, a month's name
 * beside a figure, a year, a day and month in figures, or 年月日.
 */
const WORDED_DATE = new RegExp(
  [
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b`,
    `\\b${MONTH}\\.?\\s+\\d{1,4}\\b`,
    '\\b(?:19|20)\\d{2}\\b',
    // A day and a month in figures, with no year or with dots: "12/10", "12.10.2026".
    '\\b\\d{1,2}\\/\\d{1,2}\\b',
    '\\b\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}\\b',
    '\\d{4}\\s*年',
    '\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日',
  ].join('|'),
  'i',
);

/**
 * A figure that is an amount, not a year, though it may look like one: after a currency sign or
 * a word that bounds a quantity ("above", "at most", 超过), or before a currency or a unit
 * ("2000 USD", "1999 rows", "2000 元"). Taken out of a line before a year is looked for in it, so
 * "Updated policy: refunds above 2000 USD" states a figure and is compared (17-FD's second pass,
 * item 7: it read as dating its page, and two pages that disagreed on it were never a conflict).
 */
const AMOUNT = new RegExp(
  [
    '(?:[$£€¥]|\\b(?:above|over|under|below|than|up to|at most|at least|exceeding|beyond|within|max(?:imum)?|min(?:imum)?)\\s+|超过|高于|低于|不超过|至少|最多)\\s*\\d[\\d.,]*',
    '\\d[\\d.,]*\\s*(?:(?:usd|eur|gbp|sgd|cny|rmb|jpy|hkd|aud|cad|chf|inr|myr|dollars?|euros?|pounds?|yuan|percent|units?|items?|rows?|words?|pages?|tickets?|records?|lines?|hours?|minutes?|days?|weeks?)\\b|%|元|美元|人民币|行|条|个|天|小时)',
  ].join('|'),
  'gi',
);

/** "3 May", "May 2026": the month, never the verb, so its capital is read. */
const MAY_DATE = /\b\d{1,2}(?:st|nd|rd|th)?\s+May\b|\bMay\s+\d{1,4}\b/;

/** A word that dates its page when a date stands beside it. */
const DATE_WORD =
  /\b(?:updated|edited|reviewed|revised|as of|effective|copyright)\b|更新|修订|生效/i;

/** A version or revision with its number: "Version 3", "revision: 7", "版本 4", "版本：4". */
const VERSION_NUMBER = /\b(?:version|revision)\b\s*[:：]?\s*\d|版本\s*[:：]?\s*\d/i;

/**
 * Whether a line dates or versions its page, so that its figures differ between any two pages: a
 * date in figures, a version beside its number, or a date word beside a date. A date word in a
 * sentence that states a figure is part of the sentence (the joins' W3c: "is reviewed within 2
 * working days" against "5 working days" was passed over for its "reviewed", and the pair
 * proposed as a duplicate), and so is an amount that looks like a year ({@link AMOUNT}).
 */
function datesItsPage(line: string): boolean {
  if (FIGURE_DATE.test(line) || VERSION_NUMBER.test(line)) return true;
  if (!DATE_WORD.test(line)) return false;
  const dates = line.replace(AMOUNT, ' ');
  return WORDED_DATE.test(dates) || MAY_DATE.test(dates);
}

/** A heading as the conflict measure compares it. */
function headingOf(block: MeasuredBlock): string {
  return comparable(block.headingPath.filter((part) => part !== '').at(-1) ?? '');
}

/** One place two pages say the same sentence with other figures. */
export interface FigureConflict {
  /** The heading both blocks sit under, as the first page writes it. */
  readonly heading: string;
  /** The figures each page gives in that sentence, as written. */
  readonly left: string;
  readonly right: string;
  /** The two blocks' hashes, the first page's first. */
  readonly blocks: readonly [string, string];
}

/**
 * The places two pages disagree: under one heading (the innermost, whatever each page's title),
 * a line that reads the same on both but for its figures. A line that only dates or versions its
 * page is passed over. Precise rather than wide: two sentences in other words are not compared.
 */
export function headingFigures(
  left: Pick<MeasuredPage, 'blocks'>,
  right: Pick<MeasuredPage, 'blocks'>,
): FigureConflict[] {
  const lines = (block: MeasuredBlock): Array<{ template: string; figures: string }> =>
    block.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /\d/.test(line) && !datesItsPage(line))
      .map((line) => ({
        template: comparable(line.replace(FIGURE, '#')),
        figures: (line.match(FIGURE) ?? []).join(' '),
      }));
  // The other page's blocks by heading, so each block meets only the blocks under its own.
  const underHeading = new Map<string, MeasuredBlock[]>();
  for (const block of right.blocks) {
    const heading = headingOf(block);
    if (heading !== '') underHeading.set(heading, [...(underHeading.get(heading) ?? []), block]);
  }
  const conflicts: FigureConflict[] = [];
  for (const block of left.blocks) {
    const heading = headingOf(block);
    const mine = heading === '' ? [] : lines(block);
    if (mine.length === 0) continue;
    for (const other of underHeading.get(heading) ?? []) {
      const theirs = new Map(lines(other).map((line) => [line.template, line.figures]));
      const differing = mine.find((line) => {
        const figures = theirs.get(line.template);
        return figures !== undefined && figures !== line.figures;
      });
      if (differing === undefined) continue;
      conflicts.push({
        heading: block.headingPath.filter((part) => part !== '').at(-1) ?? '',
        left: differing.figures,
        right: theirs.get(differing.template) ?? '',
        blocks: [block.hash, other.hash],
      });
    }
  }
  return conflicts;
}

/**
 * The relation the measures propose between two pages, if any. One proposal a pair, by what the
 * evidence is strongest for:
 *
 * - a successor, when a page's front matter names the other, or the titles are one series the
 *   words order;
 * - a conflict, when under one heading the two say the same sentence with other figures;
 * - a successor, when they share `SHARED_TEXT_DUPLICATE` percent of their text or more and their
 *   sources dated their edits `DATED_SUCCESSOR_GAP_MS` or more apart, the later the successor
 *   (wave 16, 16-FD; RM19 (a): a copy edited later is most often its next version, and the
 *   manager confirms it on the card with both dates before anything reads it so);
 * - a duplicate, when they share that much text and nothing dates one after the other.
 *
 * For a pair nothing orders, the page its source had later is `from`: recency orders the card's
 * question, and changes no page's status (A5).
 */
export function measureRelation(
  left: MeasuredPage,
  right: MeasuredPage,
): ProposedRelation | undefined {
  const shared = sharedText(left, right);
  const series = titleVersion(left.title, right.title);
  const named = namedSuccessor(left, right);
  const conflicts = headingFigures(left, right);
  const evidence: RelationEvidence[] = [
    ...(named !== undefined ? [{ measure: 'names-successor' as const, value: 1 }] : []),
    ...(series !== undefined ? [{ measure: 'title-version' as const, value: 1 }] : []),
    ...(conflicts.length > 0
      ? [
          {
            measure: 'heading-figures' as const,
            value: conflicts.length,
            blockRefs: conflicts
              .flatMap((conflict) => [...conflict.blocks])
              .slice(0, RELATION_EVIDENCE_BLOCKS),
          },
        ]
      : []),
    ...(shared.share > 0
      ? [{ measure: 'shared-text' as const, value: shared.share, blockRefs: shared.blockRefs }]
      : []),
  ];
  const later = named ?? series;
  const ordered = (side: 'left' | 'right'): Pick<ProposedRelation, 'from' | 'to'> =>
    side === 'left' ? { from: left.key, to: right.key } : { from: right.key, to: left.key };
  if (later !== undefined) return { kind: 'possible_successor', ...ordered(later), evidence };
  const newer = left.updatedAt > right.updatedAt ? 'left' : 'right';
  if (conflicts.length > 0) return { kind: 'possible_conflict', ...ordered(newer), evidence };
  if (shared.share < SHARED_TEXT_DUPLICATE) return undefined;
  const apart = Math.abs(left.updatedAt - right.updatedAt);
  if (left.edited && right.edited && apart >= DATED_SUCCESSOR_GAP_MS) {
    const days = Math.floor(apart / DATED_SUCCESSOR_GAP_MS);
    return {
      kind: 'possible_successor',
      ...ordered(newer),
      evidence: [...evidence, { measure: 'edit-dates', value: days }],
    };
  }
  return { kind: 'possible_duplicate', ...ordered(newer), evidence };
}
