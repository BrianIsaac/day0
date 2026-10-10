import { describe, expect, it } from 'vitest';
import {
  confluenceStorageToMarkdown,
  DocumentConversionError,
  documentHtmlToMarkdown,
  htmlToMarkdown,
  underTitle,
} from '../../../../src/docs/readers/html-markdown';

describe('htmlToMarkdown', (): void => {
  it('writes headings with hashes and code in fences, as the URL reader always has', (): void => {
    expect(
      htmlToMarkdown(
        '<h1>Runbook</h1><p>Do the <strong>work</strong>.</p><pre><code>pnpm test\n</code></pre>',
      ),
    ).toBe('# Runbook\n\nDo the **work**.\n\n```\npnpm test\n```');
  });

  it('leaves a table as the URL reader always has, one cell a paragraph', (): void => {
    // A stored URL page's hash covers this text, so the conversion a URL source gets must not move.
    expect(htmlToMarkdown('<table><tr><th>Step</th><th>Owner</th></tr></table>')).toBe(
      'Step\n\nOwner',
    );
  });
});

describe('documentHtmlToMarkdown', (): void => {
  it('writes a table with a header row as a pipe table', (): void => {
    expect(
      documentHtmlToMarkdown(
        '<table><tbody><tr><th>Step</th><th>Owner</th></tr>' +
          '<tr><td>Refresh the <strong>tile</strong></td><td>RevOps</td></tr></tbody></table>',
      ),
    ).toBe('| Step | Owner |\n| --- | --- |\n| Refresh the **tile** | RevOps |');
  });

  it('gives a table with no header cells an empty header row, so no data row reads as a heading', (): void => {
    expect(
      documentHtmlToMarkdown(
        '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
      ),
    ).toBe('|  |  |\n| --- | --- |\n| a | b |\n| c | d |');
  });

  it('keeps a cell on its row: a pipe is escaped and a line break becomes a space', (): void => {
    expect(
      documentHtmlToMarkdown(
        '<table><tr><th>Rule</th></tr><tr><td><p>a | b</p><p>second line</p></td></tr></table>',
      ),
    ).toBe('| Rule |\n| --- |\n| a \\| b second line |');
  });
});

