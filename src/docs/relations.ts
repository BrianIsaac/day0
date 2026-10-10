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

/** The most new proposals one source's finishing sync writes; the rest are proposed at the next. */
export const RELATION_PROPOSALS_PER_SYNC = 50;

/** The most pages one finishing sync measures for relations; the rest are measured at the next. */
export const RELATION_PAGES_PER_SYNC = 100;

/** The most other pages one page is measured against: the best of what its title and headings find. */
export const RELATION_CANDIDATES_PER_PAGE = 3;

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
  /** When the source last had the page: read only to order a pair nothing else orders. */
  readonly updatedAt: number;
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

/** A figure in a line: a number with its separators, as written. */
const FIGURE = /\d+(?:[.,:]\d+)*/g;

/** A line that dates or versions its page: its figures differ between any two pages. */
const DATING_LINE =
  /\b(?:updated|edited|reviewed|revised|version|revision|as of|effective|copyright)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|更新|修订|版本|生效/i;

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
      .filter((line) => /\d/.test(line) && !DATING_LINE.test(line))
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
 * - a duplicate, when they share `SHARED_TEXT_DUPLICATE` percent of their text or more.
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
  if (shared.share >= SHARED_TEXT_DUPLICATE) {
    return { kind: 'possible_duplicate', ...ordered(newer), evidence };
  }
  return undefined;
}
