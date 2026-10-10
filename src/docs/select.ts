import { blockSearchQuery, searchTerms, splitPage } from './blocks';
import { sourceAuthorityOf, type SourceAuthority } from './authority';
import { renderHowTos, renderTeamDocs } from '../work/documents';
import { parseProcedureContract } from '../work/procedure-contract';
import { documentedBrowserFields, writtenBrowserSurfaces } from '../work/claim-key';
import {
  candidateNamesSurface,
  skillShapeFor,
  targetSurfaceFor,
  type ShapeSurface,
} from '../work/skill-shape';
import type {
  CiteConflict,
  CitedBlock,
  DocumentationCitation,
  DocumentationSelectionRecord,
  MockSurfaceSnapshot,
  PlanObligations,
  WorkCandidate,
} from '../work/types';

/*
 * The documentation selection (wave 14, 14-R; the wave file's section 6.2): which pages and
 * blocks of an employee's documentation reach a real-mode prompt for one work item. Pure, so it
 * is tested without a backend; `convex/docSelection.ts` feeds it the readable pages and the
 * blocks the search index scouted.
 *
 * Four steps. Always include every page a procedure contract is parsed from, every how-to guide
 * for the target surface that names the shape's operation, and every page documenting the form
 * of a browser-driven surface the plan writes, each whole. Scout with one search per field of
 * the item, each cut to the sixteen terms the backend reads, rarest first. Re-score what the
 * scout found with the index's own tokeniser, weighed by how far each page's source is trusted
 * (official over team over personal; recency only between equals: wave 15, A5), and keep the
 * best 12 blocks over at most 6 pages, at most 4 a page. Assemble each page's blocks in document
 * order under a cite line, guides first, within 24,000 characters, of which the ranked pick
 * keeps a floor.
 */

/** The most documentation characters one prompt carries (R4). */
export const DOCUMENTATION_CHAR_LIMIT = 24_000;

/** The most pages the ranked pick takes, beside the pages always included. */
export const SELECTED_PAGE_LIMIT = 6;

/** The most blocks the ranked pick takes. */
export const SELECTED_BLOCK_LIMIT = 12;

/** The most blocks the ranked pick takes from one page. */
export const BLOCKS_PER_PAGE_LIMIT = 4;

/**
 * The characters of the budget kept for the ranked pick (the review's D-3): the pages always
 * included are spent up to the budget less this, so a long guide for the target surface cannot
 * crowd out the blocks that answer the item. Every procedure contract's needed blocks are still
 * spent before anything (W14-R3); what the pick leaves of its floor goes back to those pages.
 */
export const PICK_FLOOR_CHARS = 6_000;

/**
 * How much a block's score counts by the trust of its page's source: official over team over
 * personal (A5). A weight, not a sort: a team page that answers the item still ranks above an
 * official page that barely mentions it, and between two pages that answer alike the more
 * trusted is first.
 */
export const AUTHORITY_WEIGHT: Readonly<Record<SourceAuthority, number>> = {
  official: 1,
  team: 0.85,
  personal: 0.7,
};

/**
 * The model call sites a selection is made for: the planner (whose selection the obligations
 * judgement reads too), the executor's first phase and its closing phase.
 */
export const DOCUMENTATION_SITES = [
  'plan',
  'execute',
  'closing',
] as const satisfies readonly DocumentationSelectionRecord['site'][];

/** One documentation site. */
export type DocumentationSite = (typeof DOCUMENTATION_SITES)[number];

/** What one selection is made for: the item and what the employee does to it. */
export interface SelectionRequest {
  readonly site: DocumentationSite;
  readonly title: string;
  readonly summary: string;
  /** The surface the work acts on (`targetSurfaceFor`), when one is listed. */
  readonly target?: { readonly slug: string; readonly displayName: string };
  /** The skill shape (`skillShapeFor`), when it is known. */
  readonly shape?: { readonly surfaceClass: string; readonly operation: string };
  /** The charter's function: the role's own words. */
  readonly roleFunction: string;
  /** Who raised the item, by name. */
  readonly requester?: string;
  /**
   * The browser-driven surfaces the approved plan writes, by slug. A mutable array, as the
   * snapshot query's validator types it: the request crosses that boundary unchanged.
   */
  readonly writtenBrowserSurfaces: string[];
}

