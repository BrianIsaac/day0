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
 * Convert a document's HTML to Markdown, with its tables as pipe tables and its checkboxes as a
 * checklist.
 *
 * @param html - A document's HTML: a SharePoint page's web parts, a Yuque body, a converted Word
 *   document, or Confluence storage after its pre-pass.
 */
export function documentHtmlToMarkdown(html: string): string {
  return documentService().turndown(html);
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

/** A macro's parameters by name, each value as the XML wrote it. */
function macroParameters(inner: string): Map<string, string> {
  const parameters = new Map<string, string>();
  const pattern = /<ac:parameter\b([^>]*)>([\s\S]*?)<\/ac:parameter>/g;
  for (let match = pattern.exec(inner); match !== null; match = pattern.exec(inner)) {
    parameters.set(attribute(match[1], 'ac:name') ?? '', match[2].trim());
  }
  return parameters;
}

/** The contents of a macro's body element, or undefined when it has none. */
function macroBody(inner: string, element: string): string | undefined {
  return new RegExp(`<ac:${element}\\b[^>]*>([\\s\\S]*)<\\/ac:${element}>`).exec(inner)?.[1];
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
  if (rich === undefined) return '';
  const panel = PANEL_NAMES[name];
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
  /<ac:(structured-macro|macro)\b([^>]*)>((?:(?!<ac:(?:structured-)?macro\b)[\s\S])*?)<\/ac:\1>/g;

/** A link to a page, an attachment or a space: its words, or what it points to when it has none. */
function linkHtml(inner: string): string {
  const body =
    /<ac:(?:plain-text-link-body|link-body)\b[^>]*>([\s\S]*?)<\/ac:(?:plain-text-link-body|link-body)>/.exec(
      inner,
    )?.[1];
  if (body !== undefined && body.trim() !== '') return body.trim();
  const target = /<ri:[\w-]+\b[^>]*>/.exec(inner)?.[0] ?? '';
  return (
    attribute(target, 'ri:content-title') ??
    attribute(target, 'ri:filename') ??
    attribute(target, 'ri:space-key') ??
    ''
  );
}

/** An image: a picture at an address stays one; an attached file is named, since day0 reads text. */
function imageHtml(tag: string, inner: string): string {
  const url = attribute(/<ri:url\b[^>]*>/.exec(inner)?.[0] ?? '', 'ri:value');
  if (url !== undefined) return `<img src="${url}" alt="${attribute(tag, 'ac:alt') ?? ''}">`;
  const file = attribute(/<ri:attachment\b[^>]*>/.exec(inner)?.[0] ?? '', 'ri:filename');
  return file === undefined ? '' : `(image: ${file})`;
}

/**
 * Rewrite Confluence's storage format as plain HTML.
 *
 * @param storage - A page body in the storage format (`body.storage.value`).
 * @returns HTML with no `ac:`, `ri:` or `at:` element and no CDATA section.
 */
export function confluenceStorageToHtml(storage: string): string {
  let html = storage
    // A CDATA section is text as typed; Confluence splits one that holds `]]>` into two.
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_all, text: string): string => escapeHtml(text))
    // XML closes an empty element in its own tag, which HTML reads as left open.
    .replace(/<((?:ac|ri|at):[\w-]+|time)\b([^<>]*?)\s*\/>/g, '<$1$2></$1>')
    .replace(/<ac:(emoticon|placeholder|task-id)\b[^>]*>[\s\S]*?<\/ac:\1>/g, '')
    .replace(
      /<time\b([^>]*)>\s*<\/time>/g,
      (_all, tag: string): string => attribute(tag, 'datetime') ?? '',
    )
    .replace(/<ac:image\b([^>]*)>([\s\S]*?)<\/ac:image>/g, (_all, tag: string, inner: string) =>
      imageHtml(tag, inner),
    )
    .replace(/<ac:link\b[^>]*>([\s\S]*?)<\/ac:link>/g, (_all, inner: string) => linkHtml(inner));
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
        /<ac:task-status\b[^>]*>\s*(\w+)\s*<\/ac:task-status>/g,
        (_all, status: string): string =>
          `<input type="checkbox"${status === 'complete' ? ' checked' : ''}>`,
      )
      .replace(/<(\/?)ac:task-list(?![\w-])[^>]*>/g, '<$1ul>')
      // A task's status and body are elements named after it, so the name must end here.
      .replace(/<(\/?)ac:task(?![\w-])[^>]*>/g, '<$1li>')
      .replace(/<(\/?)ac:layout-cell\b[^>]*>/g, '<$1div>')
      // Whatever storage element is left is read through: its text stays, its tag goes.
      .replace(/<\/?(?:ac|ri|at):[\w-]+\b[^>]*>/g, '')
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
