/**
 * HTML as Markdown, the one conversion every documentation reader shares (wave 15, 15-X).
 *
 * Three entry points over one `turndown` configuration:
 *
 * - `htmlToMarkdown` is the URL reader's conversion as it has always been. A stored page's hash
 *   covers the Markdown its reader gave, so this output does not move: a change here would
 *   redact and split every stored URL page again and stamp the skills that read it.
 * - `documentHtmlToMarkdown` adds pipe tables and checklists, for the readers that landed with
 *   it (SharePoint pages, Yuque, Word documents, Confluence), whose pages keep their procedures
 *   in tables and whose blocks the splitter cuts by kind (`src/docs/blocks.ts`).
 * - `confluenceStorageToMarkdown` first rewrites Confluence's storage format (XHTML with `ac:`
 *   and `ri:` elements, CDATA bodies and tags closed in themselves) into plain HTML. An HTML
 *   parser reads none of those as Confluence means them: a tag closed in itself stays open and
 *   swallows what follows, and a CDATA section is a comment.
 */
import TurndownService from 'turndown';

/** The options the URL reader has converted with since it landed. */
const TURNDOWN_OPTIONS = { headingStyle: 'atx', codeBlockStyle: 'fenced' } as const;

/** A table cell, as its row's text: its Markdown on one line, a pipe escaped. */
function cellText(content: string): string {
  return content
    .trim()
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|');
}

/** An element's element children with one of these names. */
function childElements(node: Node, names: readonly string[]): Element[] {
  return Array.from(node.childNodes).filter(
    (child): child is Element => child.nodeType === 1 && names.includes(child.nodeName),
  );
}

/** A table's rows, through its sections, in document order. */
function tableRows(table: Node): Element[] {
  return Array.from(table.childNodes).flatMap((child): Element[] => {
    if (child.nodeType !== 1) return [];
    if (child.nodeName === 'TR') return [child as Element];
    return ['THEAD', 'TBODY', 'TFOOT'].includes(child.nodeName) ? childElements(child, ['TR']) : [];
  });
}

/** The table a row belongs to, through its section. */
function tableOf(row: Node): Node | null {
  const parent = row.parentNode;
  if (parent === null) return null;
  return parent.nodeName === 'TABLE' ? parent : parent.parentNode;
}

/**
 * The `turndown` service with pipe tables and checklists.
 *
 * A table's first row is its header when it holds a header cell; a table with none gets an empty
 * header row, which Markdown requires, so no row of data reads as a heading.
 */
function documentService(): TurndownService {
  const service = new TurndownService(TURNDOWN_OPTIONS);
  service.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: (content: string): string => ` ${cellText(content)} |`,
  });
  service.addRule('tableRow', {
    filter: 'tr',
    replacement: (content: string, node: Node): string => {
      const cells = childElements(node, ['TH', 'TD']);
      const table = tableOf(node);
      const first = table !== null && tableRows(table)[0] === node;
      const rule = `|${cells.map((): string => ' --- |').join('')}`;
      const row = `|${content}`;
      if (!first) return `\n${row}`;
      return cells.some((cell): boolean => cell.nodeName === 'TH')
        ? `${row}\n${rule}`
        : `|${cells.map((): string => '  |').join('')}\n${rule}\n${row}`;
    },
  });
  service.addRule('tableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: (content: string): string => content,
  });
  service.addRule('table', {
    filter: 'table',
    replacement: (content: string): string => `\n\n${content.trim()}\n\n`,
  });
  service.addRule('checklistItem', {
    filter: (node: HTMLElement): boolean =>
      node.nodeName === 'INPUT' &&
      node.getAttribute('type') === 'checkbox' &&
      node.parentNode?.nodeName === 'LI',
    replacement: (_content: string, node: Node): string =>
      (node as Element).hasAttribute('checked') ? '[x] ' : '[ ] ',
  });
  return service;
}

/**
 * Convert HTML to Markdown as the URL reader does: headings with hashes, code in fences.
 *
 * @param html - A page's HTML.
 * @returns Its Markdown. A table is not drawn: each cell is a paragraph, as it has been.
 */
export function htmlToMarkdown(html: string): string {
  return new TurndownService(TURNDOWN_OPTIONS).turndown(html);
}

/**
 * The largest document HTML converted. A page the store takes is under a mebibyte of Markdown, so
 * a document past this is named unread by its reader rather than converted and refused later.
 */
export const MAX_DOCUMENT_HTML_BYTES = 4 * 1024 * 1024;

/**
 * The most elements one document may hold. The conversion's cost grows with the square of the
 * elements that sit side by side (10,000 paragraphs take about two seconds here, 50,000 about a
 * minute), and a batch converts up to 25 documents inside one action's time.
 */