describe('confluenceStorageToMarkdown', (): void => {
  it('writes a code macro as a fenced block in its language, its text untouched', (): void => {
    const storage =
      '<p>Run:</p><ac:structured-macro ac:name="code" ac:schema-version="1">' +
      '<ac:parameter ac:name="language">bash</ac:parameter>' +
      '<ac:plain-text-body><![CDATA[if [ "$A" < 3 ] && true; then\n  echo "<ok>"\nfi]]></ac:plain-text-body>' +
      '</ac:structured-macro>';
    expect(confluenceStorageToMarkdown(storage)).toBe(
      'Run:\n\n```bash\nif [ "$A" < 3 ] && true; then\n  echo "<ok>"\nfi\n```',
    );
  });

  it('reads on past a macro closed in its own tag, which an HTML parser would leave open', (): void => {
    const storage =
      '<ac:structured-macro ac:name="toc" ac:schema-version="1" />' +
      '<h1>Close the quarter</h1><p>First, <ac:emoticon ac:name="tick" /> lock the books.</p>';
    expect(confluenceStorageToMarkdown(storage)).toBe(
      '# Close the quarter\n\nFirst, lock the books.',
    );
  });

  it('writes an information panel as a quotation under its kind and title', (): void => {
    const storage =
      '<ac:structured-macro ac:name="warning"><ac:parameter ac:name="title">Before you start</ac:parameter>' +
      '<ac:rich-text-body><p>Tell <em>finance</em> first.</p></ac:rich-text-body></ac:structured-macro>';
    expect(confluenceStorageToMarkdown(storage)).toBe(
      '> **Warning: Before you start**\n> \n> Tell _finance_ first.',
    );
  });

  it('keeps what a macro inside another macro holds', (): void => {
    const storage =
      '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Details</ac:parameter>' +
      '<ac:rich-text-body><p>Then:</p><ac:structured-macro ac:name="noformat">' +
      '<ac:plain-text-body><![CDATA[a   b]]></ac:plain-text-body></ac:structured-macro>' +
      '</ac:rich-text-body></ac:structured-macro>';
    expect(confluenceStorageToMarkdown(storage)).toBe('**Details**\n\nThen:\n\n```\na   b\n```');
  });

  it('writes a link to another page as its words, or the page title when it has none', (): void => {
    const storage =
      '<p>See <ac:link><ri:page ri:content-title="Escalation paths" ri:space-key="OPS" />' +
      '<ac:plain-text-link-body><![CDATA[who to call]]></ac:plain-text-link-body></ac:link> and ' +
      '<ac:link><ri:page ri:content-title="Month end &amp; close" /></ac:link>.</p>';
    expect(confluenceStorageToMarkdown(storage)).toBe('See who to call and Month end & close.');
  });

  it('writes a task list as a checklist', (): void => {
    const storage =
      '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status>' +
      '<ac:task-body>Export the ledger</ac:task-body></ac:task>' +
      '<ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status>' +
      '<ac:task-body>Send it to <strong>audit</strong></ac:task-body></ac:task></ac:task-list>';
    expect(confluenceStorageToMarkdown(storage)).toBe(
      '*   [x] Export the ledger\n*   [ ] Send it to **audit**',
    );
  });

  it('reads through a page layout, and writes a date, a status and a table', (): void => {
    const storage =
      '<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell><p>Due <time datetime="2026-10-31" />.</p>' +
      '</ac:layout-cell><ac:layout-cell><p>State: <ac:structured-macro ac:name="status">' +
      '<ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">DONE</ac:parameter>' +
      '</ac:structured-macro></p><table><tbody><tr><th>Key</th></tr><tr><td>OPS-1</td></tr></tbody></table>' +
      '</ac:layout-cell></ac:layout-section></ac:layout>';
    expect(confluenceStorageToMarkdown(storage)).toBe(
      'Due 2026-10-31.\n\nState: DONE\n\n| Key |\n| --- |\n| OPS-1 |',
    );
  });

  it('drops template instructions and names an attached image by its file', (): void => {
    const storage =
      '<p><ac:placeholder>Type the owner here</ac:placeholder>Owner: Mira</p>' +
      '<p><ac:image ac:alt="The tile"><ri:attachment ri:filename="tile.png" /></ac:image></p>' +
      '<p><ac:image><ri:url ri:value="https://example.com/a.png" /></ac:image></p>';
    expect(confluenceStorageToMarkdown(storage)).toBe(
      'Owner: Mira\n\n(image: tile.png)\n\n![](https://example.com/a.png)',
    );
  });

  it("drops a task's uuid, and reads a new-editor panel once, by its content (second pass)", (): void => {
    const task =
      '<ac:task-list><ac:task><ac:task-id>1</ac:task-id>' +
      '<ac:task-uuid>7d8e1c2a-0000-4000-8000-123456789abc</ac:task-uuid>' +
      '<ac:task-status>incomplete</ac:task-status><ac:task-body>Do it</ac:task-body></ac:task></ac:task-list>';
    expect(confluenceStorageToMarkdown(task)).toBe('*   [ ] Do it');
    const panel =
      '<ac:adf-extension><ac:adf-node type="panel"><ac:adf-attribute key="panel-type">note</ac:adf-attribute>' +
      '<ac:adf-content><p>Escalate within 1 hour</p></ac:adf-content></ac:adf-node>' +
      '<ac:adf-fallback><div class="panel"><p>Escalate within 1 hour</p></div></ac:adf-fallback></ac:adf-extension>';
    expect(confluenceStorageToMarkdown(panel)).toBe('Escalate within 1 hour');
  });

  it('writes an issue macro as its key, and never reads a macro name as a property of the table it looks names up in (second pass)', (): void => {
    expect(
      confluenceStorageToMarkdown(
        '<p>See <ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">OPS-12</ac:parameter></ac:structured-macro> now</p>',
      ),
    ).toBe('See OPS-12 now');
    expect(
      confluenceStorageToMarkdown(
        '<ac:structured-macro ac:name="constructor"><ac:rich-text-body><p>Body</p></ac:rich-text-body></ac:structured-macro>',
      ),
    ).toBe('Body');
  });

  it('rewrites a tag padded with a hundred thousand spaces in well under a second (second pass)', (): void => {
    const padded = `<p>Before</p><ac:emoticon ac:name="tick"${' '.repeat(100_000)}x<p>After</p>`;
    const started = performance.now();
    expect(confluenceStorageToMarkdown(padded)).toContain('Before');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('leaves no storage tag in the Markdown, whatever macro it does not know', (): void => {
    const storage =
      '<ac:structured-macro ac:name="children" /><ac:structured-macro ac:name="made-up">' +
      '<ac:parameter ac:name="x">1</ac:parameter><ac:rich-text-body><p>Kept text.</p></ac:rich-text-body>' +
      '</ac:structured-macro><at:var at:name="x" /><p>End.</p>';
    const markdown = confluenceStorageToMarkdown(storage);
    expect(markdown).toBe('Kept text.\n\nEnd.');
    expect(markdown).not.toMatch(/ac:|ri:|at:|CDATA/);
  });
});

describe('underTitle', (): void => {
  it("puts a page's own title first, so a section heading never names the page", (): void => {
    expect(underTitle('Close the quarter', '# Overview\n\nLock the books.')).toBe(
      '# Close the quarter\n\n# Overview\n\nLock the books.',
    );
  });

  it('leaves a body that already opens with its title, and titles an empty page', (): void => {
    expect(underTitle('Close the quarter', '# Close the quarter\n\nLock the books.')).toBe(
      '# Close the quarter\n\nLock the books.',
    );
    expect(underTitle('  Runbook\n index ', '')).toBe('# Runbook index');
  });
});

describe('what the document conversion refuses', (): void => {
  it('refuses a document nested deeper than it can convert, in words a reader puts after its title (W15-R9)', (): void => {
    // The review's four shapes (reader 3's deep.mts): each overflowed the converter's stack.
    for (const [tag, depth] of [
      ['div', 2_000],
      ['ul><li', 2_000],
      ['blockquote', 3_000],
      ['table><tr><td', 1_500],
    ] as const) {
      const names = tag.split('><');
      const nested =
        names
          .map((name) => `<${name}>`)
          .join('')
          .repeat(depth) +
        'x' +
        [...names]
          .reverse()
          .map((name) => `</${name}>`)
          .join('')
          .repeat(depth);
      for (const convert of [documentHtmlToMarkdown, confluenceStorageToMarkdown]) {
        expect(() => convert(nested), `${tag} x ${depth}`).toThrow(DocumentConversionError);
        expect(() => convert(nested), `${tag} x ${depth}`).toThrow(
          'it is laid out too deeply for Day0 to convert: lists, tables or quotations inside one another, many levels down',
        );
      }
    }
    // An ordinary depth still converts.
    expect(documentHtmlToMarkdown(`${'<div>'.repeat(100)}x${'</div>'.repeat(100)}`)).toBe('x');
  });

  it('refuses a document of more elements than it converts in the time a batch has, before converting any (W15-R9)', (): void => {
    const started = performance.now();
    expect(() => documentHtmlToMarkdown('<br/>'.repeat(200_000))).toThrow(
      'it holds more than the 20,000 paragraphs, list items and table cells Day0 converts of one page',
    );
    // The review measured 35 s for this input; the refusal reads it once.
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(documentHtmlToMarkdown('<p>Step.</p>'.repeat(2_000))).toContain('Step.');
  });

  it('refuses a document past the size it converts', (): void => {
    expect(() => documentHtmlToMarkdown(`<p>${'x'.repeat(4 * 1024 * 1024)}</p>`)).toThrow(
      'it is larger than the 4 MiB Day0 converts of one page',
    );
  });
});