/**
 * The deployment variable that turns the selection off, test beds only: set to `1`, a real-mode
 * prompt carries the whole mirror again, so a bed can grade a run with the selection against one
 * without it (the wave file's section 8). Not a configuration: `.env.example` does not name it.
 */
export const WHOLE_DOCUMENTATION_SWITCH = 'DAY0_TEST_WHOLE_DOCUMENTATION';

/** Whether the deployment's environment turns the selection off (`WHOLE_DOCUMENTATION_SWITCH`). */
export function selectionSwitchedOff(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[WHOLE_DOCUMENTATION_SWITCH]?.trim() === '1';
}

/** A surface as the request reads it: its name, class and path. */
export interface RequestSurface extends ShapeSurface {
  readonly path?: string;
}

/**
 * The selection request for one site of one item: its title and summary, the surface the work
 * acts on and the skill shape (as the evaluator reads them in real mode), the role's function,
 * the requester's name, and the browser-driven surfaces the approved plan writes.
 */
export function selectionRequestFor(input: {
  readonly site: DocumentationSite;
  readonly candidate: Pick<
    WorkCandidate,
    'title' | 'contentSummary' | 'sourceSystem' | 'requester' | 'requesterLabel'
  >;
  readonly roleFunction: string;
  readonly surfaces: readonly RequestSurface[];
  readonly obligations?: Pick<PlanObligations, 'steps'>;
}): SelectionRequest {
  const { candidate, surfaces } = input;
  const target = targetSurfaceFor(candidate, surfaces);
  const shape = skillShapeFor(candidate, surfaces, 'real');
  const requester = candidate.requester ?? candidate.requesterLabel;
  return {
    site: input.site,
    title: candidate.title,
    summary: candidate.contentSummary,
    ...(target ? { target: { slug: target.slug, displayName: target.displayName } } : {}),
    shape: { surfaceClass: shape.surfaceClass, operation: shape.operation },
    roleFunction: input.roleFunction,
    ...(requester ? { requester } : {}),
    writtenBrowserSurfaces: writtenBrowserSurfaces(input.obligations, surfaces),
  };
}

/** A page the employee reads, as the selection sees it. */
export interface SelectablePage {
  /** Unique across the employee's pages: the source and the page's ref, or the office slug. */
  readonly key: string;
  readonly slug: string;
  readonly title: string;
  readonly category: 'how-to-guide' | 'team-doc';
  /** The page as mirrored (redacted). */
  readonly body: string;
  /**
   * The source's label in a cite line, told apart from another source of the same label
   * (W14-R27); `office` for a page with no source.
   */
  readonly citeSource: string;
  /** The page's ref within its source in a cite line. */
  readonly citePage: string;
  /** The page's source (`docSources` id); absent for an office page with no source. */
  readonly sourceId?: string;
  /** How far the page's source is trusted; absent reads as `team` (`sourceAuthorityOf`). */
  readonly authority?: SourceAuthority;
  /** When the page was last stored: read only to order two pages of equal trust that answer alike. */
  readonly updatedAt?: number;
}

/** A block of a page, stored (with its row id) or split here. */
export interface SelectableBlock {
  /** The `docBlocks` row id; absent for a block split from the mirror here. */
  readonly id?: string;
  readonly pageKey: string;
  readonly index: number;
  readonly headingPath: readonly string[];
  readonly text: string;
  /** The stored block's hash, when the reader had it (`docBlocks.hash`). */
  readonly hash?: string;
}

/** One cite line and the stored blocks under it. */
export type Citation = DocumentationCitation;

/** The documentation one prompt carries, and what it is made of. */
export interface SelectedDocumentation extends Pick<
  MockSurfaceSnapshot,
  'howToGuides' | 'teamDocs'