export const MAX_DOCUMENT_ELEMENTS = 20_000;

/** What is said of a document nested past what a conversion's recursion reaches. */
export const NESTED_TOO_DEEPLY =
  'it is laid out too deeply for Day0 to convert: lists, tables or quotations inside one ' +
  'another, many levels down';

/**
 * Why a document's HTML was not converted, in words that follow "it" after the document's title.
 *
 * The failure is the document's own, so its reader names that one document unread and reads on.
 */
export class DocumentConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentConversionError';
  }
}

/**
 * Convert a document's HTML to Markdown, with its tables as pipe tables and its checkboxes as a
 * checklist.
 *
 * @param html - A document's HTML: a SharePoint page's web parts, a Yuque body, a converted Word
 *   document, or Confluence storage after its pre-pass.
 * @throws DocumentConversionError for a document past the size or the element count converted,
 *   one nested deeper than the conversion's recursion reaches, or one the converter fails on.
 */
export function documentHtmlToMarkdown(html: string): string {
  if (html.length > MAX_DOCUMENT_HTML_BYTES) {
    throw new DocumentConversionError(
      `it is larger than the ${MAX_DOCUMENT_HTML_BYTES / (1024 * 1024)} MiB Day0 converts of one page`,
    );
  }
  let elements = 0;
  for (let at = html.indexOf('<'); at !== -1; at = html.indexOf('<', at + 1)) {
    const next = html.charCodeAt(at + 1) | 0x20;
    // An opening tag: `<` then a letter.
    if (next >= 0x61 && next <= 0x7a) elements += 1;
    if (elements > MAX_DOCUMENT_ELEMENTS) {
      throw new DocumentConversionError(
        `it holds more than the ${MAX_DOCUMENT_ELEMENTS.toLocaleString('en-GB')} paragraphs, ` +
          'list items and table cells Day0 converts of one page',
      );
    }
  }
  try {
    return documentService().turndown(html);
  } catch (error) {
    // The converter walks the document by recursion, so one nested past its stack overflows it.
    if (error instanceof RangeError) throw new DocumentConversionError(NESTED_TOO_DEEPLY);
    throw new DocumentConversionError(
      `it could not be converted (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * A page's Markdown under its own title.
 *
 * A wiki keeps a page's title apart from its body, and the store names a page by its first
 * level-one heading (`markdownPageTitle`), so a body that opens on a section heading would be
 * stored under that section's name. The title goes first unless the body already opens with it.
 *
 * @param title - The page's title in its source.
 * @param markdown - The page's body as Markdown.
 */
export function underTitle(title: string, markdown: string): string {
  const heading = title.replace(/\s+/g, ' ').trim();
  const body = markdown.trim();
  if (heading === '') return body;
  const first = /^#\s+(.+?)\s*$/.exec(body.split('\n', 1)[0] ?? '')?.[1];
  if (first === heading) return body;
  return body === '' ? `# ${heading}` : `# ${heading}\n\n${body}`;
}

/** Text as HTML text. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** An attribute's value in a tag's source, as the XML wrote it (entities kept), or undefined. */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match === null ? undefined : (match[1] ?? match[2]);
}

/** What a panel macro is called above its text. */
const PANEL_NAMES: Readonly<Record<string, string>> = {
  info: 'Info',
  note: 'Note',
  tip: 'Tip',
  warning: 'Warning',
};

/** The macros whose plain-text body is code, drawn in a fence. */
const CODE_MACROS: ReadonlySet<string> = new Set(['code', 'noformat']);

/**
 * Rewrite every element of the named kinds that is closed, in one pass over the text.
 *
 * What a lazy pattern (`<ac:link\b[^>]*>[\s\S]*?<\/ac:link>`) matches, found without its cost:
 * the pattern scans from each opening tag to the end of the text for a closing tag that is not
 * there, so a body of elements never closed cost the square of its length (W15-R28). Here the
 * end of a tag and the last closing tag of each name are each looked for once and remembered.
 *
 * @param text - The text to rewrite.
 * @param names - The elements' names as an alternation, each with its prefix (`ac:image|time`).
 * @param rewrite - What stands for one element: its opening tag's attributes as written, what it
 *   holds, and its name.
 * @returns The text with each closed element rewritten; one left open stays as it is.
 */
function rewriteElements(
  text: string,
  names: string,
  rewrite: (attributes: string, inner: string, name: string) => string,
): string {
  const opening = new RegExp(`<(${names})(?![\\w-])`, 'g');
  const lastClose = new Map<string, number>();
  let rewritten = '';
  let kept = 0;
  let tagEnd = -1;
  for (let open = opening.exec(text); open !== null; open = opening.exec(text)) {
    const name = open[1];
    const attributesAt = opening.lastIndex;
    if (tagEnd < attributesAt) tagEnd = text.indexOf('>', attributesAt);
    // No tag ends from here on, so no element of any name opens.
    if (tagEnd < 0) break;
    const close = `</${name}>`;
    const last = lastClose.get(close) ?? text.lastIndexOf(close);
    lastClose.set(close, last);
    // An element opened after the last closing tag of its name is never closed.
    if (last <= tagEnd) continue;
    const closeAt = text.indexOf(close, tagEnd + 1);
    rewritten +=
      text.slice(kept, open.index) +
      rewrite(text.slice(attributesAt, tagEnd), text.slice(tagEnd + 1, closeAt), name);
    kept = closeAt + close.length;
    opening.lastIndex = kept;
  }
  return rewritten + text.slice(kept);
}

/**
 * Every CDATA section as the text it holds, escaped: text as typed. Confluence splits one that
 * holds `]]>` into two. Read up to the last `]]>` only, since a section opened after it is never
 * closed and a pattern would scan from each such opening to the end of the text (W15-R28).
 */
function cdataAsText(text: string): string {
  const end = text.lastIndexOf(']]>');
  if (end < 0) return text;
  const closed = text
    .slice(0, end + 3)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_all, typed: string): string => escapeHtml(typed));
  return closed + text.slice(end + 3);
}

