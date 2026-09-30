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
const ENTITY = /&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/;

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
 * @param path - The component file.
 * @returns `file:line` of each such text.
 */
function spaceDroppingTexts(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      const raw = node.getFullText();
      if (/^[ \t]+\S/.test(raw) && raw.includes('\n') && ENTITY.test(raw)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(`${relative(root, path)}:${line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('JSX text the production compiler would run into the word before it', () => {
  it('leaves no text under app/ that starts with a space, holds an entity and wraps (walk m3)', () => {
    expect(componentFiles(join(root, 'app')).flatMap(spaceDroppingTexts)).toEqual([]);
  });

  it('matches what the build compiler does: the space goes only when an entity and a line break meet', async () => {
    const require = createRequire(join(root, 'package.json'));
    const swc = require('next/dist/build/swc/index.js') as {
      loadBindings: () => Promise<unknown>;
      transform: (source: string, options: object) => Promise<{ code: string }>;
    };
    await swc.loadBindings();
    const compiled = async (jsx: string): Promise<string> =>
      (
        await swc.transform(`export const X = ({ n }) => ${jsx};`, {
          filename: 'x.tsx',
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic' } },
            target: 'es2022',
          },
        })
      ).code;

    expect(await compiled('<p>a {n} reads the office&apos;s\n  wiki</p>')).toContain('"reads');
    expect(await compiled("<p>a {n} reads the office's\n  wiki</p>")).toContain('" reads');
    expect(await compiled('<p>a {n} reads the office&apos;s wiki</p>')).toContain('" reads');
  });
});