> {
  readonly citations: readonly Citation[];
  /** Every stored block the prompt carries, in prompt order. */
  readonly blockIds: readonly string[];
  /** The documentation's characters as the prompt renders it. */
  readonly chars: number;
  /** The pages always included, by key, in prompt order. */
  readonly always: readonly string[];
  /** The ranked pick (6 pages, 12 blocks), best first, by block key. */
  readonly picked: readonly string[];
  /** Every scouted block that scored, best first, by block key. */
  readonly ranked: readonly string[];
}

/** What `selectDocumentation` reads. */
export interface SelectionInput {
  readonly request: SelectionRequest;
  /** The pages the employee reads, in the mirror's order. */
  readonly pages: readonly SelectablePage[];
  /** The blocks the scout found; a block of a page not in `pages` is dropped. */
  readonly scouted: readonly SelectableBlock[];
  /**
   * A page's stored blocks in document order, for the pages always included; a page with none
   * stored yet (its split is pending) is split here.
   */
  readonly pageBlocks?: ReadonlyMap<string, readonly SelectableBlock[]>;
  /**
   * The pages always included (`alwaysIncludedPages`), when the caller has worked them out already
   * to read their stored blocks, so each page is parsed for them once a selection (W14-R4).
   */
  readonly always?: readonly string[];
  /**
   * The stored blocks a confirmed conflict stands on, by block hash, with what each is disputed
   * by (`docRelations.standingConflictsOn`): the cite line of such a block is printed
   * `[conflict]`.
   */
  readonly conflicts?: ConflictsByHash;
}

/** What each disputed block is disputed by, by the block's hash. */
export type ConflictsByHash = ReadonlyMap<string, CiteConflict>;

/** What a disputed cite line ends with, after its closing bracket. */
export const CONFLICT_TAG = '[conflict]';

/** A cite line as the selection prints it, alone on its line. */
const CITE_LINE = /^\[cite: [^\n]*\]$/m;

/** Whether text carries a cite line: documentation the selection assembled. */
export function carriesCiteLines(text: string): boolean {
  return CITE_LINE.test(text);
}

/**
 * Documentation text without its cite lines: what a message may quote. A cite line labels where
 * the text below it comes from; a quote that runs from one block into the next must not meet it.
 */
export function withoutCiteLines(text: string): string {
  return text.replace(/^\[cite: [^\n]*\]\n?/gm, '');
}

/** A block's key: its row id, or its page and place for a block split here. */
export function blockKey(block: SelectableBlock): string {
  return block.id ?? `${block.pageKey}#${block.index}`;
}

/** A page's blocks as the store splits it, with no row id. */
export function pageBlocksOf(page: SelectablePage): SelectableBlock[] {
  return splitPage(page.body).map((block) => ({
    pageKey: page.key,
    index: block.index,
    headingPath: block.headingPath,
    text: block.text,
  }));
}

/** The documentation characters a prompt renders for these pages; none when there are none. */
export function documentationChars(
  documents: Pick<MockSurfaceSnapshot, 'howToGuides' | 'teamDocs'>,
): number {
  return (
    (documents.howToGuides.length > 0 ? renderHowTos(documents.howToGuides).length : 0) +
    (documents.teamDocs.length > 0 ? renderTeamDocs(documents.teamDocs).length : 0)
  );
}

/**
 * English function words, which say nothing of what a block is about: Lucene's English stop set.
 * The re-score gives them no weight and the scout puts them last; the index itself keeps them.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'if',
  'in',
  'into',
  'is',
  'it',
  'no',
  'not',
  'of',
  'on',
  'or',
  'such',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'was',
  'will',
  'with',
]);

/** The query strings of a request, one a field, before they are cut. */
function queryFields(request: SelectionRequest): Array<{ text: string; weight: number }> {
  return [
    { text: `${request.title}\n${request.summary}`, weight: 1 },
    {
      text: request.target ? `${request.target.displayName} ${request.target.slug}` : '',
      weight: 1,
    },
    {
      text: request.shape
        ? `${request.shape.surfaceClass} ${request.shape.operation.replaceAll('-', ' ')}`
        : '',
      weight: 0.5,
    },
    { text: request.roleFunction, weight: 0.5 },
    { text: request.requester ?? '', weight: 0.5 },
  ];
}