/** A macro's parameters by name, each value as the XML wrote it. */
function macroParameters(inner: string): Map<string, string> {
  const parameters = new Map<string, string>();
  rewriteElements(inner, 'ac:parameter', (attributes, value): string => {
    parameters.set(attribute(attributes, 'ac:name') ?? '', value.trim());
    return '';
  });
  return parameters;
}

/**
 * The contents of a macro's body element, from its first opening tag to its last closing one, or
 * undefined when it has none.
 */
function macroBody(inner: string, element: string): string | undefined {
  const open = new RegExp(`<ac:${element}(?![\\w-])`).exec(inner);
  if (open === null) return undefined;
  const tagEnd = inner.indexOf('>', open.index + open[0].length);
  const close = inner.lastIndexOf(`</ac:${element}>`);
  return tagEnd < 0 || close <= tagEnd ? undefined : inner.slice(tagEnd + 1, close);
}

/** What the first closed element of the named kinds holds, or undefined when there is none. */
function firstElement(text: string, names: string): string | undefined {
  let first: string | undefined;
  rewriteElements(text, names, (_attributes, inner): string => {
    first ??= inner;
    return '';
  });
  return first;
}

/**
 * One macro that holds no other macro, as plain HTML.
 *
 * Code is a fenced block in its language; a panel is a quotation under its kind and title; a
 * status is its word; any other macro is its rich text under its title, or its plain text as it
 * was typed. A macro with no body (a table of contents, a page tree) draws nothing: day0 reads
 * the page's own text.
 */
