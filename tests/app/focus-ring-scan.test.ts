import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/*
 * The focus ring lives in the base layer (`app/globals.css`), so any utility class wins over it:
 * one `outline-none` on a control a keyboard reaches removes its ring with nothing to say so (the
 * second review's w1). The only element that may carry one is a focus target a script moves focus
 * to, which the Tab key never reaches and the ring's selector never matched: `tabIndex={-1}`, or a
 * `tabIndex` that is -1 or absent.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A Tailwind utility that takes the outline away, with any variant in front of it. */
const REMOVES_OUTLINE =
  /(?:^|[\s"'`])(?:[\w-]+:)*(?:outline-none|outline-hidden|outline-0)(?=[\s"'`]|$)/;

/** An inline style that takes the outline away. */
const STYLE_REMOVES_OUTLINE = /\boutline\s*:\s*(?:'none'|"none"|0\b|'0')/;

/** A `tabIndex` that keeps the element out of the Tab order: -1, or -1 when not left out. */
const SCRIPT_FOCUS_ONLY =
  /^\{\s*(?:-1|[^{}?]*\?\s*-1\s*:\s*undefined|[^{}?]*\?\s*undefined\s*:\s*-1)\s*\}$/;

/** Every `.tsx` file under a directory. */
function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/**
 * Each element that takes its outline away without being a script-only focus target.
 *
 * @param name - The file's name, as the finding reports it.
 * @param text - The component's source.
 * @returns `file:line <tag>` of each such element.
 */
export function outlinesRemoved(name: string, text: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = new Map(
        node.attributes.properties.flatMap((property) =>
          ts.isJsxAttribute(property)
            ? [[property.name.getText(source), property.initializer?.getText(source) ?? '']]
            : [],
        ),
      );
      const removes =
        REMOVES_OUTLINE.test(attributes.get('className') ?? '') ||
        STYLE_REMOVES_OUTLINE.test(attributes.get('style') ?? '');
      if (removes && !SCRIPT_FOCUS_ONLY.test(attributes.get('tabIndex') ?? '')) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push(`${name}:${line + 1} <${node.tagName.getText(source)}>`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the focus ring under the utilities', (): void => {
  it('is removed by no utility under app/ except on a script-only focus target (second review w1)', (): void => {
    const found = componentFiles(join(root, 'app')).flatMap((path) =>
      outlinesRemoved(relative(root, path), readFileSync(path, 'utf8')),
    );
    expect(found).toEqual([]);
  });

  it('finds a control whose ring a utility removes, whichever way it is written', (): void => {
    const source = [
      'export function Controls({ open }: { open: boolean }) {',
      '  return (',
      '    <>',
      '      <button className="px-2 focus:outline-none">Save</button>',
      "      <a href=\"/x\" className={`link ${open ? 'outline-hidden' : ''}`}>Go</a>",
      "      <input style={{ outline: 'none' }} />",
      '      <div tabIndex={0} className="outline-0" />',
      '      <h1 tabIndex={-1} className="outline-none">Moved here</h1>',
      '      <p tabIndex={open ? -1 : undefined} className="outline-none">Said</p>',
      '      <button className="outline-2 outline-offset-2">Kept</button>',
      '    </>',
      '  );',
      '}',
    ].join('\n');
    expect(outlinesRemoved('Controls.tsx', source)).toEqual([
      'Controls.tsx:4 <button>',
      'Controls.tsx:5 <a>',
      'Controls.tsx:6 <input>',
      'Controls.tsx:7 <div>',
    ]);
  });
});