/** How many of the pages hold each of the terms. */
function pageFrequencies(
  pages: readonly SelectablePage[],
  terms: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>([...terms].map((term) => [term, 0]));
  for (const page of pages) {
    for (const term of new Set(searchTerms(`${page.title}\n${page.body}`))) {
      const count = counts.get(term);
      if (count !== undefined) counts.set(term, count + 1);
    }
  }
  return counts;
}

/**
 * The scout's search strings: one a field of the request (the item's title and summary, the
 * target surface's name and slug, the shape's words, the role's function, the requester's name),
 * each cut by `blockSearchQuery` to the sixteen terms the backend reads after ordering them
 * rarest first over the employee's pages, then the function words, then a term no page holds.
 * An empty field is left out.
 *
 * @param request - What the selection is for.
 * @param pages - The pages the employee reads: the rarity is counted over them.
 */
export function scoutQueries(
  request: SelectionRequest,
  pages: readonly SelectablePage[],
): string[] {
  const fields = queryFields(request).map((field) => [...new Set(searchTerms(field.text))]);
  const frequency = pageFrequencies(pages, new Set(fields.flat()));
  const rarity = (term: string): number => {
    const count = frequency.get(term) ?? 0;
    if (STOP_WORDS.has(term)) return Number.MAX_VALUE;
    return count === 0 ? Number.POSITIVE_INFINITY : count;
  };
  return fields.flatMap((terms) => {
    // A stable sort keeps the field's own order among equally rare terms.
    const ordered = [...terms].sort((left, right) => rarity(left) - rarity(right));
    const query = blockSearchQuery(ordered.join(' '));
    return query === '' ? [] : [query];
  });
}

/** The words of an operation a guide must name: `comment-and-close` is comment or close. */
function operationWords(operation: string): string[] {
  return operation.split('-').filter((word) => word !== '' && word !== 'and');
}

/**
 * The pages always included whole, by key, in the pages' order: every page a procedure trail is
 * parsed from (so the contract read from the selection is the one read from every page), every
 * how-to guide that names the target surface and a word of the shape's operation, and every page
 * documenting the form of a browser-driven surface the plan writes (`plannedWriteTargets` reads
 * them).
 */
export function alwaysIncludedPages(
  pages: readonly SelectablePage[],
  request: SelectionRequest,
): string[] {
  const words = request.shape ? operationWords(request.shape.operation) : [];
  return pages
    .filter((page) => {
      if (parseProcedureContract({ howToGuides: [page], teamDocs: [] }).trails.length > 0) {
        return true;
      }
      if (
        request.writtenBrowserSurfaces.some(
          (slug) => documentedBrowserFields([page], slug).length > 0,
        )
      ) {
        return true;
      }
      if (page.category !== 'how-to-guide' || request.target === undefined) return false;
      const text = `${page.title}\n${page.body}`;
      if (!candidateNamesSurface(text, request.target)) return false;
      const terms = new Set(searchTerms(text));
      return words.some((word) => terms.has(word));
    })
    .map((page) => page.key);
}

/**
 * The share of the best block's score a block needs to be ranked at all: a block that shares
 * only a common word with the item ("on") is noise in the prompt, not a candidate.
 */
export const RELEVANCE_FLOOR = 0.3;

/** BM25's term-frequency saturation and length normalisation. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * The scouted blocks of readable pages, scored against the request with the index's tokeniser
 * (BM25 over the block's heading path and text, each term's rarity counted over the pages and
 * weighted by the field that asked for it, then by the trust of the page's source), best first;
 * a block that shares no term with the request but terms on every page is dropped. Between
 * equal scores the page stored later is first, then the mirror's order: recency breaks a tie
 * and nothing else (A5).
 */