function macroHtml(tag: string, inner: string): string {
  const name = attribute(tag, 'ac:name') ?? '';
  const parameters = macroParameters(inner);
  const title = parameters.get('title');
  const plain = macroBody(inner, 'plain-text-body');
  const rich = macroBody(inner, 'rich-text-body');
  if (plain !== undefined) {
    // The language names a fence, so only what a language name holds is kept of it.
    const language = CODE_MACROS.has(name)
      ? parameters.get('language')?.replace(/[^\w+#.-]/g, '')
      : undefined;
    const code = `<pre><code${language ? ` class="language-${language}"` : ''}>${plain}</code></pre>`;
    return title ? `<p><strong>${title}</strong></p>${code}` : code;
  }
  if (name === 'status') return title ?? '';
  // An issue macro holds nothing but the issue it names.
  if (rich === undefined) return name === 'jira' ? (parameters.get('key') ?? '') : '';
  // By its own property only: a macro may be named anything, `constructor` among it.
  const panel = Object.hasOwn(PANEL_NAMES, name) ? PANEL_NAMES[name] : undefined;
  if (panel !== undefined || name === 'panel') {
    const heading = [panel, title].filter(Boolean).join(': ');
    return `<blockquote>${heading ? `<p><strong>${heading}</strong></p>` : ''}${rich}</blockquote>`;
  }
  return `${title ? `<p><strong>${title}</strong></p>` : ''}${rich}`;
}

/** The most levels of macros inside macros the pre-pass unwraps before it stops. */
const MAX_MACRO_DEPTH = 50;

/** A macro element that holds no other macro: the innermost, which each pass rewrites. */
const INNERMOST_MACRO =
  /<ac:(structured-macro|macro)\b([^<>]*)>((?:(?!<ac:(?:structured-)?macro\b)[\s\S])*?)<\/ac:\1>/g;

/** A link to a page, an attachment or a space: its words, or what it points to when it has none. */
function linkHtml(inner: string): string {
  const body = firstElement(inner, 'ac:plain-text-link-body|ac:link-body');
  if (body !== undefined && body.trim() !== '') return body.trim();
  const target = /<ri:[\w-]+(?![\w-])[^<>]*>/.exec(inner)?.[0] ?? '';
  return (
    attribute(target, 'ri:content-title') ??
    attribute(target, 'ri:filename') ??
    attribute(target, 'ri:space-key') ??
    ''
  );
}

/** An image: a picture at an address stays one; an attached file is named, since day0 reads text. */
function imageHtml(tag: string, inner: string): string {
  const url = attribute(/<ri:url\b[^<>]*>/.exec(inner)?.[0] ?? '', 'ri:value');
  if (url !== undefined) return `<img src="${url}" alt="${attribute(tag, 'ac:alt') ?? ''}">`;
  const file = attribute(/<ri:attachment\b[^<>]*>/.exec(inner)?.[0] ?? '', 'ri:filename');
  return file === undefined ? '' : `(image: ${file})`;
}

/**
 * Rewrite Confluence's storage format as plain HTML.
 *
 * @param storage - A page body in the storage format (`body.storage.value`).
 * @returns HTML with no `ac:`, `ri:` or `at:` element and no CDATA section.
 */
export function confluenceStorageToHtml(storage: string): string {
  let html = cdataAsText(storage)
    // XML closes an empty element in its own tag, which HTML reads as left open. One class and
    // one lazy step: a second optional run of spaces here made a padded tag cost its square.
    // The name ends where no name character follows: `\b` let a name of dashes be cut at each
    // dash in turn, which cost its square too (W15-R28).
    .replace(/<((?:ac|ri|at):[\w-]+(?![\w-])|time\b)([^<>]*?)\/>/g, '<$1$2></$1>');
  html = rewriteElements(html, 'ac:emoticon|ac:placeholder|ac:task-id|ac:task-uuid', () => '');
  // A new-editor node (a panel, a decision) carries its content, its attributes as text, and
  // a rendering of the same content for older readers: the content alone is read, once.
  html = rewriteElements(html, 'ac:adf-attribute', () => '');
  html = rewriteElements(html, 'ac:adf-extension', (_attributes, inner): string =>
    inner.includes('<ac:adf-content') ? rewriteElements(inner, 'ac:adf-fallback', () => '') : inner,
  );
  html = html.replace(
    /<time\b([^<>]*)>\s*<\/time>/g,
    (_all, tag: string): string => attribute(tag, 'datetime') ?? '',
  );
  html = rewriteElements(html, 'ac:image', (attributes, inner): string =>
    imageHtml(attributes, inner),
  );
  html = rewriteElements(html, 'ac:link', (_attributes, inner): string => linkHtml(inner));
  for (let depth = 0; depth < MAX_MACRO_DEPTH; depth += 1) {
    const unwrapped = html.replace(
      INNERMOST_MACRO,
      (_all, _element: string, tag: string, inner: string): string => macroHtml(tag, inner),
    );
    if (unwrapped === html) break;
    html = unwrapped;
  }
  return (
    html
      .replace(
        /<ac:task-status\b[^<>]*>\s*(\w+)\s*<\/ac:task-status>/g,
        (_all, status: string): string =>
          `<input type="checkbox"${status === 'complete' ? ' checked' : ''}>`,
      )
      .replace(/<(\/?)ac:task-list(?![\w-])[^<>]*>/g, '<$1ul>')
      // A task's status and body are elements named after it, so the name must end here.
      .replace(/<(\/?)ac:task(?![\w-])[^<>]*>/g, '<$1li>')
      .replace(/<(\/?)ac:layout-cell\b[^<>]*>/g, '<$1div>')
      // Whatever storage element is left is read through: its text stays, its tag goes.
      // A tag's attributes hold no `<` (XML escapes one), so the scan for a tag's end stops at
      // the next tag: run to the next `>` instead, a body of tags never ended cost its square.
      .replace(/<\/?(?:ac|ri|at):[\w-]+(?![\w-])[^<>]*>/g, '')
  );
}

/**
 * Convert a Confluence page body in the storage format to Markdown.
 *
 * @param storage - The body as Confluence Cloud's `body-format=storage` and Data Center's
 *   `expand=body.storage` return it.
 */
export function confluenceStorageToMarkdown(storage: string): string {
  return documentHtmlToMarkdown(confluenceStorageToHtml(storage));
}

/**
 * The largest storage body the pre-pass rewrites. A page the store takes is under a mebibyte of
 * Markdown, and the rewriting scans from each element it opens, so a body past this is named
 * unread by its reader rather than converted.
 */
export const MAX_STORAGE_BYTES = 4 * 1024 * 1024;
