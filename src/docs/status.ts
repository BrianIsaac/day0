import { z } from 'zod';
import {
  PAGE_STATUSES,
  type DefaultPageStatus,
  type PageStatus,
  type StatusSource,
} from './authority';

/*
 * A page's status (wave 15, 15-A; the wave file's section 6.2; A5, A20, N20): what a page's own
 * source says of it (its front matter, the directory it is filed under, the word a provider gives
 * a page it archived or trashed), the pre-filter and the structured judgement of a free-text
 * marker at the top of a page, and the order the rules are read in. Pure, on the vocabulary of
 * `./authority`; `convex/docStatus.ts` reads the rows and writes the outcome.
 */

/** A source's own word for a page's status, by the status it comes to (K-10), lower case. */
const NATIVE_WORDS: Readonly<Record<PageStatus, readonly string[]>> = {
  active: ['active', 'current', 'published', 'live', 'approved', 'final', '现行', '有效', '已发布'],
  draft: ['draft', 'wip', 'in progress', 'in-progress', 'proposed', '草稿', '草案', '起草中'],
  superseded: [
    'superseded',
    'deprecated',
    'obsolete',
    'replaced',
    'withdrawn',
    '已废止',
    '已作废',
    '已废弃',
    '已替代',
  ],
  archived: ['archived', 'archive', 'retired', 'historical', 'trashed', 'in_trash', '已归档'],
};

/**
 * The status a source's own word comes to: `archived` for Notion's archive and trash and Drive's
 * trash, `draft` for a draft flag, and so on. A reader normalises its provider's word through
 * this before the page is stored (K-10).
 *
 * @param word - The source's word, in any case.
 * @returns The status, or undefined for a word that names none: an unknown word decides nothing.
 */
export function nativeStatusOfWord(word: string): PageStatus | undefined {
  const normalised = word.trim().toLowerCase();
  if (normalised === '') return undefined;
  return PAGE_STATUSES.find((status) => NATIVE_WORDS[status].includes(normalised));
}

/** A front matter flag that states a status by being true: `draft: true`, `archived: true`. */
const FRONT_MATTER_FLAGS: Readonly<Record<string, PageStatus>> = {
  draft: 'draft',
  archived: 'archived',
  deprecated: 'superseded',
  obsolete: 'superseded',
  superseded: 'superseded',
};

/** The most characters of a page read for its front matter: a block longer than this is not one. */
const FRONT_MATTER_LIMIT = 4_000;

/** What a page's front matter says of its status and of the pages around it. */
export interface FrontMatterStatus {
  /** The status its `status:` key or a status flag states, when it states one Day0 knows. */
  readonly status?: PageStatus;
  /** The pages its `supersedes:` key names, as written: a title, a file name or a path. */
  readonly supersedes: readonly string[];
  /** The pages its `superseded_by:` (or `replaced_by:`) key names, as written. */
  readonly supersededBy: readonly string[];
}