function rankBlocks(
  request: SelectionRequest,
  pages: readonly SelectablePage[],
  scouted: readonly SelectableBlock[],
): Array<{ block: SelectableBlock; score: number }> {
  const readable = new Set(pages.map((page) => page.key));
  const unique = new Map<string, SelectableBlock>();
  for (const block of scouted) {
    if (readable.has(block.pageKey) && !unique.has(blockKey(block))) {
      unique.set(blockKey(block), block);
    }
  }
  const weights = new Map<string, number>();
  for (const field of queryFields(request)) {
    for (const term of searchTerms(field.text)) {
      if (!STOP_WORDS.has(term)) weights.set(term, Math.max(weights.get(term) ?? 0, field.weight));
    }
  }
  const frequency = pageFrequencies(pages, new Set(weights.keys()));
  const idf = (term: string): number => {
    const count = frequency.get(term) ?? 0;
    return Math.log(1 + (pages.length - count + 0.5) / (count + 0.5));
  };
  const blocks = [...unique.values()].map((block) => ({
    block,
    terms: searchTerms([...block.headingPath, block.text].join('\n')),
  }));
  const averageLength =
    blocks.reduce((total, entry) => total + entry.terms.length, 0) / Math.max(1, blocks.length);
  const order = new Map(pages.map((page, index) => [page.key, index]));
  const byKey = new Map(pages.map((page) => [page.key, page]));
  const trust = (block: SelectableBlock): number =>
    AUTHORITY_WEIGHT[sourceAuthorityOf(byKey.get(block.pageKey) ?? {})];
  const storedAt = (block: SelectableBlock): number => byKey.get(block.pageKey)?.updatedAt ?? 0;
  const scored = blocks
    .map(({ block, terms }) => {
      const counts = new Map<string, number>();
      for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
      const norm = 1 - BM25_B + (BM25_B * terms.length) / Math.max(1, averageLength);
      let score = 0;
      for (const [term, weight] of weights) {
        const count = counts.get(term) ?? 0;
        // A term on every page tells no page apart ("the"); with one page, every term counts.
        if (count === 0 || (pages.length > 1 && frequency.get(term) === pages.length)) continue;
        score += (weight * idf(term) * count * (BM25_K1 + 1)) / (count + BM25_K1 * norm);
      }
      return { block, score: score * trust(block) };
    })
    .filter((entry) => entry.score > 0);
  const best = scored.reduce((top, entry) => Math.max(top, entry.score), 0);
  return scored
    .filter((entry) => entry.score >= RELEVANCE_FLOOR * best)
    .sort(
      (left, right) =>
        right.score - left.score ||
        storedAt(right.block) - storedAt(left.block) ||
        (order.get(left.block.pageKey) ?? 0) - (order.get(right.block.pageKey) ?? 0) ||
        left.block.index - right.block.index,
    );
}

/** The ranked pick: best first, at most 6 pages, 12 blocks and 4 blocks a page. */
function pickBlocks(
  ranked: ReadonlyArray<{ block: SelectableBlock }>,
  excluded: ReadonlySet<string>,
): SelectableBlock[] {
  const picked: SelectableBlock[] = [];
  const perPage = new Map<string, number>();
  for (const { block } of ranked) {
    if (picked.length === SELECTED_BLOCK_LIMIT) break;
    if (excluded.has(block.pageKey)) continue;
    const count = perPage.get(block.pageKey);
    if (count === undefined && perPage.size === SELECTED_PAGE_LIMIT) continue;
    if ((count ?? 0) === BLOCKS_PER_PAGE_LIMIT) continue;
    perPage.set(block.pageKey, (count ?? 0) + 1);
    picked.push(block);
  }
  return picked;
}

/** The words inside one cite line's brackets. */
function citeLabel(page: SelectablePage, headingPath: readonly string[]): string {
  const heading = headingPath.filter((part) => part !== '').join(' > ');
  return `${page.citeSource}/${page.citePage}${heading === '' ? '' : `#${heading}`}`;
}

