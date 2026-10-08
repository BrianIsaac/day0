import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The standard's 1.5: a Convex module without `'use node'` runs in Convex's own runtime and is
 * bundled for it, so it must not import a `'use node'` module, which may pull Node's built-ins
 * (Mastra's `crypto`, `node:async_hooks`) into that bundle and fail the push. The wave 14 joins
 * bed met it: `documentationWindows.ts` imported `skillAuthorPrompt.ts` and the upgrade's
 * `convex dev --once` refused every Node built-in Mastra reaches.
 */

const CONVEX = new URL('../../convex/', import.meta.url);

/** The module names in `convex/`, each with whether it declares `'use node'`. */
function modules(): Map<string, boolean> {
  return new Map(
    readdirSync(CONVEX)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
      .map((file): [string, boolean] => [
        file.slice(0, -'.ts'.length),
        /^\s*['"]use node['"];/.test(readFileSync(new URL(file, CONVEX), 'utf8')),
      ]),
  );
}

/** The sibling modules a module's text imports a value from, by name: a type-only import is erased. */
function siblingImports(text: string): string[] {
  return [...text.matchAll(/^import\s+(type\s)?[^;]*?from\s+['"]\.\/([A-Za-z0-9_]+)['"]/gm)]
    .filter((match) => match[1] === undefined)
    .map((match) => match[2]!);
}

/** A module's text by its name in `convex/`. */
function moduleText(file: string): string {
  return readFileSync(new URL(`${file}.ts`, CONVEX), 'utf8');
}

describe("the 'use node' boundary in convex/ (the standard's 1.5)", (): void => {
  it('reads a type-only import as no crossing, since the bundle erases it', (): void => {
    expect(
      siblingImports('import type { A } from \'./a\';\nimport { b, type C } from "./b";'),
    ).toEqual(['b']);
  });

  it("imports no 'use node' module from a module without the directive", (): void => {
    const all = modules();
    const crossings = [...all]
      .filter(([, node]) => !node)
      .flatMap(([file]) =>
        siblingImports(moduleText(file))
          .filter((imported) => all.get(imported) === true)
          .map((imported) => `${file} imports ${imported}`),
      );
    expect(crossings).toEqual([]);
  });
});
