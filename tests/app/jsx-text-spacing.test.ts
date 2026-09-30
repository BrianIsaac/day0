import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/*
 * The production build's JSX compiler (Next's SWC) drops the leading space of a JSX text that
 * holds an HTML entity and runs over a line break: "In the hosted office {agent.name} reads the
 * office&apos;s wiki ... on" + a new line compiled to "Adareads the office's wiki" (the hosted
 * walk's m3, 30 September). Vitest compiles JSX with another transform, so a rendered-text test
 * alone passes either way; this walks every component under `app/` for the shape instead, and
 * proves the shape against the compiler the build uses.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Named entities may carry digits (`&frac12;`, `&sup2;`), as numeric ones do (the second
// review's x10: the scan missed them).
const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);/;

/** Every `.tsx` file under a directory. */
function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

/**
 * Where a JSX text starts with a space, holds an entity and runs over a line break: the text the
 * build compiles without its leading space.
 *
 * @param name - The file's name, as each finding reports it.
 * @param text - The component's source.
 * @returns `name:line` of each such text.
 */
function spaceDroppingTextsIn(name: string, text: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const raw = node.getFullText();
      if (/^[ \t]+\S/.test(raw) && raw.includes('\n') && ENTITY.test(raw)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${name}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The texts of one component file the build would compile without their leading space. */
function spaceDroppingTexts(path: string): string[] {
  return spaceDroppingTextsIn(relative(root, path), readFileSync(path, 'utf8'));
}

describe('JSX text the production compiler would run into the word before it', () => {
  it('leaves no text under app/ that starts with a space, holds an entity and wraps (walk m3)', () => {
    expect(componentFiles(join(root, 'app')).flatMap(spaceDroppingTexts)).toEqual([]);
  });

  it('flags every shape the build compiler drops a space in, whether or not a later compiler still does', async () => {
    const require = createRequire(join(root, 'package.json'));
    const swc = require('next/dist/build/swc/index.js') as {
      loadBindings: () => Promise<unknown>;
      transform: (source: string, options: object) => Promise<{ code: string }>;
    };
    await swc.loadBindings();
    const component = (jsx: string): string => `export const X = ({ n }) => ${jsx};`;
    // Whether the compiled text after `{n}` lost the space the source put before "reads".
    const dropsSpace = async (jsx: string): Promise<boolean> =>
      !(
        await swc.transform(component(jsx), {
          filename: 'x.tsx',
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic' } },
            target: 'es2022',
          },
        })
      ).code.includes('" reads');
    const shapes = [
      '<p>a {n} reads the office&apos;s\n  wiki</p>',
      '<p>a {n} reads the office&#39;s\n  wiki</p>',
      '<p>a {n} reads the office&#x27;s\n  wiki</p>',
      '<p>a {n} reads half&frac12;\n  of the wiki</p>',
      "<p>a {n} reads the office's\n  wiki</p>",
      '<p>a {n} reads the office&apos;s wiki</p>',
    ];
    for (const jsx of shapes) {
      // A shape the compiler drops a space in is one the scan flags; a shape the scan flags that a
      // later compiler keeps whole is only a stricter scan, never a red gate.
      if (await dropsSpace(jsx))
        expect(spaceDroppingTextsIn('x.tsx', component(jsx)), jsx).not.toEqual([]);
    }
    // The shapes with no entity, or on one line, are left alone.
    expect(spaceDroppingTextsIn('x.tsx', component(shapes[4]!))).toEqual([]);
    expect(spaceDroppingTextsIn('x.tsx', component(shapes[5]!))).toEqual([]);
  });
});