/**
 * One page's blocks in document order, grouped under cite lines. A group one of whose blocks a
 * confirmed conflict stands on has its line printed with `CONFLICT_TAG` after the bracket, and
 * its citation says what disputes it.
 */
function assemblePage(
  page: SelectablePage,
  blocks: readonly SelectableBlock[],
  conflicts?: ConflictsByHash,
): { body: string; citations: Citation[] } {
  const ordered = [...blocks].sort((left, right) => left.index - right.index);
  const of = page.sourceId === undefined ? {} : { sourceId: page.sourceId, pageRef: page.citePage };
  const groups: Array<{ label: string; blocks: SelectableBlock[] }> = [];
  for (const block of ordered) {
    const label = citeLabel(page, block.headingPath);
    const last = groups.at(-1);
    if (last !== undefined && last.label === label) last.blocks.push(block);
    else groups.push({ label, blocks: [block] });
  }
  const parts: string[] = [];
  const citations: Citation[] = [];
  for (const group of groups) {
    const conflict = group.blocks
      .map((block) => (block.hash === undefined ? undefined : conflicts?.get(block.hash)))
      .find((entry) => entry !== undefined);
    const line = `[cite: ${group.label}]${conflict !== undefined ? ` ${CONFLICT_TAG}` : ''}`;
    parts.push(
      `${parts.length > 0 ? '\n' : ''}${line}\n${group.blocks.map((block) => block.text).join('\n\n')}`,
    );
    citations.push({
      label: group.label,
      ...of,
      blocks: group.blocks.flatMap((block): CitedBlock[] =>
        block.id === undefined
          ? []
          : [{ id: block.id, ...(block.hash !== undefined ? { hash: block.hash } : {}) }],
      ),
      ...(conflict !== undefined ? { conflict } : {}),
    });
  }
  return { body: parts.join('\n'), citations };
}

/** One page as the prompt will carry it, with the blocks it carries. */
interface Assembled {
  readonly page: SelectablePage;
  readonly blocks: readonly SelectableBlock[];
}

/**
 * Select the documentation one real-mode prompt carries for one item.
 *
 * @returns The how-to guides and team documents as the prompt sites read them (each page's
 *   blocks in document order under its cite lines), the citations, the stored block ids, the
 *   characters, and what was always included and picked.
 */