/** One front matter value as written: quotes and a trailing comment taken off. */
function scalar(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return (quoted ? quoted[2] : trimmed.replace(/\s+#.*$/, '')).trim();
}

/** A front matter value as a list: `[a, b]`, a block of `- a` lines, or one scalar. */
function listValue(inline: string, block: readonly string[]): string[] {
  const bracketed = /^\[(.*)\]$/.exec(inline.trim());
  const values = bracketed ? bracketed[1].split(',') : inline.trim() === '' ? block : [inline];
  return values.map(scalar).filter((value) => value !== '');
}

/** A line a front matter block may hold: blank, a comment, a key, a list item or a continuation. */
const FRONT_MATTER_LINE = /^(?:\s*|\s*#.*|[A-Za-z_][\w-]*\s*:.*|\s*-\s+.*|\s+\S.*)$/;

/** A top-level `key: value` line of front matter. */
const FRONT_MATTER_KEY = /^([A-Za-z_][\w-]*)\s*:(.*)$/;

/**
 * A page's front matter block: the lines between a first line of `---` and the next `---` (or
 * `...`), and where the body starts after it. Undefined when the page opens with no such block,
 * the block never closes inside `FRONT_MATTER_LIMIT` characters, it holds no key, or a line of it
 * is prose: a page that opens with a horizontal rule is not read as front matter.
 */
function frontMatterBlock(
  markdown: string,
): { readonly lines: readonly string[]; readonly body: string } | undefined {
  const text = markdown.replace(/^\uFEFF/, '');
  const lines = text.slice(0, FRONT_MATTER_LIMIT).split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  if (end < 0) return undefined;
  const block = lines.slice(1, end);
  if (!block.every((line) => FRONT_MATTER_LINE.test(line))) return undefined;
  if (!block.some((line) => FRONT_MATTER_KEY.test(line))) return undefined;
  const body = text
    .split(/\r?\n/)
    .slice(end + 1)
    .join('\n');
  return { lines: block, body };
}

/**
 * A page's front matter as its top-level keys, lower case with `-` read as `_`, each with its
 * inline value and the `- item` lines under it. Empty for a page with no front matter.
 */
function frontMatterKeys(markdown: string): Map<string, { inline: string; block: string[] }> {
  const keys = new Map<string, { inline: string; block: string[] }>();
  let current: { inline: string; block: string[] } | undefined;
  for (const line of frontMatterBlock(markdown)?.lines ?? []) {
    const key = FRONT_MATTER_KEY.exec(line);
    if (key) {
      current = { inline: key[2], block: [] };
      keys.set(key[1].toLowerCase().replaceAll('-', '_'), current);
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && current) current.block.push(item[1]);
  }
  return keys;
}

/**
 * The body of a page after its front matter block; the whole page when it has none.
 *
 * @param markdown - The page.
 */
export function withoutFrontMatter(markdown: string): string {
  return frontMatterBlock(markdown)?.body ?? markdown;
}

/**
 * What a Markdown page's front matter says: its `status:` (or a status flag such as
 * `draft: true`), and the pages `supersedes:` and `superseded_by:` name. Deterministic: a word
 * Day0 does not know states no status.
 *
 * @param markdown - The page as its source holds it.
 */
export function frontMatterStatus(markdown: string): FrontMatterStatus {
  const keys = frontMatterKeys(markdown);
  const named = (key: string): string[] => {
    const entry = keys.get(key);
    return entry ? listValue(entry.inline, entry.block) : [];
  };
  const stated = keys.get('status');
  let status = stated ? nativeStatusOfWord(scalar(stated.inline)) : undefined;
  if (status === undefined) {
    for (const [flag, flagged] of Object.entries(FRONT_MATTER_FLAGS)) {
      if (scalar(keys.get(flag)?.inline ?? '').toLowerCase() === 'true') {
        status = flagged;
        break;
      }
    }
  }
  return {
    ...(status !== undefined ? { status } : {}),
    supersedes: named('supersedes'),
    supersededBy: [...named('superseded_by'), ...named('replaced_by')],
  };
}

/** A directory an author files pages no longer current under, and one for pages not yet current. */
const ARCHIVE_DIRECTORY = /^[._]?(?:archived?|old)$/i;
const DRAFT_DIRECTORY = /^[._]?drafts?$/i;

/**
 * The status a page's path states: `archived` under `archive/`, `archived/` or `old/`, `draft`
 * under `drafts/` or `draft/`, at any depth. The author's own filing, read from a relative
 * reference's directories or a URL's path; the last segment is the page, not a directory.
 *
 * @param ref - The page's reference within its source.
 */
export function pathStatus(ref: string): PageStatus | undefined {
  let path = ref;
  if (/^https?:\/\//i.test(ref)) {
    try {
      path = new URL(ref).pathname;
    } catch {
      // Not a URL after all: read the reference as the path it spells.
    }
  }
  const segments = path.split('/').filter(Boolean);
  const directories = path.endsWith('/') ? segments : segments.slice(0, -1);
  if (directories.some((directory) => ARCHIVE_DIRECTORY.test(directory))) return 'archived';
  if (directories.some((directory) => DRAFT_DIRECTORY.test(directory))) return 'draft';
  return undefined;
}

/**
 * The status a Markdown file states of itself: its front matter first, since the author wrote it
 * on the page, then the directory it is filed under. The folder and git readers store it as the
 * page's native status.
 *
 * @param ref - The file's path within its source.
 * @param markdown - The file's text.
 */
export function fileNativeStatus(ref: string, markdown: string): PageStatus | undefined {
  return frontMatterStatus(markdown).status ?? pathStatus(ref);
}

/** How many characters of a page's body a marker is looked for in, beside its title (N20). */
export const MARKER_EXCERPT_CHARS = 300;

/**
 * The words that may mark a whole page as no longer current. **A pre-filter only (N20, F16)**: a
 * hit decides nothing, since "archived" is also what a page about archiving tickets says; it
 * chooses the pages whose top is put to the model, one call a hit. English words match whole,
 * in any case; Chinese ones anywhere.
 */
export const MARKER_VOCABULARY: readonly string[] = [
  'deprecated',
  'superseded',
  'obsolete',
  'outdated',
  'out of date',
  'archived',
  'retired',
  'withdrawn',
  'replaced by',
  'do not use',
  'no longer',
  'legacy',
  'draft',
  'work in progress',
  'wip',
  'not yet approved',
  '已废止',
  '废止',
  '已作废',
  '作废',
  '已废弃',
  '废弃',
  '已失效',
  '已过期',
  '已停用',
  '已归档',
  '归档',
  '已替代',
  '已被取代',
  '不再使用',
  '不再维护',
  '旧版',
  '草稿',
  '草案',
  '初稿',
  '征求意见稿',
];

/** Each vocabulary word as its matcher: a whole word for Latin script, a substring otherwise. */
const MARKER_MATCHERS: readonly RegExp[] = MARKER_VOCABULARY.map((word) => {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return /^[a-z ]+$/.test(word) ? new RegExp(`\\b${escaped}\\b`, 'i') : new RegExp(escaped);
});

/** The most characters of marker lines kept as a judgement's quote. */
const MARKER_QUOTE_LIMIT = 400;

/**
 * The most marker judgements one finishing sync asks of the model; the pages past it keep no
 * judgement and are asked at the next sync. A library linked whole judges this many pages a sync
 * until its pre-filter hits are all judged; after that only a page whose top changed is asked.
 */
export const MARKER_JUDGEMENTS_PER_SYNC = 20;

/** The top of a page a marker may sit in, and the lines of it the pre-filter hit. */
export interface MarkerCandidate {
  /** The page's title and the first `MARKER_EXCERPT_CHARS` characters of its body. */
  readonly excerpt: string;
  /**
   * The lines of the excerpt that hold a vocabulary word, as written: what the judgement is of,
   * and so its key. A stored judgement stands for a page while these lines are the ones it judged.
   */
  readonly quote: string;
}

/**
 * The pre-filter: the top of a page whose title or first `MARKER_EXCERPT_CHARS` body characters
 * hold a vocabulary word, with the lines that hold one. Undefined for a page with no hit, which
 * is never put to the model.
 *
 * @param title - The page's title.
 * @param markdown - The page's Markdown; its front matter is the source's own word, not a marker.
 */
export function markerCandidate(title: string, markdown: string): MarkerCandidate | undefined {
  const body = withoutFrontMatter(markdown).trimStart().slice(0, MARKER_EXCERPT_CHARS);
  const excerpt = `${title.trim()}\n${body}`.trim();
  const hits = excerpt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => MARKER_MATCHERS.some((matcher) => matcher.test(line)));
  if (hits.length === 0) return undefined;
  return { excerpt, quote: hits.join('\n').slice(0, MARKER_QUOTE_LIMIT) };
}

/** The judgement's system prompt: what the model is asked of the top of one page. */
export const MARKER_JUDGEMENT_INSTRUCTIONS = [
  'You read the title and the opening lines of one page of a company’s internal documentation.',
  'Decide whether those lines mark THE PAGE ITSELF as no longer current. Do not judge what the page is about.',
  '',
  'Answer with one status:',
  '- "superseded": the page says it is deprecated, obsolete, withdrawn, void or replaced by another page (for example "DEPRECATED", "superseded by v2", "已废止", "已作废").',
  '- "archived": the page says it is kept only for the record (for example "ARCHIVED", "retired", "已归档").',
  '- "draft": the page says it is a draft, in progress, for comment or not yet approved (for example "DRAFT", "WIP", "草稿", "征求意见稿").',
  '- "active": anything else. A page that explains how to archive a ticket, lists deprecated fields of a system, or mentions a draft invoice is active: the word describes its subject, not the page.',
  '',
  'Give `quote`: the exact words of the text that decide a status other than "active", copied character for character. For "active", an empty string.',
  'When unsure, answer "active".',
].join('\n');

/** The judgement's reply, validated: the status the top of the page states, and the words that state it. */
export const markerJudgementSchema = z.object({
  status: z.enum(PAGE_STATUSES),
  quote: z.string(),
});

/** One judgement's reply. */
export type MarkerJudgement = z.infer<typeof markerJudgementSchema>;

/**
 * The judgement's user prompt for one page's top.
 *
 * @param candidate - The page's excerpt, as the pre-filter cut it.
 */
export function markerJudgementPrompt(candidate: Pick<MarkerCandidate, 'excerpt'>): string {
  return [
    'The title and opening lines of the page, between the markers:',
    '<<<PAGE',
    candidate.excerpt,
    'PAGE>>>',
    '',
    'Reply with the status and the quote.',
  ].join('\n');
}

/** Text with its runs of white space made one space, for comparing a quote with its page. */
function spaced(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The status a judgement gives a page: the model's, when it is not `active` and its quote is
 * words the page's top holds; otherwise `active`. A judgement whose quote the page does not hold
 * is not grounded in the page and decides nothing, as a vocabulary hit alone decides nothing.
 *
 * @param judgement - The model's reply.
 * @param candidate - The excerpt it was asked about.
 */
export function judgedMarkerStatus(
  judgement: MarkerJudgement,
  candidate: Pick<MarkerCandidate, 'excerpt'>,
): PageStatus {
  if (judgement.status === 'active') return 'active';
  const quote = spaced(judgement.quote);
  if (quote === '' || !spaced(candidate.excerpt).includes(quote)) return 'active';
  return judgement.status;
}

/** A stored judgement of a page's marker lines (`docPages.marker`). */
export interface StoredMarker {
  readonly status: PageStatus;
  readonly quote: string;
}

/**
 * Whether a stored judgement is of the marker lines the page holds now: the cache's test, by page
 * and text. A page whose top changed, or whose lines a changed vocabulary reads differently, is
 * judged again; any other page is never put to the model twice.
 *
 * @param marker - The stored judgement, when the page has one.
 * @param candidate - What the pre-filter finds on the page now.
 */
export function markerStands(
  marker: StoredMarker | undefined,
  candidate: MarkerCandidate | undefined,
): marker is StoredMarker {
  return marker !== undefined && candidate !== undefined && marker.quote === candidate.quote;
}

/** What the rules read of one page. */
export interface StatusInputs {
  /** The status the manager gave the page by hand, while it stands. */
  readonly manager?: PageStatus;
  /** What the page's source says of it: a provider's archive or trash, front matter, a path. */
  readonly nativeStatus?: PageStatus;
  /** The judgement of the page's marker lines, when it stands for the page's text now. */
  readonly marker?: Pick<StoredMarker, 'status'>;
  /** Whether a relation the manager confirmed names another page as this page's successor. */
  readonly superseded?: boolean;
  /** What the page's source gives a page nothing else decides (`defaultStatusOf`). */
  readonly defaultStatus: DefaultPageStatus;
}

/** A page's status and what decided it. */
export interface DecidedStatus {
  readonly status: PageStatus;
  readonly statusSource: StatusSource;
}

/**
 * A page's status by the rules, first hit wins (A5; the audit's 11.3):
 *
 * 1. the manager, whose word on the page stands until Clear;
 * 2. the source itself (deterministic: its archive, trash or draft flag, front matter, a path);
 * 3. a marker at the top of the page that the model judged to say the page is not current (a
 *    marker judged `active` is no marker);
 * 4. a relation the manager confirmed, naming the page's successor;
 * 5. the source's default.
 *
 * Recency is no input: no edit time reaches this function, so a newer page never changes an
 * older one's status by being newer.
 *
 * @param inputs - What is known of the page.
 */
export function decidePageStatus(inputs: StatusInputs): DecidedStatus {
  if (inputs.manager !== undefined) return { status: inputs.manager, statusSource: 'manager' };
  if (inputs.nativeStatus !== undefined) {
    return { status: inputs.nativeStatus, statusSource: 'source-native' };
  }
  if (inputs.marker !== undefined && inputs.marker.status !== 'active') {
    return { status: inputs.marker.status, statusSource: 'marker' };
  }
  if (inputs.superseded === true) return { status: 'superseded', statusSource: 'relation' };
  return { status: inputs.defaultStatus, statusSource: 'default' };
}