export function selectDocumentation(input: SelectionInput): SelectedDocumentation {
  const { request, pages } = input;
  const byKey = new Map(pages.map((page) => [page.key, page]));
  const always = input.always ?? alwaysIncludedPages(pages, request);
  const alwaysSet = new Set(always);
  const ranked = rankBlocks(request, pages, input.scouted);
  const picked = pickBlocks(ranked, alwaysSet);
  const rankOf = new Map(ranked.map((entry, index) => [blockKey(entry.block), index]));

  const contract = new Set(always.filter((key) => yieldsContract(byKey.get(key)!)));
  const alwaysPages = always.map((key) => {
    const page = byKey.get(key)!;
    const stored = input.pageBlocks?.get(key) ?? [];
    return { page, blocks: stored.length > 0 ? stored : pageBlocksOf(page) };
  });
  const pickedPages = pagesInPickOrder(picked).map((key) => ({
    page: byKey.get(key)!,
    blocks: picked.filter((block) => block.pageKey === key),
  }));
  // The order the budget is spent in: every page a procedure contract is parsed from, then the
  // other pages always included, then the ranked pick; guides first within each (R4).
  const candidates: Assembled[] = [
    ...guidesFirst(alwaysPages.filter((entry) => contract.has(entry.page.key))),
    ...guidesFirst(alwaysPages.filter((entry) => !contract.has(entry.page.key))),
    ...guidesFirst(pickedPages),
  ];
  const needed = new Map(
    candidates
      .filter((candidate) => contract.has(candidate.page.key))
      .map((candidate) => [candidate.page.key, contractBlocks(candidate)] as const),
  );
  const priority = (candidate: Assembled): ((block: SelectableBlock) => number) => {
    const contractNeeds = needed.get(candidate.page.key);
    if (contractNeeds !== undefined) {
      return (block) =>
        (contractNeeds.has(blockKey(block)) ? 0 : 1) * candidate.blocks.length + block.index;
    }
    if (alwaysSet.has(candidate.page.key)) return (block) => block.index;
    return (block) => rankOf.get(blockKey(block)) ?? Number.POSITIVE_INFINITY;
  };

  // Every contract's needed blocks are spent first, page by page: one long contract page no
  // longer cuts the next page's contract (W14-R3). Then the pages always included, up to the
  // budget less the pick's floor; then the ranked pick; then what is left goes back to the pages
  // always included, in the order above (D-3).
  const chosen: ChosenDocumentation = {
    blocks: new Map(),
    entries: new Map(),
    conflicts: input.conflicts,
  };
  for (const candidate of candidates) {
    const contractNeeds = needed.get(candidate.page.key);
    if (contractNeeds === undefined) continue;
    const blocks = candidate.blocks.filter((block) => contractNeeds.has(blockKey(block)));
    fitBlocks(candidate, blocks, chosen, candidates);
  }
  const spend = (candidate: Assembled, limit: number): void => {
    const rank = priority(candidate);
    const ordered = [...candidate.blocks].sort((left, right) => rank(left) - rank(right));
    fitBlocks(candidate, ordered, chosen, candidates, limit);
  };
  const included = candidates.filter((candidate) => alwaysSet.has(candidate.page.key));
  const beforeThePick =
    pickedPages.length > 0 ? DOCUMENTATION_CHAR_LIMIT - PICK_FLOOR_CHARS : DOCUMENTATION_CHAR_LIMIT;
  for (const candidate of included) spend(candidate, beforeThePick);
  for (const candidate of candidates) {
    if (!alwaysSet.has(candidate.page.key)) spend(candidate, DOCUMENTATION_CHAR_LIMIT);
  }
  if (pickedPages.length > 0) {
    for (const candidate of included) spend(candidate, DOCUMENTATION_CHAR_LIMIT);
  }

  const howToGuides: Array<MockSurfaceSnapshot['howToGuides'][number]> = [];
  const teamDocs: Array<MockSurfaceSnapshot['teamDocs'][number]> = [];
  const citations: Citation[] = [];
  for (const candidate of candidates) {
    const blocks = chosen.blocks.get(candidate.page.key);
    if (blocks === undefined || blocks.length === 0) continue;
    const assembled = assemblePage(candidate.page, blocks, input.conflicts);
    const entry = { slug: candidate.page.slug, title: candidate.page.title, body: assembled.body };
    (candidate.page.category === 'how-to-guide' ? howToGuides : teamDocs).push(entry);
    citations.push(...assembled.citations);
  }
  const documents = { howToGuides, teamDocs };
  return {
    ...documents,
    citations,
    blockIds: citations.flatMap((citation) => citation.blocks.map((block) => block.id)),
    chars: documentationChars(documents),
    always,
    picked: picked.map(blockKey),
    ranked: ranked.map((entry) => blockKey(entry.block)),
  };
}

/** The most blocks of one contract page weighed one by one for the contract they carry. */
const CONTRACT_BLOCK_SEARCH_LIMIT = 200;

/** Pages with the how-to guides first, each kind in the order given. */
function guidesFirst(entries: readonly Assembled[]): Assembled[] {
  return [
    ...entries.filter((entry) => entry.page.category === 'how-to-guide'),
    ...entries.filter((entry) => entry.page.category !== 'how-to-guide'),
  ];
}

/** Whether a page yields a procedure trail on its own. */
function yieldsContract(page: Pick<SelectablePage, 'slug' | 'title' | 'body'>): boolean {
  return (
    parseProcedureContract({
      howToGuides: [{ slug: page.slug, title: page.title, body: page.body }],
      teamDocs: [],
    }).trails.length > 0
  );
}

/**
 * The blocks of a contract page without which the page's own contract would parse differently,
 * by key: kept first when the budget cannot hold the page whole, so a contract is never what the
 * bound cuts while its page can be cut instead. Past `CONTRACT_BLOCK_SEARCH_LIMIT` blocks none is
 * weighed, and the page keeps document order.
 */
function contractBlocks(candidate: Assembled): Set<string> {
  const { page } = candidate;
  // Each block is weighed by one parse of the page without it.
  if (candidate.blocks.length > CONTRACT_BLOCK_SEARCH_LIMIT) return new Set();
  const parse = (blocks: readonly SelectableBlock[]): string =>
    JSON.stringify(
      parseProcedureContract({
        howToGuides: [
          { slug: page.slug, title: page.title, body: assemblePage(page, blocks).body },
        ],
        teamDocs: [],
      }).trails,
    );
  const whole = parse(candidate.blocks);
  return new Set(
    candidate.blocks
      .filter((block) => parse(candidate.blocks.filter((other) => other !== block)) !== whole)
      .map(blockKey),
  );
}

/** The picked pages, by key, in the order their best block was picked. */
function pagesInPickOrder(picked: readonly SelectableBlock[]): string[] {
  return [...new Set(picked.map((block) => block.pageKey))];
}

/** Each page's chosen blocks by key, and the page as the prompt would carry them. */
interface ChosenDocumentation {
  readonly blocks: Map<string, SelectableBlock[]>;
  readonly entries: Map<string, { slug: string; title: string; body: string }>;
  /** The disputed blocks, whose tagged cite lines count toward the budget as they are printed. */
  readonly conflicts?: ConflictsByHash;
}

/**
 * Add to a page's chosen blocks as many of `blocks` (in the order given, the first kept longest) as
 * fit the budget beside every page's chosen blocks; none when even the first does not fit. A longer
 * prefix never renders shorter, so the largest that fits is found by bisection; the other pages'
 * bodies are kept assembled, so a step assembles this page alone.
 *
 * @param chosen - Each page's chosen blocks and assembled body, updated in place.
 * @param candidates - Every page in the order the prompt carries them, for the budget's sum.
 * @param limit - The budget this spend may reach; the whole budget unless a floor is kept back.
 */
function fitBlocks(
  candidate: Assembled,
  blocks: readonly SelectableBlock[],
  chosen: ChosenDocumentation,
  candidates: readonly Assembled[],
  limit: number = DOCUMENTATION_CHAR_LIMIT,
): void {
  const key = candidate.page.key;
  const base = chosen.blocks.get(key) ?? [];
  const taken = new Set(base.map(blockKey));
  const extra = blocks.filter((block) => !taken.has(blockKey(block)));
  const trialBlocks = (count: number): SelectableBlock[] =>
    [...base, ...extra.slice(0, count)].sort((left, right) => left.index - right.index);
  const entryOf = (own: readonly SelectableBlock[]) => ({
    slug: candidate.page.slug,
    title: candidate.page.title,
    body: assemblePage(candidate.page, own, chosen.conflicts).body,
  });
  const fits = (count: number): boolean => {
    const trial = entryOf(trialBlocks(count));
    const documents: Pick<MockSurfaceSnapshot, 'howToGuides' | 'teamDocs'> = {
      howToGuides: [],
      teamDocs: [],
    };
    for (const other of candidates) {
      const entry = other.page.key === key ? trial : chosen.entries.get(other.page.key);
      if (entry === undefined) continue;
      (other.page.category === 'how-to-guide' ? documents.howToGuides : documents.teamDocs).push(
        entry,
      );
    }
    return documentationChars(documents) <= limit;
  };
  let low = 0;
  let high = extra.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  if (low > 0) {
    const own = trialBlocks(low);
    chosen.blocks.set(key, own);
    chosen.entries.set(key, entryOf(own));
  }
}
